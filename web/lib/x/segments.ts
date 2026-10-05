import { fetchSegmentedStats, MAX_SEGMENTED_DAYS, StatsJobError } from "@/lib/x/async-stats";
import { emptySeries, totalsFrom, type MetricSeries, type Totals } from "@/lib/x/stats";
import type { XCredentials } from "@/lib/store";

/**
 * A breakdown of one campaign by platform.
 *
 * Segmented stats come only from the asynchronous jobs endpoint, which caps segmented queries at
 * 45 days and takes seconds rather than milliseconds, so this is loaded on demand from the drawer
 * rather than with the dashboard.
 */
export type SegmentRow = {
  /** Display label, e.g. "iOS". */
  label: string;
  /** Raw value from the API, e.g. "ios". */
  key: string;
  totals: Totals;
  /** Share of the campaign's segmented spend. */
  spendShare: number;
};

/**
 * The widest efficiency gap between two platforms that each carry enough spend to mean something.
 * Pre-computed so the panel and any AI narrative read the same verdict, rather than each deciding
 * for itself which platform is "winning".
 */
export type SegmentEfficiency = {
  /** The metric compared: cost per view for video, otherwise cost per thousand impressions. */
  metric: "cpv" | "cpm";
  label: string;
  cheapest: { label: string; value: number; spendShare: number };
  dearest: { label: string; value: number; spendShare: number };
  /** How much more the dearest costs, as a fraction of the cheapest. */
  gap: number;
  /**
   * Whether the gap is wide enough to act on. Platforms within a few percent of each other are a
   * normal auction, not a finding, and calling one of them "cheapest" invites a rep to move budget
   * on noise.
   */
  material: boolean;
};

/**
 * How much of the campaign served in the Spotlight surface, which is a slice of the headline total
 * rather than an addition to it. Kept apart from the platform rows because it is a different
 * question — what the ad appeared next to, rather than what device it appeared on — and because it
 * comes from the synchronous endpoint.
 */
export type SpotlightSplit = {
  spend: number;
  impressions: number;
  cpm: number;
  /** Share of the campaign's total spend. */
  spendShare: number;
  /** The same figures for everything that did not serve in Spotlight, by subtraction. */
  rest: { spend: number; impressions: number; cpm: number };
};

export type SegmentBreakdown = {
  status: "ok" | "no-delivery" | "unavailable";
  dimension: "PLATFORMS";
  rows: SegmentRow[];
  /** Null when fewer than two platforms carry enough spend to compare. */
  efficiency: SegmentEfficiency | null;
  /** Null when nothing served in Spotlight. */
  spotlight: SpotlightSplit | null;
  /** True when views were the objective and were delivered, so CPV replaces CTR in the UI. */
  hasVideo: boolean;
  /** Segmented sums, and the unsegmented figures they are checked against. */
  reconciliation: {
    segmentedSpend: number;
    reportedSpend: number;
    /** Absolute difference as a share of the reported spend. */
    drift: number;
    /** True when the two agree closely enough to present the rows as a decomposition. */
    reconciles: boolean;
  } | null;
  /** Why a caller is seeing fewer metrics than they expect. */
  notes: string[];
  /** Set when the request was refused rather than empty. */
  reason?: string;
};

/**
 * Platform values the API returns. Anything unrecognised is shown as-is rather than dropped, so a
 * new platform appears in the UI instead of silently vanishing from the spend decomposition.
 */
const PLATFORM_LABELS: Record<string, string> = {
  ios: "iOS",
  android: "Android",
  // Returned as a sentence rather than a code, unlike every other value.
  "desktop and laptop computers": "Desktop",
  web: "Web",
  other: "Other",
  ipad: "iPad",
  iphone: "iPhone",
};

const prettyPlatform = (key: string) =>
  PLATFORM_LABELS[key.toLowerCase()] ?? key.replace(/_/g, " ");

/** Treated as reconciled below this drift; the API rounds, so an exact match is not required. */
const DRIFT_TOLERANCE = 0.005;

/**
 * Minimum share of spend for a platform to be called cheapest or dearest. Live accounts carry an
 * "Other" row worth a few cents on a handful of impressions, whose cost per view swings wildly and
 * would otherwise be presented as the platform to shift budget into.
 */
const COMPARABLE_SHARE = 0.02;

/** Efficiency gap below which platforms are treated as priced the same. */
const MATERIAL_GAP = 0.15;

/**
 * VIDEO is always requested rather than only for video objectives, because `GET /campaigns` returns
 * no objective — it lives on the line items — and a segmented job costs the same either way. The UI
 * decides whether to show view metrics from whether any came back, which is a better signal than
 * an objective label anyway.
 *
 * MOBILE_CONVERSION is deliberately absent. A segmented job accepts it and returns it structurally
 * present but entirely null: every attribution, SKAdNetwork included, is empty. Including it would
 * invite the UI to render "0 installs", which reads as "this platform drove no installs" rather
 * than the truth, which is that the API does not break installs down.
 */
const SEGMENTED_METRIC_GROUPS = "ENGAGEMENT,BILLING,VIDEO";

const CONVERSION_NOTE =
  "The Ads API does not break conversions down by platform, so installs and cost per install are not shown here — only delivery and cost.";

export async function buildPlatformBreakdown(options: {
  credentials: XCredentials;
  accountId: string;
  asUser: string | null;
  campaignId: string;
  /** From the line items, since campaigns report it as null. Decides the metric compared. */
  objective: string | null;
  /** Whole-hour ISO timestamps, end exclusive, already clamped by the caller. */
  startTime: string;
  endTime: string;
  days: number;
  /**
   * Unsegmented spend for the same window, used as the reconciliation check. Null when the caller
   * could not fetch it completely, which must not be read as zero — a zero baseline would make the
   * drift calculation trivially agree and the panel would claim a check it never performed.
   */
  reportedSpend: number | null;
  /** True for a flat-rate day buy, which has no meaningful auction breakdown. */
  takeover: boolean;
  /** Fetched by the caller from the synchronous endpoint, which the platform job cannot supply. */
  spotlight?: SpotlightSplit | null;
  auditHandle: string | null;
}): Promise<SegmentBreakdown> {
  const base: Omit<SegmentBreakdown, "status"> = {
    dimension: "PLATFORMS",
    rows: [],
    efficiency: null,
    spotlight: options.spotlight ?? null,
    hasVideo: false,
    reconciliation: null,
    notes: [],
  };

  if (options.takeover) {
    return {
      ...base,
      status: "unavailable",
      reason:
        "Takeovers are flat-rate day buys rather than auction delivery, so a platform breakdown has no cost story to tell.",
    };
  }

  if (options.days > MAX_SEGMENTED_DAYS) {
    return {
      ...base,
      status: "unavailable",
      reason: `Segmented data is only available for ${MAX_SEGMENTED_DAYS} days at a time, and this range is ${options.days}.`,
    };
  }

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
      metricGroups: SEGMENTED_METRIC_GROUPS,
      segmentationType: "PLATFORMS",
      auditHandle: options.auditHandle,
    });
  } catch (error) {
    // A breakdown is an extra, so a failed job degrades the panel rather than the drawer.
    return {
      ...base,
      status: "unavailable",
      reason:
        error instanceof StatsJobError
          ? error.message
          : "The breakdown request did not complete.",
    };
  }

  const rows: SegmentRow[] = [];
  for (const row of raw) {
    if (!row.segment) continue;
    const totals = totalsFrom(seriesFromTotalRow(row.metrics));
    // Platforms with no impressions at all are noise: a single stray impression on Android says
    // nothing, and a zero row pads the table with rows nobody can act on.
    if (totals.impressions === 0) continue;
    rows.push({ label: prettyPlatform(row.segment), key: row.segment, totals, spendShare: 0 });
  }

  if (rows.length === 0) {
    return {
      ...base,
      status: "no-delivery",
      reason: "The API returned no platform breakdown for this range.",
    };
  }

  const segmentedSpend = rows.reduce((total, row) => total + row.totals.spend, 0);
  for (const row of rows) {
    row.spendShare = segmentedSpend > 0 ? row.totals.spend / segmentedSpend : 0;
  }
  rows.sort((a, b) => b.totals.spend - a.totals.spend);

  const notes = [CONVERSION_NOTE];

  if (options.reportedSpend === null) {
    notes.push(
      "The unsegmented total for this window could not be loaded, so these rows could not be " +
        "cross-checked against it. Read the shares rather than the absolute figures.",
    );
    return {
      ...base,
      status: "ok",
      rows,
      efficiency: efficiencyOf(rows, judgeOnViews(options.objective, rows)),
      hasVideo: judgeOnViews(options.objective, rows),
      reconciliation: null,
      notes,
    };
  }

  const drift =
    options.reportedSpend > 0
      ? Math.abs(segmentedSpend - options.reportedSpend) / options.reportedSpend
      : 0;
  const reconciles = drift <= DRIFT_TOLERANCE;

  if (!reconciles) {
    /**
     * The analytics docs warn that segmented data is not expected to roll up to non-segmented
     * data. It does reconcile for platforms in practice, so rather than caveat every breakdown,
     * the drift is measured and only mentioned when it is real.
     */
    notes.push(
      `Platform rows add to ${formatUsd(segmentedSpend)} against a reported ${formatUsd(options.reportedSpend)}. The Ads API does not guarantee segmented data sums to the total, so read the shares rather than the absolute figures.`,
    );
  }

  const onViews = judgeOnViews(options.objective, rows);

  return {
    ...base,
    status: "ok",
    rows,
    efficiency: efficiencyOf(rows, onViews),
    hasVideo: onViews,
    reconciliation: {
      segmentedSpend,
      reportedSpend: options.reportedSpend,
      drift,
      reconciles,
    },
    notes,
  };
}

/**
 * Views are only the yardstick when views were what was bought. Reach campaigns run video creative
 * too, and their cost per view swings enormously between platforms without that saying anything
 * about the buy — desktop autoplay behaviour is not a media-planning mistake.
 */
function judgeOnViews(objective: string | null, rows: SegmentRow[]): boolean {
  if (!objective) return false;
  const buysViews = objective.includes("VIDEO") || objective.includes("PREROLL");
  return buysViews && rows.some((row) => row.totals.videoViews > 0);
}

function efficiencyOf(rows: SegmentRow[], hasVideo: boolean): SegmentEfficiency | null {
  const metric = hasVideo ? "cpv" : "cpm";
  const comparable = rows
    .filter((row) => row.spendShare >= COMPARABLE_SHARE && row.totals[metric] > 0)
    .sort((a, b) => a.totals[metric] - b.totals[metric]);

  if (comparable.length < 2) return null;

  const cheapest = comparable[0]!;
  const dearest = comparable[comparable.length - 1]!;
  const gap = dearest.totals[metric] / cheapest.totals[metric] - 1;

  return {
    metric,
    label: hasVideo ? "cost per view" : "cost per thousand impressions",
    cheapest: {
      label: cheapest.label,
      value: cheapest.totals[metric],
      spendShare: cheapest.spendShare,
    },
    dearest: {
      label: dearest.label,
      value: dearest.totals[metric],
      spendShare: dearest.spendShare,
    },
    gap,
    material: gap >= MATERIAL_GAP,
  };
}

/**
 * A TOTAL-granularity job returns one value per metric, so each becomes a single-element series
 * and the existing totals maths applies unchanged.
 */
function seriesFromTotalRow(metrics: Record<string, unknown>): MetricSeries {
  const series = emptySeries(1);
  for (const [metric, value] of Object.entries(metrics)) {
    if (!Array.isArray(value)) continue;
    if (!(metric in series)) continue;
    series[metric as keyof MetricSeries][0] = Number(value[0]) || 0;
  }
  return series;
}

const formatUsd = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
