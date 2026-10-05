import { gunzipSync } from "node:zlib";

import { adsRequest, AdsApiError } from "./ads-client";
import type { XCredentials } from "../store";
import { DEMO_JOB_SCHEME, demoStatsJobFile } from "../demo/api";
import { isDemoMode } from "../demo/mode";
import type { Actor } from "../auth/actor";

/**
 * The asynchronous analytics endpoints, used here for two things the sync endpoint cannot do.
 *
 * Segmentation is the first: the sync endpoint accepts `segmentation_type` and silently ignores it,
 * echoing back `null` and returning one unsegmented row, so a breakdown by platform, age, gender or
 * region can only be obtained by creating a job, polling it, and downloading a gzipped result.
 *
 * Reach is the second: a sync request covers 7 days, an unsegmented job covers 90. Fetching a year
 * of history synchronously would be 52 windows per batch of 20 campaigns, which on a large account
 * is enough requests to exhaust the 250-per-15-minutes user limit. The same year is 5 jobs.
 *
 * Three limits are lower than the sync endpoint's and shape everything here: a segmented job spans
 * at most 45 days, only one dimension can be requested per job, and jobs are capped per account
 * rather than per user.
 */

/** Segmented jobs are capped at 45 days, against 90 for unsegmented ones. */
export const MAX_SEGMENTED_DAYS = 45;

/** An unsegmented job's maximum span, and the whole reason the lookback uses jobs at all. */
export const MAX_ASYNC_DAYS = 90;

/** As of September 2026 these are the only segmentation types the API enables. */
export const SEGMENTATION_TYPES = ["PLATFORMS", "GENDER", "AGE", "REGIONS", "METROS"] as const;

export type SegmentationType = (typeof SEGMENTATION_TYPES)[number];

/** `REGIONS` and `METROS` are geographic and will not run without a country. */
export const COUNTRY_REQUIRED: SegmentationType[] = ["REGIONS", "METROS"];

/** Targeting location id for the United States, the default for geographic breakdowns. */
export const US_COUNTRY_ID = "96683cc9126741d1";

type JobStatus = "PROCESSING" | "SUCCESS" | "FAILED" | "UPLOADING";

type Job = {
  /** The live API returns `id` only, though the docs show both. Read whichever is present. */
  id?: string | number;
  id_str?: string;
  status: JobStatus;
  url: string | null;
  segmentation_type: string | null;
  expires_at: string | null;
};

const jobIdOf = (job: Job | undefined): string | null => {
  const id = job?.id_str ?? job?.id;
  return id == null ? null : String(id);
};

export class StatsJobError extends Error {}

/**
 * A job usually completes in a few seconds, but it is a queue and can be slower under load. The
 * budget is bounded because this runs inside a request a rep is waiting on: better to say "still
 * processing, try again" than to hold a connection open indefinitely.
 */
const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_MS = 45_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type SegmentedRow = {
  /** Entity the row belongs to. */
  entityId: string;
  /** Human label for the segment, e.g. "iOS". Null on the unsegmented roll-up row. */
  segment: string | null;
  metrics: Record<string, unknown>;
};

type StatsFile = {
  data?: Array<{
    id: string;
    id_data?: Array<{
      /** A plain string in practice — "ios", "android", "other" — not the object the docs imply. */
      segment?: string | Record<string, unknown> | null;
      metrics?: Record<string, unknown>;
    }>;
  }>;
};

type JobOptions = {
  credentials: XCredentials;
  accountId: string;
  asUser: string | null;
  entity: "CAMPAIGN" | "LINE_ITEM" | "PROMOTED_TWEET";
  entityIds: string[];
  /** Whole-hour ISO timestamps; end is exclusive. */
  startTime: string;
  endTime: string;
  metricGroups: string;
  /** Null for a plain total per entity, which is how the longer windows are reached. */
  segmentationType: SegmentationType | null;
  country?: string | null;
  actor: Actor;
};

export async function fetchSegmentedStats(
  options: JobOptions & { segmentationType: SegmentationType },
): Promise<SegmentedRow[]> {
  return runStatsJob(options);
}

/**
 * One total per entity over a span of up to 90 days, with no segmentation.
 *
 * Returned as metrics rather than parsed numbers so the caller can reuse the same series parsing
 * the synchronous path uses, instead of this module growing a second opinion about what counts as
 * an install.
 */
export async function fetchEntityTotals(
  options: Omit<JobOptions, "segmentationType" | "country">,
): Promise<Map<string, Record<string, unknown>>> {
  const rows = await runStatsJob({ ...options, segmentationType: null });
  const totals = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    // Unsegmented, so there is exactly one row per entity and nothing to merge.
    if (!totals.has(row.entityId)) totals.set(row.entityId, row.metrics);
  }
  return totals;
}

async function runStatsJob(options: JobOptions): Promise<SegmentedRow[]> {
  const {
    credentials,
    accountId,
    asUser,
    entity,
    entityIds,
    startTime,
    endTime,
    metricGroups,
    segmentationType,
    actor,
  } = options;

  if (entityIds.length === 0) return [];

  const audit = { actor, accountId };
  const geographic = segmentationType != null && COUNTRY_REQUIRED.includes(segmentationType);
  const country = options.country ?? (geographic ? US_COUNTRY_ID : null);

  if (geographic && !country) {
    throw new StatsJobError(`${segmentationType} requires a country.`);
  }

  const created = await adsRequest<{ data?: Job }>({
    method: "POST",
    path: `/stats/jobs/accounts/${accountId}`,
    credentials,
    asUser,
    audit,
    query: {
      entity,
      entity_ids: entityIds.join(","),
      start_time: startTime,
      end_time: endTime,
      // TOTAL rather than DAY: a breakdown answers "which platform is cheaper", not "on which day",
      // and daily segmented data multiplies the payload without being shown anywhere.
      granularity: "TOTAL",
      placement: "ALL_ON_TWITTER",
      metric_groups: metricGroups,
      segmentation_type: segmentationType,
      country,
    },
  });

  const jobId = jobIdOf(created.data);
  if (!jobId) throw new StatsJobError("The Ads API did not return a job id.");

  const deadline = Date.now() + MAX_POLL_MS;
  let job: Job | undefined;

  while (Date.now() < deadline) {
    // A demo job is finished the moment it is created, and the lookback runs these sequentially —
    // waiting a poll interval per job would add half a minute to a page load for nothing.
    if (!isDemoMode()) await sleep(POLL_INTERVAL_MS);
    const polled = await adsRequest<{ data?: Job[] }>({
      path: `/stats/jobs/accounts/${accountId}`,
      credentials,
      asUser,
      audit,
      query: { job_ids: jobId },
    });
    job = polled.data?.find((entry) => jobIdOf(entry) === jobId);
    if (!job) throw new StatsJobError("The job disappeared before it finished.");
    if (job.status === "FAILED") throw new StatsJobError("The Ads API failed to build this breakdown.");
    if (job.status === "SUCCESS" && job.url) break;
  }

  if (!job || job.status !== "SUCCESS" || !job.url) {
    throw new StatsJobError(
      "The breakdown is still being built by the X Ads API. Try again in a moment.",
    );
  }

  const parsed = job.url.startsWith(DEMO_JOB_SCHEME)
    ? (demoStatsJobFile(job.url.slice(DEMO_JOB_SCHEME.length)) as StatsFile)
    : await downloadStatsFile(job.url, asUser);

  const rows: SegmentedRow[] = [];
  for (const entry of parsed.data ?? []) {
    for (const bucket of entry.id_data ?? []) {
      rows.push({
        entityId: entry.id,
        segment: segmentLabel(bucket.segment),
        metrics: bucket.metrics ?? {},
      });
    }
  }
  return rows;
}

async function downloadStatsFile(url: string, asUser: string | null): Promise<StatsFile> {
  // The results URL is pre-signed and served from a CDN, so it takes no OAuth header — but it is a
  // gzip file rather than a gzip-encoded response, so fetch will not decompress it for us.
  const download = await fetch(url, { cache: "no-store" });
  if (!download.ok) {
    throw new AdsApiError({
      status: download.status,
      body: "Could not download the results file.",
      path: url,
      asUser,
    });
  }

  const raw = Buffer.from(await download.arrayBuffer());
  const text = isGzip(raw) ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text) as StatsFile;
}

const isGzip = (buffer: Buffer) => buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

/**
 * PLATFORMS returns the segment as a bare string. The other dimensions are undocumented, so an
 * object is read from whichever plausible key is present and anything else falls back to raw JSON —
 * an unexpected shape should surface as something a human can read rather than "undefined".
 */
function segmentLabel(segment: string | Record<string, unknown> | null | undefined): string | null {
  if (!segment) return null;
  if (typeof segment === "string") return segment.trim() || null;
  for (const key of ["segment_name", "segment_value", "name", "value"]) {
    const value = segment[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return JSON.stringify(segment);
}
