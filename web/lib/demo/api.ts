import { datesBetween, localDate } from "../x/time";
import {
  DEMO_ACCOUNTS,
  addDay,
  campaignDayMetrics,
  demoAccount,
  demoCampaign,
  demoPostByTweetId,
  emptyDay,
  entityDayMetrics,
  entityId,
  flightDates,
  fundingInstrumentId,
  type DayMetrics,
  type DemoAccount,
  type DemoCampaign,
} from "./universe";

/**
 * Answers Ads API requests from the generated universe, in the shapes the real endpoints return.
 *
 * Standing in for the API rather than for the app's own endpoints is a deliberate choice. It means
 * every line of real logic still runs — the rollups, the benchmark cohort rules, the quartile
 * bands, the pacing arithmetic, the audience reconciliation — so the demo exercises the product
 * instead of a parallel set of hand-written fixtures that would drift out of agreement with it the
 * first time a rule changed. It also means the numbers reconcile for free: the drawer agrees with
 * the row it was opened from because both are summed from the same per-post figures.
 */

export class DemoApiError extends Error {}

type Query = Record<string, string | number | boolean | undefined | null>;

const str = (query: Query, key: string): string | null => {
  const value = query[key];
  return value == null || value === "" ? null : String(value);
};

const list = (query: Query, key: string): string[] => {
  const value = str(query, key);
  return value ? value.split(",").map((part) => part.trim()).filter(Boolean) : [];
};

/** The account a path refers to, so every handler can resolve its own timezone. */
function accountFromPath(path: string): DemoAccount {
  const id = /\/accounts\/([^/?]+)/.exec(path)?.[1];
  const account = id ? demoAccount(id) : null;
  if (!account) throw new DemoApiError(`Demo universe has no account ${id}.`);
  return account;
}

/** `GET /accounts/:id` and the account list both return this. */
function accountObject(account: DemoAccount) {
  return {
    name: account.name,
    business_name: null,
    timezone: account.timezone,
    timezone_switch_at: "2016-01-01T05:00:00Z",
    country_code: account.timezone.startsWith("Europe") ? "GB" : "US",
    id: account.id,
    created_at: "2021-03-18T15:02:11Z",
    updated_at: new Date().toISOString(),
    industry_type: account.industryType,
    business_id: null,
    approval_status: "ACCEPTED",
    deleted: false,
  };
}

function campaignObject(campaign: DemoCampaign, timeZone: string) {
  const { start, end } = flightDates(campaign, timeZone);
  return {
    id: campaign.id,
    name: campaign.name,
    entity_status: campaign.entityStatus,
    effective_status: campaign.effectiveStatus,
    deleted: campaign.deleted,
    servable: !campaign.deleted && campaign.entityStatus === "ACTIVE",
    objective: campaign.objective,
    funding_instrument_id: campaign.fundingInstrumentId,
    start_time: `${start}T00:00:00Z`,
    end_time: end ? `${end}T00:00:00Z` : null,
    daily_budget_amount_local_micro:
      campaign.dailyBudget == null ? null : Math.round(campaign.dailyBudget * 1_000_000),
    total_budget_amount_local_micro:
      campaign.totalBudget == null ? null : Math.round(campaign.totalBudget * 1_000_000),
  };
}

/**
 * Budgets and flight dates live on line items in the real API — every campaign-level budget field
 * comes back null — so the demo mirrors that, or the pacing panel would have nothing to read.
 */
function lineItemObjects(campaign: DemoCampaign, timeZone: string) {
  const { start, end } = flightDates(campaign, timeZone);
  return campaign.lineItems.map((item) => ({
    id: item.id,
    name: item.name,
    campaign_id: campaign.id,
    objective: item.objective,
    product_type: item.productType,
    entity_status: item.entityStatus,
    bid_amount_local_micro: item.bidMicro,
    goal: null,
    deleted: item.deleted,
    start_time: `${start}T00:00:00Z`,
    end_time: end ? `${end}T00:00:00Z` : null,
    daily_budget_amount_local_micro:
      campaign.dailyBudget == null
        ? null
        : Math.round(campaign.dailyBudget * item.weight * 1_000_000),
    total_budget_amount_local_micro:
      campaign.totalBudget == null
        ? null
        : Math.round(campaign.totalBudget * item.weight * 1_000_000),
  }));
}

function fundingInstruments(account: DemoAccount) {
  return [
    {
      // Must match what the campaigns reference, or the currency cannot be resolved per campaign.
      id: fundingInstrumentId(account.id),
      description: `${account.name} — Insertion Order`,
      type: "CREDIT_LINE",
      currency: account.currency,
      credit_limit_local_micro: 5_000_000_000_000,
      funded_amount_local_micro: 1_250_000_000_000,
      entity_status: "ACTIVE",
      able_to_fund: true,
      deleted: false,
    },
  ];
}

/** Totals over a date range for one entity, used by both granularities. */
function sumRange(
  entity: "CAMPAIGN" | "LINE_ITEM" | "PROMOTED_TWEET",
  id: string,
  timeZone: string,
  dates: string[],
): { perDay: DayMetrics[]; total: DayMetrics } | null {
  const perDay: DayMetrics[] = [];
  const total = emptyDay();
  for (const date of dates) {
    const day = entityDayMetrics(entity, id, timeZone, date);
    if (day === null) return null;
    perDay.push(day);
    addDay(total, day);
  }
  return { perDay, total };
}

/**
 * Placement is a breakdown *within* all of X, not an addition to it, so Spotlight and Trend return
 * a slice of the same delivery rather than extra. Spotlight also prices lower, which is the finding
 * the breakdown panel exists to surface.
 */
function placementScale(placement: string): { volume: number; price: number } {
  if (placement === "SPOTLIGHT") return { volume: 0.14, price: 0.62 };
  if (placement === "TREND") return { volume: 0.04, price: 0.81 };
  return { volume: 1, price: 1 };
}

function scaleDay(day: DayMetrics, scale: { volume: number; price: number }): DayMetrics {
  if (scale.volume === 1 && scale.price === 1) return day;
  const scaled = emptyDay();
  for (const key of Object.keys(scaled) as Array<keyof DayMetrics>) {
    scaled[key] = Math.round(day[key] * scale.volume);
  }
  scaled.billed_charge_local_micro = Math.round(
    day.billed_charge_local_micro * scale.volume * scale.price,
  );
  return scaled;
}

/** Shapes one entity's metrics into the `id_data[].metrics` object, gated by metric group. */
function metricsObject(
  days: DayMetrics[],
  groups: Set<string>,
  granularity: "DAY" | "TOTAL",
): Record<string, unknown> {
  const series = (pick: (day: DayMetrics) => number): number[] =>
    granularity === "TOTAL"
      ? [days.reduce((total, day) => total + pick(day), 0)]
      : days.map(pick);

  const metrics: Record<string, unknown> = {};

  if (groups.has("ENGAGEMENT")) {
    metrics.impressions = series((d) => d.impressions);
    metrics.engagements = series((d) => d.engagements);
    metrics.clicks = series((d) => d.clicks);
    metrics.likes = series((d) => d.likes);
    metrics.retweets = series((d) => d.retweets);
    metrics.replies = series((d) => d.replies);
    metrics.follows = series((d) => d.follows);
    metrics.url_clicks = series((d) => d.link_clicks);
    metrics.app_clicks = series(() => 0);
  }
  if (groups.has("BILLING")) {
    metrics.billed_charge_local_micro = series((d) => d.billed_charge_local_micro);
    metrics.billed_engagements = series((d) => d.engagements);
  }
  if (groups.has("VIDEO")) {
    metrics.video_total_views = series((d) => d.video_total_views);
    metrics.video_views_25 = series((d) => d.video_views_25);
    metrics.video_views_50 = series((d) => d.video_views_50);
    metrics.video_views_75 = series((d) => d.video_views_75);
    metrics.video_views_100 = series((d) => d.video_views_100);
  }
  if (groups.has("MOBILE_CONVERSION")) {
    // Nested by attribution with no total published, exactly as the real response is shaped.
    metrics.mobile_conversion_installs = {
      post_view: series((d) => d.installsPostView),
      post_engagement: series((d) => d.installsPostEngagement),
      assisted: null,
      order_quantity: null,
      sale_amount: null,
    };
    metrics.mobile_conversion_re_engages = {
      post_view: series((d) => d.reEngagesPostView),
      post_engagement: series((d) => d.reEngagesPostEngagement),
      assisted: null,
      order_quantity: null,
      sale_amount: null,
    };
  }

  return metrics;
}

function statsResponse(path: string, query: Query) {
  const account = accountFromPath(path);
  const entity = (str(query, "entity") ?? "CAMPAIGN") as
    | "CAMPAIGN"
    | "LINE_ITEM"
    | "PROMOTED_TWEET";
  const ids = list(query, "entity_ids");
  const granularity = (str(query, "granularity") ?? "DAY") as "DAY" | "TOTAL";
  const groups = new Set(list(query, "metric_groups").map((group) => group.toUpperCase()));
  const scale = placementScale(str(query, "placement") ?? "ALL_ON_TWITTER");

  const start = (str(query, "start_time") ?? "").slice(0, 10);
  const endExclusive = (str(query, "end_time") ?? "").slice(0, 10);
  if (!start || !endExclusive) throw new DemoApiError("Demo stats needs start_time and end_time.");

  // `end_time` is exclusive, so the last date wanted is the day before it.
  const lastDate = localDateBefore(endExclusive);
  const dates = start <= lastDate ? datesBetween(start, lastDate) : [];

  return {
    data: ids.map((id) => {
      const summed = sumRange(entity, id, account.timezone, dates);
      const days = (summed?.perDay ?? dates.map(() => emptyDay())).map((day) =>
        scaleDay(day, scale),
      );
      return { id, id_data: [{ segment: null, metrics: metricsObject(days, groups, granularity) }] };
    }),
    request: { params: { account_id: account.id, entity, entity_ids: ids } },
  };
}

/** One calendar day before a YYYY-MM-DD date. */
function localDateBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * `active_entities` is the authority on what spent, and it is the only place a takeover appears —
 * the campaigns endpoint will not describe one. Reproducing that is what lets the app's takeover
 * handling be exercised at all.
 */
function activeEntitiesResponse(path: string, query: Query) {
  const account = accountFromPath(path);
  const start = (str(query, "start_time") ?? "").slice(0, 10);
  const endExclusive = (str(query, "end_time") ?? "").slice(0, 10);
  const lastDate = localDateBefore(endExclusive);
  const dates = start && start <= lastDate ? datesBetween(start, lastDate) : [];

  const active = account.campaigns.filter((campaign) =>
    dates.some((date) => {
      const day = campaignDayMetrics(campaign, account.timezone, date);
      return day.impressions > 0 || day.billed_charge_local_micro > 0;
    }),
  );

  return {
    data: active.map((campaign) => ({
      entity_id: campaign.id,
      activity_start_time: `${localDate(dates.length, account.timezone)}T00:00:00Z`,
      activity_end_time: new Date().toISOString(),
      placements: ["ALL_ON_TWITTER"],
    })),
  };
}

/**
 * Marks a job result as belonging to the demo. The async stats code reads the result file over
 * plain `fetch`, which would mean the server calling itself and depending on `APP_ORIGIN` being
 * set correctly; this scheme lets it recognise a demo job and read the file in-process instead.
 */
export const DEMO_JOB_SCHEME = "demo-job:";

/**
 * Segmented and unsegmented asynchronous jobs, answered as already finished.
 *
 * The whole job id is the request that produced it, encoded — so the result file can be rebuilt
 * from the id alone and no job state has to be held anywhere.
 */
function jobId(accountId: string, query: Query): string {
  const spec = {
    a: accountId,
    e: str(query, "entity"),
    i: list(query, "entity_ids"),
    s: str(query, "start_time"),
    t: str(query, "end_time"),
    g: str(query, "metric_groups"),
    z: str(query, "segmentation_type"),
  };
  return `demo-${Buffer.from(JSON.stringify(spec)).toString("base64url")}`;
}

function jobObject(id: string, segmentationType: string | null) {
  return {
    id,
    id_str: id,
    status: "SUCCESS",
    url: `${DEMO_JOB_SCHEME}${id}`,
    segmentation_type: segmentationType,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: new Date().toISOString(),
  };
}

function createJobResponse(path: string, query: Query) {
  const account = accountFromPath(path);
  return {
    data: jobObject(jobId(account.id, query), str(query, "segmentation_type")),
  };
}

function pollJobResponse(query: Query) {
  return { data: list(query, "job_ids").map((id) => jobObject(id, null)) };
}

/**
 * A segment's share of delivery, and how its price and response differ from the campaign average.
 *
 * `price` and `rate` exist because a breakdown whose segments all price identically is worse than
 * no breakdown: the insights panel correctly reports "every platform is within 0% of the others, so
 * there is nothing to shift between them", which teaches a reviewer that the feature does nothing.
 * Both factors are normalised against the shares below, so the segments still sum to the whole.
 */
type Bucket = { label: string; share: number; price: number; rate: number };

/** Younger audiences are cheaper to reach and respond more; the oldest bands are the reverse. */
const AGE_BUCKETS: Bucket[] = [
  { label: "13 to 17", share: 0.04, price: 0.71, rate: 1.22 },
  { label: "18 to 24", share: 0.21, price: 0.84, rate: 1.26 },
  { label: "25 to 34", share: 0.32, price: 0.97, rate: 1.08 },
  { label: "35 to 44", share: 0.21, price: 1.08, rate: 0.92 },
  { label: "45 to 54", share: 0.12, price: 1.19, rate: 0.78 },
  { label: "55 to 64", share: 0.07, price: 1.28, rate: 0.64 },
  { label: "over 65", share: 0.03, price: 1.34, rate: 0.55 },
];

const GENDER_BUCKETS: Bucket[] = [
  { label: "Male", share: 0.54, price: 0.98, rate: 1.04 },
  { label: "Female", share: 0.42, price: 1.04, rate: 0.95 },
];

const PLATFORM_BUCKETS: Bucket[] = [
  { label: "iOS", share: 0.47, price: 1.14, rate: 1.11 },
  { label: "Android", share: 0.38, price: 0.88, rate: 0.94 },
  { label: "Web", share: 0.13, price: 0.79, rate: 0.71 },
  { label: "Other", share: 0.02, price: 0.92, rate: 0.46 },
];

/** Keys scaled by `rate` — the responses — as opposed to impressions and the billed amount. */
const RATE_KEYS: Array<keyof DayMetrics> = [
  "engagements",
  "clicks",
  "likes",
  "retweets",
  "replies",
  "follows",
  "link_clicks",
  "video_total_views",
  "video_views_25",
  "video_views_50",
  "video_views_75",
  "video_views_100",
  "installsPostEngagement",
  "installsPostView",
  "reEngagesPostEngagement",
  "reEngagesPostView",
];

/**
 * Splits a total into labelled segments.
 *
 * `coverage` below 1 leaves a deliberate shortfall: gender is not known for every impression, which
 * is what the real API returns and what the audience panel reports as "Unknown" rather than
 * rescaling away. At full coverage the last segment absorbs every rounding remainder, so the rows
 * add up to the campaign total exactly — the panel says they do, so they have to.
 */
function bucketRows(
  total: DayMetrics,
  buckets: Bucket[],
  groups: Set<string>,
  coverage: number,
): Array<{ segment: string; metrics: Record<string, unknown> }> {
  const covered = buckets.reduce((sum, bucket) => sum + bucket.share, 0);
  // Share-weighted means of 1, so applying the factors redistributes the total without changing it.
  const priceMean = buckets.reduce((sum, b) => sum + (b.share / covered) * b.price, 0);
  const rateMean = buckets.reduce((sum, b) => sum + (b.share / covered) * b.rate, 0);

  const slices = buckets.map((bucket) => {
    const fraction = (bucket.share / covered) * coverage;
    const slice = emptyDay();
    for (const key of Object.keys(slice) as Array<keyof DayMetrics>) {
      slice[key] = Math.round(total[key] * fraction);
    }
    slice.billed_charge_local_micro = Math.round(
      total.billed_charge_local_micro * fraction * (bucket.price / priceMean),
    );
    for (const key of RATE_KEYS) {
      slice[key] = Math.round(total[key] * fraction * (bucket.rate / rateMean));
    }
    return slice;
  });

  if (coverage === 1 && slices.length > 0) {
    const last = slices[slices.length - 1]!;
    for (const key of Object.keys(last) as Array<keyof DayMetrics>) {
      const others = slices.slice(0, -1).reduce((sum, slice) => sum + slice[key], 0);
      last[key] = Math.max(total[key] - others, 0);
    }
  }

  return buckets.map((bucket, index) => ({
    segment: bucket.label,
    metrics: metricsObject([slices[index]!], groups, "TOTAL"),
  }));
}

export function demoStatsJobFile(jobId: string): unknown {
  const raw = jobId.replace(/^demo-/, "");
  const spec = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
    a: string;
    e: "CAMPAIGN" | "LINE_ITEM" | "PROMOTED_TWEET";
    i: string[];
    s: string;
    t: string;
    g: string | null;
    z: string | null;
  };

  const account = demoAccount(spec.a);
  if (!account) throw new DemoApiError("Demo job references an unknown account.");

  const groups = new Set((spec.g ?? "").split(",").map((group) => group.trim().toUpperCase()));
  const lastDate = localDateBefore(spec.t.slice(0, 10));
  const start = spec.s.slice(0, 10);
  const dates = start <= lastDate ? datesBetween(start, lastDate) : [];

  return {
    data: spec.i.map((id) => {
      const summed = sumRange(spec.e, id, account.timezone, dates);
      const total = summed?.total ?? emptyDay();

      if (!spec.z) {
        return { id, id_data: [{ segment: null, metrics: metricsObject([total], groups, "TOTAL") }] };
      }
      if (spec.z === "AGE") {
        return { id, id_data: bucketRows(total, AGE_BUCKETS, groups, 1) };
      }
      if (spec.z === "GENDER") {
        // Short of 100% on purpose; the shortfall is what the panel reports as Unknown.
        return { id, id_data: bucketRows(total, GENDER_BUCKETS, groups, 0.962) };
      }
      if (spec.z === "PLATFORMS") {
        return { id, id_data: bucketRows(total, PLATFORM_BUCKETS, groups, 1) };
      }
      return { id, id_data: [] };
    }),
    request: { params: { account_id: spec.a, segmentation_type: spec.z } },
  };
}

/** The v2 post lookup, for creative text. No media: the demo makes no outbound requests. */
function tweetLookupResponse(query: Query) {
  const ids = list(query, "ids");
  const posts = ids.map((id) => ({ id, post: demoPostByTweetId(id) }));
  return {
    data: posts
      .filter((entry) => entry.post)
      .map((entry) => ({
        id: entry.id,
        text: entry.post!.text,
        created_at: new Date(Date.now() - 86_400_000 * 30).toISOString(),
        author_id: "100000000001",
      })),
    includes: { users: [{ id: "100000000001", username: "demoadvertiser" }] },
  };
}

type DemoCriterion = { type: string; value: string; name: string; negated?: boolean };

type DemoAudience = { id: string; name: string; size: number; deleted: boolean };

/**
 * The retargeting lists the demo advertisers own. One is deleted on purpose: a campaign still
 * targeting a list that no longer exists is the single most useful thing this panel surfaces, and
 * it is almost impossible to find on demand in a live account.
 */
const DEMO_AUDIENCES: DemoAudience[] = [
  { id: entityId("a", "lapsed-30"), name: "Lapsed Installs | 30 Days", size: 412_000, deleted: false },
  { id: entityId("a", "high-ltv"), name: "High LTV | Top Decile", size: 86_500, deleted: false },
  { id: entityId("a", "purchasers"), name: "App Purchasers | All Time", size: 233_900, deleted: false },
  { id: entityId("a", "spring-crm"), name: "Spring CRM Upload | 2023", size: 0, deleted: true },
];

const audienceId = (key: string) => entityId("a", key);

/** Country targeting follows the account, matching the `country_code` the account object reports. */
function baseCriteria(account: DemoAccount): DemoCriterion[] {
  const uk = account.timezone.startsWith("Europe");
  return [
    uk
      ? { type: "LOCATION", value: "e8c38fa2ac9e2cfa", name: "United Kingdom" }
      : { type: "LOCATION", value: "96683cc9126741d1", name: "United States" },
    { type: "AGE", value: "AGE_OVER_18", name: "AGE_OVER_18" },
    { type: "LANGUAGE", value: "en", name: "English" },
  ];
}

/**
 * Targeting keyed off the campaign name.
 *
 * The universe's campaign names already announce what they target — "Interest Targeting — Fitness",
 * "Lookalike Expansion", "Retargeting — Lapsed 30d" — so deriving criteria from them keeps the
 * drawer agreeing with the row it was opened from, which is the whole point of generating this
 * universe from one source. The first match wins, and between them they cover every case the panel
 * and its signals can render: exclusions, a dead audience, a handle targeted two ways, keywords,
 * and a campaign with no targeting at all.
 */
const TARGETING: Array<[match: RegExp, criteria: DemoCriterion[]]> = [
  [
    /Interest Targeting/,
    [
      { type: "INTEREST", value: "19004", name: "Fitness and exercise" },
      { type: "INTEREST", value: "19006", name: "Running" },
      { type: "INTEREST", value: "19013", name: "Nutrition" },
      { type: "PLATFORM", value: "0", name: "iOS" },
    ],
  ],
  [
    /Lookalike/,
    [
      /**
       * The same handle direct and as a lookalike, which is what the overlap signal is for: reps
       * read the two lines as one audience when they are different people.
       */
      { type: "FOLLOWERS_OF_USER", value: "586671909", name: "lumenfitness" },
      { type: "SIMILAR_TO_FOLLOWERS_OF_USER", value: "586671909", name: "lumenfitness" },
      { type: "SIMILAR_TO_FOLLOWERS_OF_USER", value: "26257166", name: "stravarunning" },
    ],
  ],
  [
    /Retargeting|Winback/,
    [
      { type: "CUSTOM_AUDIENCE", value: audienceId("lapsed-30"), name: "Custom audience targeting" },
      { type: "CUSTOM_AUDIENCE", value: audienceId("high-ltv"), name: "Custom audience targeting" },
      { type: "CUSTOM_AUDIENCE", value: audienceId("spring-crm"), name: "Custom audience targeting" },
      {
        type: "CUSTOM_AUDIENCE",
        value: audienceId("purchasers"),
        name: "Custom audience targeting",
        negated: true,
      },
      { type: "ENGAGEMENT_TYPE", value: "IMPRESSION", name: "RETARGETING_ENGAGEMENT_TYPE" },
    ],
  ],
  [
    /Android/,
    [
      { type: "PLATFORM", value: "1", name: "Android" },
      { type: "OS_VERSION", value: "1033", name: "Android 12.0 and above" },
    ],
  ],
  [
    // The one campaign carrying exclusions, so the signal that names them has something to name.
    /Autumn Flash Sale/,
    [
      { type: "BROAD_KEYWORD", value: "flight deals", name: "flight deals" },
      { type: "BROAD_KEYWORD", value: "last minute holiday", name: "last minute holiday" },
      { type: "LOCATION", value: "4ec01d20b82a9fa3", name: "Alaska, US", negated: true },
      { type: "LOCATION", value: "e17b4a2f0b0b1f32", name: "Hawaii, US", negated: true },
      { type: "BROAD_KEYWORD", value: "flight cancelled", name: "flight cancelled", negated: true },
    ],
  ],
  [
    /Pre-Roll/,
    [
      { type: "CONTENT_PUBLISHER_USER", value: "1367531", name: "NatGeoTravel" },
      { type: "IAB_CATEGORY", value: "IAB20", name: "Travel" },
    ],
  ],
  [
    /Followers/,
    [
      { type: "FOLLOWERS_OF_USER", value: "14230524", name: "pitchfork" },
      { type: "FOLLOWERS_OF_USER", value: "19761086", name: "rollingstone" },
    ],
  ],
  [
    /New Release|Album Launch|Festival|Catalogue|Spring Tour/,
    [{ type: "CONVERSATION", value: "music_and_radio", name: "Music and radio" }],
  ],
  [
    /Summer Routes|Coastal|City Breaks|Brand Awareness/,
    [
      { type: "CONVERSATION", value: "travel", name: "Travel" },
      { type: "DEVICE", value: "3f7", name: "iPhone 15" },
    ],
  ],
  [/Clicks/, [{ type: "BROAD_KEYWORD", value: "book now", name: "book now" }]],
];

/**
 * A line item's targeting. Every campaign generates a "— Core" and a "— Broad" line item, and that
 * split is used rather than invented: Broad carries the base layer alone, Core adds the specific
 * targeting, which is both how a real buy is structured and what makes the panel's "on 1 of 2 line
 * items" distinction visible.
 */
function demoCriteria(
  account: DemoAccount,
  campaign: DemoCampaign,
  lineItem: { name: string },
): DemoCriterion[] {
  /**
   * The untargeted case. A sustain reach buy left wide open is the realistic version of it, and
   * the signal that warns about unconstrained delivery needs one line item somewhere to fire on.
   */
  if (/Brand Reach — Sustain/.test(campaign.name) && /Broad$/.test(lineItem.name)) return [];

  const base = baseCriteria(account);
  if (!/Core$/.test(lineItem.name)) return base;

  const specific = TARGETING.find(([match]) => match.test(campaign.name))?.[1] ?? [];
  return [...base, ...specific];
}

/**
 * Routes one request to the right handler. Throwing on an unrecognised path is deliberate: a
 * silent empty response would surface as a confusing blank panel, whereas this names the gap.
 */
export function demoAdsRequest(options: {
  method: "GET" | "POST";
  path: string;
  query: Query;
}): unknown {
  const { method, path, query } = options;

  if (path.startsWith("https://api.x.com/2/tweets")) return tweetLookupResponse(query);

  if (path === "/accounts") {
    // Only the directly granted account; the rest are reached by impersonation, as in real life.
    return { data: DEMO_ACCOUNTS.filter((a) => a.asUser === null).map(accountObject), next_cursor: null };
  }

  if (method === "POST" && /^\/stats\/jobs\/accounts\//.test(path)) {
    return createJobResponse(path, query);
  }
  if (method === "GET" && /^\/stats\/jobs\/accounts\//.test(path)) {
    return pollJobResponse(query);
  }
  if (/^\/stats\/accounts\/[^/]+\/active_entities$/.test(path)) {
    return activeEntitiesResponse(path, query);
  }
  if (/^\/stats\/accounts\/[^/]+$/.test(path)) {
    return statsResponse(path, query);
  }

  const account = accountFromPath(path);
  const rest = path.replace(/^\/accounts\/[^/]+/, "");

  if (rest === "") return { data: accountObject(account) };

  if (rest === "/funding_instruments") {
    return { data: fundingInstruments(account), next_cursor: null };
  }

  if (rest === "/promotable_users") {
    return {
      data: [{ user_id: account.advertiserUserId, promotable_user_type: "FULL" }],
      next_cursor: null,
    };
  }

  if (rest === "/authenticated_user_access") {
    return { data: { permissions: ["ACCOUNT_ADMIN", "ANALYTICS", "CAMPAIGN_ADMIN"] } };
  }

  if (rest === "/campaigns") {
    const withDeleted = str(query, "with_deleted") === "true";
    const describable = account.campaigns.filter((campaign) => campaign.describable);
    const visible = withDeleted
      ? describable
      : describable.filter((campaign) => !campaign.deleted);
    return {
      data: visible.map((campaign) => campaignObject(campaign, account.timezone)),
      next_cursor: null,
    };
  }

  const singleCampaign = /^\/campaigns\/([^/?]+)$/.exec(rest)?.[1];
  if (singleCampaign) {
    const campaign = demoCampaign(singleCampaign);
    // A takeover is not describable, so this is the 404 the real API gives for one.
    if (!campaign || !campaign.describable) return { data: null };
    return { data: campaignObject(campaign, account.timezone) };
  }

  if (rest === "/line_items") {
    const wanted = new Set(list(query, "campaign_ids"));
    const withDeleted = str(query, "with_deleted") === "true";
    const items = account.campaigns
      .filter((campaign) => campaign.describable)
      .filter((campaign) => wanted.size === 0 || wanted.has(campaign.id))
      .flatMap((campaign) => lineItemObjects(campaign, account.timezone))
      .filter((item) => withDeleted || !item.deleted);
    return { data: items, next_cursor: null };
  }

  if (rest === "/promoted_tweets") {
    const wanted = new Set(list(query, "line_item_ids"));
    const data = account.campaigns
      .filter((campaign) => campaign.describable)
      .flatMap((campaign) => campaign.lineItems)
      .filter((item) => wanted.size === 0 || wanted.has(item.id))
      .flatMap((item) =>
        item.posts.map((post) => ({
          id: post.id,
          tweet_id: post.tweetId,
          line_item_id: item.id,
          entity_status: post.entityStatus,
          approval_status: "ACCEPTED",
          deleted: false,
        })),
      );
    return { data, next_cursor: null };
  }

  if (rest === "/targeting_criteria") {
    const wanted = new Set(list(query, "line_item_ids"));
    const data = account.campaigns
      .filter((campaign) => campaign.describable)
      .flatMap((campaign) =>
        campaign.lineItems
          .filter((item) => wanted.has(item.id))
          .flatMap((item) =>
            demoCriteria(account, campaign, item).map((criterion, index) => ({
              line_item_id: item.id,
              name: criterion.name,
              id: entityId("t", `${item.id}:${criterion.type}:${criterion.value}:${index}`),
              operator_type: criterion.negated ? "NE" : "EQ",
              targeting_value: criterion.value,
              targeting_type: criterion.type,
              deleted: false,
              created_at: "2024-02-04T11:20:00Z",
              updated_at: "2024-02-04T11:20:00Z",
            })),
          ),
      );
    return { data, next_cursor: null };
  }

  if (rest === "/custom_audiences") {
    /**
     * Only ever answered scoped by id here, which is how `buildTargeting` asks: the unscoped list
     * is a real endpoint but nothing in the app calls it, and inventing an account-wide audience
     * library to answer a request no one makes is fixture drift waiting to happen.
     */
    const wanted = list(query, "custom_audience_ids");
    const data = wanted
      .map((id) => DEMO_AUDIENCES.find((audience) => audience.id === id))
      .filter((audience): audience is DemoAudience => Boolean(audience))
      .map((audience) => ({
        targetable: !audience.deleted,
        name: audience.name,
        targetable_types: ["CRM", "EXCLUDED_CRM"],
        audience_type: "CRM",
        description: null,
        permission_level: "READ_WRITE",
        owner_account_id: account.id,
        id: audience.id,
        reasons_not_targetable: audience.deleted ? ["AUDIENCE_TOO_SMALL"] : [],
        created_at: "2023-11-02T09:00:00Z",
        updated_at: "2024-03-19T16:41:00Z",
        partner_source: null,
        deleted: audience.deleted,
        audience_size: audience.size,
      }));
    return { data, next_cursor: null };
  }

  /**
   * Previews are the one thing the demo cannot produce: the real endpoint returns an iframe served
   * from a X host, and pointing at it would both make an outbound request and show a real post.
   * An empty list is a case the drawer already handles.
   */
  if (rest === "/tweet_previews") return { data: [] };

  throw new DemoApiError(`Demo universe does not implement ${method} ${path}`);
}
