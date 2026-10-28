import type { Totals } from "@/lib/x/stats";
import type { CampaignRow, PacingSummary } from "./types";

/** Active means the campaign can be turned on. Paused is the explicit off switch. */
export type StatusFilter = "all" | "active" | "paused";

const STATUSES: StatusFilter[] = ["all", "active", "paused"];

export function readStatus(value: string | null): StatusFilter {
  if (value === "active" || value === "paused") return value;
  return "all";
}

export function statusFilters(): StatusFilter[] {
  return STATUSES;
}

/**
 * Deleted campaigns and takeovers are neither. A deleted row is often still marked paused, and
 * showing it under Paused would list campaigns the advertiser can no longer switch back on.
 */
export function matchesStatus(row: CampaignRow, status: StatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "active":
      return row.entityStatus === "ACTIVE" && !row.retired && !row.takeover;
    case "paused":
      return row.entityStatus === "PAUSED" && !row.retired && !row.takeover;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function matchesObjective(row: CampaignRow, objective: string | null): boolean {
  if (!objective) return true;
  return row.objective === objective;
}

/** Objectives present on this account, in a stable order for the menu. */
export function objectiveOptions(campaigns: CampaignRow[]): string[] {
  return [
    ...new Set(
      campaigns
        .map((row) => row.objective)
        .filter((objective): objective is string => Boolean(objective)),
    ),
  ].sort();
}

/**
 * An objective in the URL that this account does not have is ignored. Treating it as a filter
 * would empty the page for a shared link that named a different advertiser's objective.
 */
export function readObjective(value: string | null, options: string[]): string | null {
  if (!value || !options.includes(value)) return null;
  return value;
}

const ratio = (numerator: number, denominator: number) =>
  denominator > 0 ? numerator / denominator : 0;

/**
 * Sum campaign totals the way the account total is built: add the counts, then derive the rates.
 * Averaging each campaign's CTR would let a $1 campaign count as much as a $1M one.
 */
export function combineTotals(rows: CampaignRow[]): Totals {
  const sum = (read: (totals: Totals) => number) =>
    rows.reduce((total, row) => total + read(row.totals), 0);

  const spend = sum((totals) => totals.spend);
  const impressions = sum((totals) => totals.impressions);
  const engagements = sum((totals) => totals.engagements);
  const clicks = sum((totals) => totals.clicks);
  const likes = sum((totals) => totals.likes);
  const retweets = sum((totals) => totals.retweets);
  const follows = sum((totals) => totals.follows);
  const videoViews = sum((totals) => totals.videoViews);
  const installsPostView = sum((totals) => totals.installsPostView);
  const installsPostEngagement = sum((totals) => totals.installsPostEngagement);
  const installs = installsPostView + installsPostEngagement;
  const reEngages = sum((totals) => totals.reEngages);

  return {
    spend,
    impressions,
    engagements,
    clicks,
    likes,
    retweets,
    replies: sum((totals) => totals.replies),
    follows,
    videoViews,
    videoViews25: sum((totals) => totals.videoViews25),
    videoViews50: sum((totals) => totals.videoViews50),
    videoViews75: sum((totals) => totals.videoViews75),
    videoViews100: sum((totals) => totals.videoViews100),
    ctr: ratio(clicks, impressions),
    engagementRate: ratio(engagements, impressions),
    cpe: ratio(spend, engagements),
    cpm: ratio(spend, impressions) * 1000,
    cpc: ratio(spend, clicks),
    viewRate: ratio(videoViews, impressions),
    cpv: ratio(spend, videoViews),
    cpf: ratio(spend, follows),
    costPerLike: ratio(spend, likes),
    costPerRepost: ratio(spend, retweets),
    installs,
    installsPostView,
    installsPostEngagement,
    costPerInstall: ratio(spend, installs),
    installViewThroughShare: ratio(installsPostView, installs),
    reEngages,
    costPerReEngage: ratio(spend, reEngages),
  };
}

/** Day-by-day sum of one chart series. Campaigns with no activity contribute nothing. */
export function sumDaily(
  rows: CampaignRow[],
  key: "spend" | "impressions" | "engagements" | "clicks" | "videoViews",
  length: number,
): number[] {
  const out = new Array<number>(length).fill(0);
  for (const row of rows) {
    const values = key === "spend" ? (row.series?.spend ?? row.spendSeries) : row.series?.[key];
    if (!values) continue;
    for (let index = 0; index < length; index += 1) {
      out[index] = (out[index] ?? 0) + (values[index] ?? 0);
    }
  }
  return out;
}

/**
 * Same headline counts the server builds for the unfiltered page. Kept here so a filtered pacing
 * panel does not keep quoting the whole account while its rows show a subset.
 */
export function pacingSummaryFrom(rows: CampaignRow[]): PacingSummary {
  const paced = rows.filter(
    (row) => row.pacing.basis === "flight" && row.pacing.status !== "ended",
  );
  const atRisk = paced.filter(
    (row) => row.pacing.status === "underpacing" && (row.pacing.projectedShortfall ?? 0) > 0,
  );
  const dark = rows.filter((row) => row.pacing.status === "dark");
  const idle = rows.filter((row) => row.pacing.status === "idle");
  return {
    trackedCampaigns: paced.length,
    committedBudget: paced.reduce((total, row) => total + (row.pacing.totalBudget ?? 0), 0),
    projectedSpend: paced.reduce((total, row) => total + (row.pacing.projectedSpend ?? 0), 0),
    budgetAtRisk: atRisk.reduce((total, row) => total + (row.pacing.projectedShortfall ?? 0), 0),
    underpacing: atRisk.length,
    overpacing: paced.filter((row) => row.pacing.status === "overpacing").length,
    dark: dark.length,
    darkDailyBudget: dark.reduce((total, row) => total + (row.pacing.dailyBudget ?? 0), 0),
    idle: idle.length,
    idleDailyBudget: idle.reduce((total, row) => total + (row.pacing.dailyBudget ?? 0), 0),
  };
}
