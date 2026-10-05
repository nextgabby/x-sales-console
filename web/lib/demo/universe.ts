import { localDate } from "../x/time";

/**
 * The generated advertiser universe the demo runs on.
 *
 * Two properties matter more than realism. **Determinism**: every figure is a pure function of an
 * entity id and a date, so two requests agree, a redeploy changes nothing, and no state has to be
 * stored or seeded. **Reconciliation**: metrics are generated at the promoted-post level and summed
 * upward, so a line item is exactly the sum of its posts and a campaign exactly the sum of its line
 * items. Generating each level independently would leave the drawer disagreeing with the row it was
 * opened from, and a tester would quite reasonably report that as a bug.
 *
 * The accounts are also chosen to cover the cases that are awkward to find in live data: an
 * objective whose only history is older than 90 days, a campaign underpacing against a total
 * budget, a takeover day buy, and an account with no delivery at all.
 */

/** 32-bit string hash. Not cryptographic — it only has to spread evenly and be stable. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic 0..1 from any key. */
function noise(key: string): number {
  let t = hash(key) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Deterministic value in [low, high]. */
function between(key: string, low: number, high: number): number {
  return low + noise(key) * (high - low);
}

export type DemoPost = {
  id: string;
  tweetId: string;
  text: string;
  /** Share of the line item's delivery, normalised across the line item's posts. */
  weight: number;
  /** Multiplies the campaign's base CTR, so one creative can genuinely out-perform another. */
  ctrFactor: number;
  entityStatus: string;
};

export type DemoLineItem = {
  id: string;
  campaignId: string;
  name: string;
  objective: string;
  productType: string;
  entityStatus: string;
  bidMicro: number | null;
  deleted: boolean;
  /** Share of the campaign's delivery. */
  weight: number;
  posts: DemoPost[];
};

export type DemoCampaign = {
  id: string;
  accountId: string;
  name: string;
  objective: string;
  entityStatus: string;
  effectiveStatus: string;
  deleted: boolean;
  fundingInstrumentId: string;
  startDaysAgo: number;
  /** Null for an open-ended flight. */
  endDaysAgo: number | null;
  dailyBudget: number | null;
  totalBudget: number | null;
  /**
   * False for a takeover: it delivers and appears in `active_entities`, but the campaigns endpoint
   * will not describe it. That absence is exactly what the real API does, and what the app keys off
   * to recognise a flat-rate day buy.
   */
  describable: boolean;
  profile: {
    /** Impressions per day at full delivery, before noise and seasonality. */
    dailyImpressions: number;
    cpm: number;
    ctr: number;
    engagementRate: number;
    viewRate: number;
    installRate: number;
    followRate: number;
    /** Scales delivery down, for a campaign that is not spending its budget. */
    delivery: number;
  };
  lineItems: DemoLineItem[];
};

export type DemoAccount = {
  id: string;
  name: string;
  /** Null when the account is granted directly rather than reached by impersonation. */
  asUser: string | null;
  timezone: string;
  industryType: string | null;
  currency: string;
  advertiserHandle: string;
  advertiserUserId: string;
  campaigns: DemoCampaign[];
};

type PostSpec = { text: string; weight: number; ctrFactor: number };
type LineItemSpec = { name: string; weight: number; deleted?: boolean; posts: PostSpec[] };

type CampaignSpec = {
  key: string;
  name: string;
  objective: string;
  startDaysAgo: number;
  endDaysAgo?: number | null;
  status?: string;
  deleted?: boolean;
  describable?: boolean;
  dailyImpressions: number;
  cpm: number;
  ctr: number;
  engagementRate?: number;
  viewRate?: number;
  installRate?: number;
  followRate?: number;
  delivery?: number;
  /**
   * Share of the daily cap the campaign actually spends. Budgets are derived from delivery rather
   * than written down, because a hand-picked budget beside a hand-picked impression volume almost
   * never agrees — the first run of this had every healthy campaign reading as underpacing, which
   * is both wrong and the one verdict a demo must get right. 1 is on pace; below
   * `CAP_BINDING_RATE` in `pacing.ts` the advice becomes "fix delivery" instead of "raise budget".
   */
  capUse?: number;
  /**
   * Total budget as a multiple of what the flight will deliver at full rate. Above 1 the campaign
   * cannot finish its commitment at its current cap, which is the case the budget advice exists for.
   */
  totalBudgetMultiple?: number;
  lineItems?: LineItemSpec[];
};

/** Weekday delivery curve, and its mean — the factor a daily budget has to be derived against. */
const SEASONAL = [0.82, 1.04, 1.06, 1.05, 1.02, 0.95, 0.84];
const SEASONAL_MEAN = SEASONAL.reduce((total, value) => total + value, 0) / SEASONAL.length;

/** Entity ids in the Ads API are short base-36-looking strings; these follow the same shape. */
function entityId(prefix: string, key: string): string {
  return `${prefix}${hash(key).toString(36).slice(0, 5).padEnd(5, "0")}`;
}

/** One insertion order per account. Campaigns reference it, and it carries the account currency. */
export function fundingInstrumentId(accountId: string): string {
  return entityId("f", `${accountId}:funding`);
}

function buildCampaign(accountId: string, spec: CampaignSpec): DemoCampaign {
  const id = entityId("c", `${accountId}:${spec.key}`);

  const itemSpecs: LineItemSpec[] =
    spec.lineItems ??
    [
      {
        name: `${spec.name} — Core`,
        weight: 0.62,
        posts: [
          { text: `${spec.name}: the headline creative.`, weight: 0.6, ctrFactor: 1.15 },
          { text: `${spec.name}: the alternate cut, longer copy explaining the offer in detail.`, weight: 0.4, ctrFactor: 0.82 },
        ],
      },
      {
        name: `${spec.name} — Broad`,
        weight: 0.38,
        posts: [{ text: `${spec.name}: broad reach creative.`, weight: 1, ctrFactor: 0.95 }],
      },
    ];

  const itemTotal = itemSpecs.reduce((total, item) => total + item.weight, 0);

  const delivery = spec.delivery ?? 1;
  // What the campaign spends per day, averaged over a whole week.
  const dailySpend = (spec.dailyImpressions / 1000) * spec.cpm * SEASONAL_MEAN;
  const dailyBudget = spec.describable === false ? null : (dailySpend * delivery) / (spec.capUse ?? 1);
  const flightDays = Math.max(spec.startDaysAgo - (spec.endDaysAgo ?? 0), 1);
  const totalBudget = spec.totalBudgetMultiple
    ? dailySpend * flightDays * spec.totalBudgetMultiple
    : null;

  /**
   * A finished flight is paused rather than left active. Campaigns the API still calls ACTIVE show
   * up in the dashboard's pacing rollup even with no spend in the window, so leaving an eight-month
   * old flight active would fill the list with rows of zeros.
   */
  const ended = spec.endDaysAgo != null && spec.endDaysAgo > 0;
  const status = spec.status ?? (ended ? "PAUSED" : "ACTIVE");

  const lineItems: DemoLineItem[] = itemSpecs.map((item, index) => {
    const lineItemId = entityId("l", `${id}:${item.name}:${index}`);
    const postTotal = item.posts.reduce((total, post) => total + post.weight, 0);
    return {
      id: lineItemId,
      campaignId: id,
      name: item.name,
      objective: spec.objective,
      productType: "PROMOTED_TWEETS",
      entityStatus: item.deleted ? "PAUSED" : status,
      bidMicro: Math.round(between(`${lineItemId}:bid`, 1.2, 9.5) * 1_000_000),
      deleted: Boolean(item.deleted),
      weight: item.weight / itemTotal,
      posts: item.posts.map((post, postIndex) => {
        const postId = entityId("p", `${lineItemId}:${postIndex}`);
        return {
          id: postId,
          // Post ids are snowflakes; any stable 19-digit number reads correctly in the UI.
          tweetId: `19${hash(`${postId}:tweet`).toString().padStart(17, "0").slice(0, 17)}`,
          text: post.text,
          weight: post.weight / postTotal,
          ctrFactor: post.ctrFactor,
          entityStatus: status,
        };
      }),
    };
  });

  return {
    id,
    accountId,
    name: spec.name,
    objective: spec.objective,
    entityStatus: status,
    effectiveStatus: spec.deleted ? "PAUSED" : status,
    deleted: Boolean(spec.deleted),
    fundingInstrumentId: fundingInstrumentId(accountId),
    startDaysAgo: spec.startDaysAgo,
    endDaysAgo: spec.endDaysAgo ?? null,
    dailyBudget,
    totalBudget,
    describable: spec.describable ?? true,
    profile: {
      dailyImpressions: spec.dailyImpressions,
      cpm: spec.cpm,
      ctr: spec.ctr,
      engagementRate: spec.engagementRate ?? spec.ctr * 3.4,
      viewRate: spec.viewRate ?? 0,
      installRate: spec.installRate ?? 0,
      followRate: spec.followRate ?? 0,
      delivery,
    },
    lineItems,
  };
}

/**
 * App-install advertiser with a deep, concentrated book. Exercises the objective KPI leading over
 * CPM, quartile bands with a real spread, the concentration caveat, and view-through attribution.
 */
const LUMEN: CampaignSpec[] = [
  { key: "always-on", name: "Always-On Installs — iOS Hybrid", objective: "APP_INSTALLS", startDaysAgo: 320, dailyImpressions: 2_900_000, cpm: 5.1, ctr: 0.0052, installRate: 0.00031 },
  { key: "q3-push", name: "Q3 Acquisition Push — Broad", objective: "APP_INSTALLS", startDaysAgo: 74, dailyImpressions: 620_000, cpm: 6.4, ctr: 0.0047, installRate: 0.00022 },
  { key: "lookalike", name: "Lookalike Expansion — Tier 1", objective: "APP_INSTALLS", startDaysAgo: 61, dailyImpressions: 330_000, cpm: 4.3, ctr: 0.0061, installRate: 0.00038 },
  { key: "retarget", name: "Retargeting — Lapsed 30d", objective: "APP_INSTALLS", startDaysAgo: 52, dailyImpressions: 95_000, cpm: 9.8, ctr: 0.0074, installRate: 0.00066 },
  { key: "creative-test", name: "Creative Test — Short Copy", objective: "APP_INSTALLS", startDaysAgo: 44, endDaysAgo: 12, dailyImpressions: 48_000, cpm: 3.4, ctr: 0.0039, installRate: 0.00014 },
  { key: "interest", name: "Interest Targeting — Fitness", objective: "APP_INSTALLS", startDaysAgo: 85, dailyImpressions: 210_000, cpm: 7.2, ctr: 0.0044, installRate: 0.00019 },
  { key: "android", name: "Android Acquisition — Standard", objective: "APP_INSTALLS", startDaysAgo: 70, dailyImpressions: 410_000, cpm: 3.9, ctr: 0.0058, installRate: 0.00041 },
  { key: "winback", name: "Winback — High LTV", objective: "APP_INSTALLS", startDaysAgo: 38, dailyImpressions: 60_000, cpm: 12.4, ctr: 0.0081, installRate: 0.00072 },
  { key: "retired-spring", name: "Spring Acquisition — Retired", objective: "APP_INSTALLS", startDaysAgo: 88, endDaysAgo: 41, deleted: true, dailyImpressions: 130_000, cpm: 5.8, ctr: 0.0049, installRate: 0.00026 },
  { key: "brand-reach", name: "Brand Reach — Launch Week", objective: "REACH", startDaysAgo: 46, dailyImpressions: 540_000, cpm: 4.6, ctr: 0.0031 },
  { key: "brand-reach-2", name: "Brand Reach — Sustain", objective: "REACH", startDaysAgo: 33, dailyImpressions: 300_000, cpm: 5.4, ctr: 0.0027 },
  { key: "engage", name: "Community Engagement", objective: "ENGAGEMENTS", startDaysAgo: 58, dailyImpressions: 150_000, cpm: 6.1, ctr: 0.0064, engagementRate: 0.027 },
];

/**
 * Travel brand. Carries the underpacing campaign, so the recommended-daily-budget advice has
 * something to fire on, plus a takeover day buy that the dashboard hides by default.
 */
const HARBORLINE: CampaignSpec[] = [
  { key: "summer-video", name: "Summer Routes — Video Views", objective: "VIDEO_VIEWS", startDaysAgo: 64, dailyImpressions: 880_000, cpm: 5.2, ctr: 0.0042, viewRate: 0.34 },
  { key: "coastal-video", name: "Coastal Campaign — Video", objective: "VIDEO_VIEWS", startDaysAgo: 48, dailyImpressions: 420_000, cpm: 6.8, ctr: 0.0036, viewRate: 0.29 },
  { key: "preroll", name: "Pre-Roll — Travel Content", objective: "PREROLL_VIEWS", startDaysAgo: 55, dailyImpressions: 340_000, cpm: 8.1, ctr: 0.0029, viewRate: 0.52 },
  { key: "reach-brand", name: "Brand Awareness — Reach", objective: "REACH", startDaysAgo: 70, dailyImpressions: 620_000, cpm: 4.1, ctr: 0.0024 },
  /**
   * Behind pace with the cap binding: it is spending essentially all of its daily budget, but the
   * commitment is half again what the flight will deliver at that rate. This is the case where
   * raising the daily budget is the real lever, and the one the advice was built for.
   */
  { key: "autumn-flash", name: "Autumn Flash Sale — Clicks", objective: "WEBSITE_CLICKS", startDaysAgo: 24, endDaysAgo: -18, totalBudgetMultiple: 1.5, capUse: 0.97, dailyImpressions: 150_000, cpm: 5.6, ctr: 0.0068 },
  /**
   * Behind pace with headroom to spare: barely a third of its cap is being used, so more budget
   * would change nothing and the constraint is bid or targeting. The contrast with the campaign
   * above is the point — the same shortfall, opposite advice.
   */
  { key: "city-video", name: "City Breaks — Video", objective: "VIDEO_VIEWS", startDaysAgo: 30, endDaysAgo: -14, totalBudgetMultiple: 1.4, capUse: 0.34, dailyImpressions: 260_000, cpm: 4.4, ctr: 0.0051, viewRate: 0.41 },
  { key: "takeover", name: "Takeover", objective: "REACH", startDaysAgo: 30, endDaysAgo: 29, describable: false, dailyImpressions: 21_000_000, cpm: 2.2, ctr: 0.0009 },
];

/**
 * Small label. The point of this account: exactly one video-view campaign in the last 90 days, and
 * four more that ran between four and ten months ago. That is the case sales described — a client
 * who has not run the objective recently — and it is what the benchmark's longer lookback is for.
 */
const CASSETTE: CampaignSpec[] = [
  { key: "new-release", name: "New Release — Video Views", objective: "VIDEO_VIEWS", startDaysAgo: 27, dailyImpressions: 140_000, cpm: 6.2, ctr: 0.0049, viewRate: 0.37 },
  { key: "spring-tour", name: "Spring Tour — Video Views", objective: "VIDEO_VIEWS", startDaysAgo: 196, endDaysAgo: 142, dailyImpressions: 120_000, cpm: 4.8, ctr: 0.0041, viewRate: 0.44 },
  { key: "album-launch", name: "Album Launch — Video Views", objective: "VIDEO_VIEWS", startDaysAgo: 268, endDaysAgo: 221, dailyImpressions: 190_000, cpm: 7.9, ctr: 0.0033, viewRate: 0.26 },
  { key: "festival", name: "Festival Season — Video Views", objective: "VIDEO_VIEWS", startDaysAgo: 152, endDaysAgo: 119, dailyImpressions: 86_000, cpm: 5.5, ctr: 0.0057, viewRate: 0.39 },
  { key: "catalogue", name: "Catalogue Promo — Video Views", objective: "VIDEO_VIEWS", startDaysAgo: 310, endDaysAgo: 266, dailyImpressions: 64_000, cpm: 9.4, ctr: 0.0028, viewRate: 0.21 },
  { key: "followers", name: "Audience Growth — Followers", objective: "FOLLOWERS", startDaysAgo: 41, dailyImpressions: 70_000, cpm: 5.9, ctr: 0.0062, followRate: 0.0021 },
];

/** An account with campaigns on the books but nothing delivering, for the empty state. */
const NORDVALE: CampaignSpec[] = [
  { key: "paused-q4", name: "Q4 Consideration — Paused", objective: "WEBSITE_CLICKS", startDaysAgo: 210, endDaysAgo: 160, dailyImpressions: 40_000, cpm: 7.4, ctr: 0.0038 },
  { key: "draft", name: "Spring Planning — Draft", objective: "REACH", startDaysAgo: 200, endDaysAgo: 180, dailyImpressions: 25_000, cpm: 6.2, ctr: 0.0031 },
];

function buildAccount(
  spec: {
    id: string;
    name: string;
    asUser: string | null;
    timezone: string;
    industryType: string | null;
    currency: string;
    advertiserHandle: string;
  },
  campaigns: CampaignSpec[],
): DemoAccount {
  return {
    ...spec,
    advertiserUserId: String(hash(spec.advertiserHandle)).padStart(12, "1"),
    campaigns: campaigns.map((campaign) => buildCampaign(spec.id, campaign)),
  };
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  buildAccount(
    {
      id: "18ce5dem0001",
      name: "Lumen Fitness",
      asUser: null,
      timezone: "America/New_York",
      industryType: "HEALTH",
      currency: "USD",
      advertiserHandle: "lumenfitness",
    },
    LUMEN,
  ),
  buildAccount(
    {
      id: "18ce5dem0002",
      name: "Harborline Travel — OMD",
      asUser: "harborline",
      timezone: "America/Los_Angeles",
      industryType: "TRAVEL",
      currency: "USD",
      advertiserHandle: "harborline",
    },
    HARBORLINE,
  ),
  buildAccount(
    {
      id: "18ce5dem0003",
      name: "Cassette Records",
      asUser: "cassetterecords",
      timezone: "America/New_York",
      // Null on purpose: most real accounts leave this unset, which is why it cannot be a vertical.
      industryType: null,
      currency: "USD",
      advertiserHandle: "cassetterecords",
    },
    CASSETTE,
  ),
  buildAccount(
    {
      id: "18ce5dem0004",
      name: "Nordvale Bank",
      asUser: "nordvalebank",
      timezone: "Europe/London",
      industryType: "FINANCIAL",
      currency: "GBP",
      advertiserHandle: "nordvalebank",
    },
    NORDVALE,
  ),
];

const accountsById = new Map(DEMO_ACCOUNTS.map((account) => [account.id, account]));

export function demoAccount(accountId: string): DemoAccount | null {
  return accountsById.get(accountId) ?? null;
}

/** Every campaign in the universe, by id, including takeovers. */
const campaignsById = new Map<string, DemoCampaign>();
const lineItemsById = new Map<string, DemoLineItem>();
const postsById = new Map<string, DemoPost>();
for (const account of DEMO_ACCOUNTS) {
  for (const campaign of account.campaigns) {
    campaignsById.set(campaign.id, campaign);
    for (const item of campaign.lineItems) {
      lineItemsById.set(item.id, item);
      for (const post of item.posts) postsById.set(post.id, post);
    }
  }
}

export function demoCampaign(id: string): DemoCampaign | null {
  return campaignsById.get(id) ?? null;
}

export function demoLineItem(id: string): DemoLineItem | null {
  return lineItemsById.get(id) ?? null;
}

/** Flight bounds as account-local dates. `end` is null for an open-ended campaign. */
export function flightDates(campaign: DemoCampaign, timeZone: string): {
  start: string;
  end: string | null;
} {
  return {
    start: localDate(campaign.startDaysAgo, timeZone),
    // A negative `endDaysAgo` is a flight that runs into the future.
    end: campaign.endDaysAgo == null ? null : localDate(campaign.endDaysAgo, timeZone),
  };
}

export type DayMetrics = {
  impressions: number;
  engagements: number;
  clicks: number;
  likes: number;
  retweets: number;
  replies: number;
  follows: number;
  link_clicks: number;
  billed_charge_local_micro: number;
  video_total_views: number;
  video_views_25: number;
  video_views_50: number;
  video_views_75: number;
  video_views_100: number;
  installsPostEngagement: number;
  installsPostView: number;
  reEngagesPostEngagement: number;
  reEngagesPostView: number;
};

export function emptyDay(): DayMetrics {
  return {
    impressions: 0,
    engagements: 0,
    clicks: 0,
    likes: 0,
    retweets: 0,
    replies: 0,
    follows: 0,
    link_clicks: 0,
    billed_charge_local_micro: 0,
    video_total_views: 0,
    video_views_25: 0,
    video_views_50: 0,
    video_views_75: 0,
    video_views_100: 0,
    installsPostEngagement: 0,
    installsPostView: 0,
    reEngagesPostEngagement: 0,
    reEngagesPostView: 0,
  };
}

export function addDay(target: DayMetrics, source: DayMetrics): DayMetrics {
  for (const key of Object.keys(target) as Array<keyof DayMetrics>) {
    target[key] += source[key];
  }
  return target;
}

/** Weekday index for a YYYY-MM-DD date, anchored at UTC so it never shifts. */
function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * One post's metrics for one date — the only place figures are invented, and a pure function of
 * the post, the campaign and the date. Every other level is a sum of these.
 */
export function postDayMetrics(
  post: DemoPost,
  campaign: DemoCampaign,
  timeZone: string,
  date: string,
): DayMetrics {
  const { start, end } = flightDates(campaign, timeZone);
  if (date < start) return emptyDay();
  if (end && date > end) return emptyDay();
  // Nothing has delivered in the future, whatever the flight says.
  if (date >= localDate(0, timeZone)) return emptyDay();

  /**
   * The post's share of the whole campaign. Weights normalise to 1 at each level, so summing posts
   * into a line item and line items into a campaign lands exactly on the campaign's own profile.
   */
  const share = (lineItemsById.get(findLineItemId(post.id))?.weight ?? 1) * post.weight;
  // Weekends run lighter, which is what a real delivery curve looks like.
  const seasonal = [0.82, 1.04, 1.06, 1.05, 1.02, 0.95, 0.84][weekday(date)]!;
  const wobble = between(`${post.id}:${date}:vol`, 0.78, 1.22);

  const impressions = Math.round(
    campaign.profile.dailyImpressions * campaign.profile.delivery * share * seasonal * wobble,
  );
  if (impressions <= 0) return emptyDay();

  const ctr = campaign.profile.ctr * post.ctrFactor * between(`${post.id}:${date}:ctr`, 0.86, 1.14);
  const clicks = Math.round(impressions * ctr);

  // Engagements include clicks by definition, so they are built on top rather than drawn apart.
  const extra = Math.round(
    impressions * Math.max(campaign.profile.engagementRate - ctr, 0) * between(`${post.id}:${date}:er`, 0.85, 1.15),
  );
  const engagements = clicks + extra;

  const likes = Math.round(extra * 0.62);
  const retweets = Math.round(extra * 0.19);
  const replies = Math.max(extra - likes - retweets, 0);

  const cpm = campaign.profile.cpm * between(`${post.id}:${date}:cpm`, 0.88, 1.12);
  const billed = Math.round((impressions / 1000) * cpm * 1_000_000);

  const views = campaign.profile.viewRate
    ? Math.round(impressions * campaign.profile.viewRate * between(`${post.id}:${date}:vr`, 0.9, 1.1))
    : 0;

  const installs = campaign.profile.installRate
    ? Math.round(impressions * campaign.profile.installRate * between(`${post.id}:${date}:ins`, 0.8, 1.2))
    : 0;
  // View-through dominates app conversions on real accounts, so the demo shows that too.
  const installsPostView = Math.round(installs * between(`${post.id}:${date}:vt`, 0.68, 0.88));

  const follows = campaign.profile.followRate
    ? Math.round(impressions * campaign.profile.followRate * between(`${post.id}:${date}:fol`, 0.85, 1.15))
    : 0;

  return {
    impressions,
    engagements,
    clicks,
    likes,
    retweets,
    replies,
    follows,
    link_clicks: clicks,
    billed_charge_local_micro: billed,
    video_total_views: views,
    video_views_25: Math.round(views * 0.74),
    video_views_50: Math.round(views * 0.51),
    video_views_75: Math.round(views * 0.33),
    video_views_100: Math.round(views * 0.24),
    installsPostEngagement: Math.max(installs - installsPostView, 0),
    installsPostView,
    reEngagesPostEngagement: 0,
    reEngagesPostView: 0,
  };
}

/** Reverse lookup, since a post only stores its own id. */
const lineItemIdByPostId = new Map<string, string>();
for (const item of lineItemsById.values()) {
  for (const post of item.posts) lineItemIdByPostId.set(post.id, item.id);
}
function findLineItemId(postId: string): string {
  return lineItemIdByPostId.get(postId) ?? "";
}

export function lineItemDayMetrics(
  item: DemoLineItem,
  campaign: DemoCampaign,
  timeZone: string,
  date: string,
): DayMetrics {
  const total = emptyDay();
  for (const post of item.posts) {
    addDay(total, postDayMetrics(post, campaign, timeZone, date));
  }
  return total;
}

export function campaignDayMetrics(
  campaign: DemoCampaign,
  timeZone: string,
  date: string,
): DayMetrics {
  const total = emptyDay();
  for (const item of campaign.lineItems) {
    addDay(total, lineItemDayMetrics(item, campaign, timeZone, date));
  }
  return total;
}

/** Metrics for whichever entity type an id belongs to, so the stats endpoint stays generic. */
export function entityDayMetrics(
  entity: "CAMPAIGN" | "LINE_ITEM" | "PROMOTED_TWEET",
  id: string,
  timeZone: string,
  date: string,
): DayMetrics | null {
  if (entity === "CAMPAIGN") {
    const campaign = campaignsById.get(id);
    return campaign ? campaignDayMetrics(campaign, timeZone, date) : null;
  }
  if (entity === "LINE_ITEM") {
    const item = lineItemsById.get(id);
    if (!item) return null;
    const campaign = campaignsById.get(item.campaignId);
    return campaign ? lineItemDayMetrics(item, campaign, timeZone, date) : null;
  }
  const post = postsById.get(id);
  if (!post) return null;
  const item = lineItemsById.get(findLineItemId(post.id));
  const campaign = item ? campaignsById.get(item.campaignId) : null;
  return campaign ? postDayMetrics(post, campaign, timeZone, date) : null;
}

export function demoPost(id: string): DemoPost | null {
  return postsById.get(id) ?? null;
}

export function demoPostByTweetId(tweetId: string): DemoPost | null {
  for (const post of postsById.values()) {
    if (post.tweetId === tweetId) return post;
  }
  return null;
}
