import { fetchSegmentedStats, MAX_SEGMENTED_DAYS, StatsJobError } from "@/lib/x/async-stats";
import type { XCredentials } from "@/lib/store";
import type { Actor } from "../auth/actor";

/**
 * Who a campaign actually reached, by age band and by gender.
 *
 * X infers both; neither is declared by the advertiser, and neither is a targeting setting read back
 * — this is who the delivery landed on. Both come from the asynchronous jobs endpoint, one job per
 * dimension because the API rejects more than one `segmentation_type` per job, so they share the
 * 45-day ceiling that applies to all segmented data.
 */
export type AudienceBand = {
  /** Display label, e.g. "25–34". */
  label: string;
  /** Raw value from the API, e.g. "25 to 34". */
  key: string;
  impressions: number;
  spend: number;
  clicks: number;
  /** Share of the campaign's total impressions, not of the reported bands. */
  share: number;
  ctr: number;
  /**
   * True for a band the API did not return, derived as the remainder against the unsegmented total.
   * Gender has one: X reports Male and Female and leaves whoever it could not classify out entirely.
   */
  derived?: boolean;
};

export type AudienceBreakdown = {
  status: "ok" | "unavailable";
  age: AudienceBand[];
  gender: AudienceBand[];
  notes: string[];
  reason?: string;
};

/**
 * Canonical order, so the chart reads youngest to oldest rather than largest to smallest. Bands with
 * no delivery are absent from the response entirely — a campaign targeting adults returns no 13–17
 * row at all — so the order cannot be recovered from the data.
 */
const AGE_BANDS = [
  "13 to 17",
  "18 to 24",
  "25 to 34",
  "35 to 44",
  "45 to 54",
  "55 to 64",
  "over 65",
];

const AGE_LABELS: Record<string, string> = {
  "13 to 17": "13–17",
  "18 to 24": "18–24",
  "25 to 34": "25–34",
  "35 to 44": "35–44",
  "45 to 54": "45–54",
  "55 to 64": "55–64",
  "over 65": "65+",
};

const GENDER_ORDER = ["Male", "Female", "Unknown"];

/** Age reconciles exactly in practice; gender runs about 0.06% short. Only flag a real gap. */
const UNREPORTED_TOLERANCE = 0.005;

const first = (value: unknown): number => (Array.isArray(value) ? Number(value[0]) || 0 : 0);

type Options = {
  credentials: XCredentials;
  accountId: string;
  asUser: string | null;
  campaignId: string;
  startTime: string;
  endTime: string;
  days: number;
  /** Unsegmented impressions for the window, the denominator for every share. */
  reportedImpressions: number | null;
  takeover: boolean;
  actor: Actor;
};

export async function buildAudience(options: Options): Promise<AudienceBreakdown> {
  const empty = { age: [], gender: [], notes: [] };

  if (options.days > MAX_SEGMENTED_DAYS) {
    return {
      ...empty,
      status: "unavailable",
      reason: `Audience data is only available for ${MAX_SEGMENTED_DAYS} days at a time, and this range is ${options.days}.`,
    };
  }

  const [age, gender] = await Promise.all([
    bandsFor(options, "AGE"),
    bandsFor(options, "GENDER"),
  ]);

  if (!age && !gender) {
    return {
      ...empty,
      status: "unavailable",
      reason: "The audience breakdown could not be loaded for this range.",
    };
  }

  const notes: string[] = [];

  /**
   * Gender is the dimension that does not add up, and the gap is the point rather than a defect: X
   * reports Male and Female only. The remainder is carried as an explicit Unknown band so the two
   * shares are not quietly normalised to 100%, which would overstate both.
   */
  const unknown = gender?.unreported ?? 0;
  const genderBands = gender?.bands ?? [];
  if (gender && unknown > 0) {
    genderBands.push({
      label: "Unknown",
      key: "unknown",
      impressions: unknown,
      spend: 0,
      clicks: 0,
      share: gender.denominator > 0 ? unknown / gender.denominator : 0,
      ctr: 0,
      derived: true,
    });
  }

  if (age && age.unreported / Math.max(age.denominator, 1) > UNREPORTED_TOLERANCE) {
    notes.push(
      `Age bands account for ${((1 - age.unreported / age.denominator) * 100).toFixed(1)}% of ` +
        `impressions; X could not classify the rest, so read the shares rather than the totals.`,
    );
  }

  return {
    status: "ok",
    age: age?.bands ?? [],
    gender: sortBands(genderBands, GENDER_ORDER),
    notes,
  };
}

async function bandsFor(
  options: Options,
  dimension: "AGE" | "GENDER",
): Promise<{ bands: AudienceBand[]; denominator: number; unreported: number } | null> {
  let raw;
  try {
    raw = await fetchSegmentedStats({
      credentials: options.credentials,
      accountId: options.accountId,
      asUser: options.asUser,
      entity: "CAMPAIGN",
      entityIds: [options.campaignId],
      startTime: options.startTime,
      endTime: options.endTime,
      metricGroups: "ENGAGEMENT,BILLING",
      segmentationType: dimension,
      actor: options.actor,
    });
  } catch (error) {
    // One dimension failing should not take the other down with it.
    if (error instanceof StatsJobError) return null;
    throw error;
  }

  const reported = raw
    .filter((row) => row.segment)
    .map((row) => ({
      key: row.segment!,
      impressions: first(row.metrics.impressions),
      spend: first(row.metrics.billed_charge_local_micro) / 1_000_000,
      clicks: first(row.metrics.clicks),
    }))
    .filter((row) => row.impressions > 0);

  if (reported.length === 0) return null;

  const reportedImpressions = reported.reduce((total, row) => total + row.impressions, 0);
  /**
   * Shares are taken against the campaign's own total rather than the sum of the bands, so a
   * dimension that does not fully account for delivery cannot inflate itself to 100%.
   */
  const denominator = options.reportedImpressions ?? reportedImpressions;

  const bands: AudienceBand[] = reported.map((row) => ({
    label: dimension === "AGE" ? (AGE_LABELS[row.key] ?? row.key) : row.key,
    key: row.key,
    impressions: row.impressions,
    spend: row.spend,
    clicks: row.clicks,
    share: denominator > 0 ? row.impressions / denominator : 0,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
  }));

  return {
    bands: dimension === "AGE" ? sortBands(bands, AGE_BANDS) : bands,
    denominator,
    unreported: Math.max(denominator - reportedImpressions, 0),
  };
}

/** Orders by a canonical list, with anything unrecognised kept at the end rather than dropped. */
function sortBands(bands: AudienceBand[], order: string[]): AudienceBand[] {
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };
  return [...bands].sort(
    (a, b) => rank(a.key) - rank(b.key) || b.impressions - a.impressions,
  );
}
