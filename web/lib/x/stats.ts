import { adsRequest, AdsApiError, chunkEntityIds } from "./ads-client";
import { microsToCurrency, type DateRange } from "./time";
import type { XCredentials } from "../store";

/** Raw metric names we read out of the API response. */
const RAW_METRICS = [
  "impressions",
  "engagements",
  "clicks",
  "likes",
  "retweets",
  "replies",
  "follows",
  "link_clicks",
  "billed_charge_local_micro",
  "video_total_views",
  "video_views_25",
  "video_views_50",
  "video_views_75",
  "video_views_100",
] as const;

export type RawMetric = (typeof RAW_METRICS)[number];

/**
 * Conversion metrics do not come back as flat arrays like every other metric. Each one is an
 * object keyed by attribution type, and the API publishes no total — so a conversion count only
 * exists once we choose which attributions to add together.
 */
const CONVERSION_SOURCES = [
  { raw: "mobile_conversion_installs", key: "installs" },
  { raw: "mobile_conversion_re_engages", key: "reEngages" },
] as const;

/**
 * `assisted`, `order_quantity` and `sale_amount` are also returned but came back null on every
 * live campaign checked, and `assisted` would double-count against the other two if it were not.
 */
const ATTRIBUTIONS = ["post_view", "post_engagement"] as const;

type ConversionKey = (typeof CONVERSION_SOURCES)[number]["key"];
type Attribution = (typeof ATTRIBUTIONS)[number];
export type ConversionSeriesKey = `${ConversionKey}_${Attribution}`;

const CONVERSION_SERIES_KEYS = CONVERSION_SOURCES.flatMap((source) =>
  ATTRIBUTIONS.map((attribution) => `${source.key}_${attribution}` as ConversionSeriesKey),
);

const SERIES_KEYS: Array<RawMetric | ConversionSeriesKey> = [
  ...RAW_METRICS,
  ...CONVERSION_SERIES_KEYS,
];

export type MetricSeries = Record<RawMetric | ConversionSeriesKey, number[]>;

type ConversionMetric = Partial<Record<Attribution, Array<number | null> | null>>;

type StatsResponse = {
  data?: Array<{
    id: string;
    id_data?: Array<{
      metrics?: Record<string, Array<number | null> | ConversionMetric | null>;
    }>;
  }>;
};

export function emptySeries(length: number): MetricSeries {
  return Object.fromEntries(
    SERIES_KEYS.map((metric) => [metric, new Array(length).fill(0)]),
  ) as MetricSeries;
}

/**
 * Writes one entity's returned `metrics` object into a series, mapping each position in the
 * response through `columnFor` and skipping anything it declines to place.
 *
 * Both the synchronous and asynchronous paths go through here so there is a single definition of
 * which attributions add up to an install. Two copies of that rule would be free to disagree, and
 * the disagreement would show up as a cost per install that differs depending on how far back the
 * caller happened to look.
 */
export function writeMetrics(
  target: MetricSeries,
  metrics: Record<string, unknown>,
  columnFor: (offset: number) => number | null,
): void {
  const write = (key: RawMetric | ConversionSeriesKey, values: Array<number | null>) => {
    values.forEach((value, offset) => {
      const column = columnFor(offset);
      if (column === null) return;
      target[key][column] = value ?? 0;
    });
  };

  for (const metric of RAW_METRICS) {
    const values = metrics[metric];
    if (Array.isArray(values)) write(metric, values);
  }

  for (const source of CONVERSION_SOURCES) {
    const nested = metrics[source.raw];
    if (!nested || Array.isArray(nested) || typeof nested !== "object") continue;
    for (const attribution of ATTRIBUTIONS) {
      const values = (nested as ConversionMetric)[attribution];
      if (Array.isArray(values)) write(`${source.key}_${attribution}`, values);
    }
  }
}

/**
 * One entity's TOTAL-granularity metrics as a single-column series, so the same `totalsFrom` that
 * derives every rate for the dashboard also derives them for history fetched as a lump sum.
 */
export function totalSeriesFrom(metrics: Record<string, unknown>): MetricSeries {
  const series = emptySeries(1);
  writeMetrics(series, metrics, (offset) => (offset === 0 ? 0 : null));
  return series;
}

/**
 * Daily series per entity across a range that may span several API windows.
 *
 * Two independent limits force the chunking here: a request covers at most 7 days, and at
 * most 20 entity IDs. Results are written back into fixed-length arrays indexed by the
 * range's date list, so every series lines up regardless of how the calls were split.
 */
export type DailyStatsResult = {
  series: Record<string, MetricSeries>;
  /**
   * Requests that never returned. Those days stay zero, which silently understates spend, so
   * callers must surface this rather than presenting the totals as complete.
   */
  failedRequests: number;
  totalRequests: number;
  /** True when the API rate-limited us, which is worth telling the rep to retry rather than refetch. */
  rateLimited: boolean;
};

export async function fetchDailyStats(options: {
  credentials: XCredentials;
  accountId: string;
  asUser: string | null;
  entity: "CAMPAIGN" | "LINE_ITEM" | "PROMOTED_TWEET";
  entityIds: string[];
  range: DateRange;
  metricGroups: string;
  /**
   * Defaults to every placement on X. `SPOTLIGHT` and `TREND` are breakdowns *within* that, not
   * additions to it — a campaign whose line item spends its full daily budget reports that whole
   * budget under `ALL_ON_TWITTER` while still reporting a non-zero `SPOTLIGHT` figure, so the two
   * cannot be added without double counting.
   */
  placement?: "ALL_ON_TWITTER" | "SPOTLIGHT" | "TREND";
  auditHandle: string | null;
}): Promise<DailyStatsResult> {
  const { range } = options;
  const result: Record<string, MetricSeries> = {};
  for (const id of options.entityIds) result[id] = emptySeries(range.dates.length);

  if (options.entityIds.length === 0) {
    return { series: result, failedRequests: 0, totalRequests: 0, rateLimited: false };
  }

  // Index lookup so a window's values land in the right columns of the full range.
  const columnOf = new Map(range.dates.map((date, index) => [date, index]));

  const requests: Array<{ window: (typeof range.windows)[number]; chunk: string[] }> = [];
  for (const window of range.windows) {
    for (const chunk of chunkEntityIds(options.entityIds)) {
      requests.push({ window, chunk });
    }
  }

  let failedRequests = 0;
  let rateLimited = false;

  for (const { window, chunk } of requests) {
    /**
     * Once the API is rate-limiting us, every remaining window will exhaust its retries too, and
     * because these run in sequence the backoff compounds — a real 30-day request took 246
     * seconds. Bailing out turns that into a fast, honest partial result.
     */
    if (rateLimited) {
      failedRequests += 1;
      continue;
    }

    let response: StatsResponse;
    try {
      response = await adsRequest<StatsResponse>({
        path: `/stats/accounts/${options.accountId}`,
        credentials: options.credentials,
        asUser: options.asUser,
        audit: { handle: options.auditHandle, accountId: options.accountId },
        query: {
          entity: options.entity,
          entity_ids: chunk.join(","),
          start_time: window.startTime,
          end_time: window.endTime,
          granularity: "DAY",
          metric_groups: options.metricGroups,
          placement: options.placement ?? "ALL_ON_TWITTER",
        },
      });
    } catch (error) {
      // A failed window leaves zeros for those days rather than losing the whole range, but it
      // is counted so the caller can say the totals are incomplete.
      if (error instanceof AdsApiError && error.status === 429) rateLimited = true;
      failedRequests += 1;
      continue;
    }

    for (const entity of response.data ?? []) {
      const target = result[entity.id];
      if (!target) continue;
      const metrics = entity.id_data?.[0]?.metrics;
      if (!metrics) continue;

      // Each window returns its own days, which have to land in the right columns of the full range.
      writeMetrics(target, metrics, (offset) => {
        const date = window.dates[offset];
        if (!date) return null;
        return columnOf.get(date) ?? null;
      });
    }
  }

  return { series: result, failedRequests, totalRequests: requests.length, rateLimited };
}

export type Totals = {
  spend: number;
  impressions: number;
  engagements: number;
  clicks: number;
  likes: number;
  retweets: number;
  replies: number;
  follows: number;
  videoViews: number;
  videoViews25: number;
  videoViews50: number;
  videoViews75: number;
  videoViews100: number;
  /** Derived, per the metric definitions in the Ads API analytics docs. */
  ctr: number;
  engagementRate: number;
  cpe: number;
  cpm: number;
  cpc: number;
  viewRate: number;
  cpv: number;
  /** Cost per follow, the KPI for follower objectives. `follows` rides along in ENGAGEMENT. */
  cpf: number;
  /**
   * App conversions, present only when MOBILE_CONVERSION was requested. `installs` is the sum of
   * the two attributions the API populates, because it publishes no total of its own.
   */
  installs: number;
  installsPostView: number;
  installsPostEngagement: number;
  costPerInstall: number;
  /**
   * Share of installs credited to people who saw the ad without engaging. Carried because it is
   * the difference between two campaigns that look identical on cost per install: one live
   * campaign drew 96% of its installs from view-through against another's 72%.
   */
  installViewThroughShare: number;
  reEngages: number;
  costPerReEngage: number;
};

const sum = (values: number[] | undefined) =>
  (values ?? []).reduce((total, value) => total + (value || 0), 0);

const ratio = (numerator: number, denominator: number) =>
  denominator > 0 ? numerator / denominator : 0;

export function totalsFrom(series: MetricSeries): Totals {
  const spend = microsToCurrency(sum(series.billed_charge_local_micro));
  const impressions = sum(series.impressions);
  const engagements = sum(series.engagements);
  const clicks = sum(series.clicks);
  const videoViews = sum(series.video_total_views);
  const follows = sum(series.follows);
  const installsPostView = sum(series.installs_post_view);
  const installsPostEngagement = sum(series.installs_post_engagement);
  const installs = installsPostView + installsPostEngagement;
  const reEngages = sum(series.reEngages_post_view) + sum(series.reEngages_post_engagement);

  return {
    spend,
    impressions,
    engagements,
    clicks,
    likes: sum(series.likes),
    retweets: sum(series.retweets),
    replies: sum(series.replies),
    follows,
    videoViews,
    videoViews25: sum(series.video_views_25),
    videoViews50: sum(series.video_views_50),
    videoViews75: sum(series.video_views_75),
    videoViews100: sum(series.video_views_100),
    ctr: ratio(clicks, impressions),
    engagementRate: ratio(engagements, impressions),
    cpe: ratio(spend, engagements),
    cpm: ratio(spend, impressions) * 1000,
    cpc: ratio(spend, clicks),
    viewRate: ratio(videoViews, impressions),
    cpv: ratio(spend, videoViews),
    cpf: ratio(spend, follows),
    installs,
    installsPostView,
    installsPostEngagement,
    costPerInstall: ratio(spend, installs),
    installViewThroughShare: ratio(installsPostView, installs),
    reEngages,
    costPerReEngage: ratio(spend, reEngages),
  };
}

/** Element-wise sum, used to roll campaigns up into an account-level series. */
export function addSeries(target: MetricSeries, source: MetricSeries): MetricSeries {
  for (const metric of SERIES_KEYS) {
    source[metric]?.forEach((value, index) => {
      target[metric][index] = (target[metric][index] ?? 0) + (value || 0);
    });
  }
  return target;
}

export function combineSeries(all: MetricSeries[], length: number): MetricSeries {
  return all.reduce<MetricSeries>((acc, series) => addSeries(acc, series), emptySeries(length));
}

/** Spend per day in account currency, for charts and sparklines. */
export function dailySpend(series: MetricSeries): number[] {
  return series.billed_charge_local_micro.map((value) => microsToCurrency(value));
}

/** The metrics worth charting per campaign. Keys match `ChartMetricKey` on the client. */
export const CHART_METRICS = [
  "spend",
  "impressions",
  "engagements",
  "clicks",
  "videoViews",
] as const;

/**
 * A trimmed daily series for charting one campaign against another. Sending the full metric
 * set for every campaign would balloon the dashboard payload on accounts with a hundred
 * campaigns, and the rest is not plotted.
 */
export function chartSeries(series: MetricSeries): Record<string, number[]> {
  return {
    spend: dailySpend(series),
    impressions: series.impressions,
    engagements: series.engagements,
    clicks: series.clicks,
    videoViews: series.video_total_views,
  };
}

/**
 * Metric groups worth requesting for a campaign objective. Video metrics are only populated
 * for video objectives, so asking for them everywhere just inflates the payload.
 */
/**
 * Objectives bought on views. `PREROLL_VIEWS` does not contain the string "VIDEO", so a substring
 * test silently starves it of the metrics it is judged on: every view figure stays zero, the
 * benchmark drops cost per view as unavailable, and CPM quietly becomes the headline metric for a
 * campaign nobody bought impressions for.
 */
const VIEW_OBJECTIVE = /VIDEO|PREROLL/;

export function metricGroupsFor(objectives: Array<string | null | undefined>): string {
  const groups = new Set(["ENGAGEMENT", "BILLING"]);
  if (objectives.some((objective) => objective && VIEW_OBJECTIVE.test(objective))) {
    groups.add("VIDEO");
  }
  /**
   * App objectives are judged on installs, not impressions, so the conversion group is the only
   * way to answer "was this a good buy". Verified to ride along in the same request as ENGAGEMENT
   * and BILLING, so it costs no extra calls, but it is still scoped to app objectives because the
   * response carries 30 conversion metrics that are null for everyone else.
   */
  if (objectives.some((objective) => objective?.startsWith("APP_"))) {
    groups.add("MOBILE_CONVERSION");
  }
  return [...groups].join(",");
}
