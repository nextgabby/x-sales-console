import type { ExtendedCampaign } from "./benchmark-history";
import { combineSeries, totalsFrom, type MetricSeries, type Totals } from "./stats";
import type { CampaignRow } from "@/app/accounts/[accountId]/types";

/**
 * Compares one campaign against what the brand itself normally gets for the same objective.
 *
 * Two rules decide whether this is honest or merely plausible. First, every statistic is computed
 * from summed numerators and denominators rather than by averaging per-campaign rates, because a
 * $200 campaign and a $1.8M campaign are not two equal opinions about what a click costs. Second,
 * the campaign under review is never part of its own baseline.
 */

/** Campaigns below this are treated as noise rather than history. */
const MIN_COHORT_SPEND = 100;

/** Fewer comparable campaigns than this and the sample gets called out in the UI. */
export const SMALL_COHORT = 3;

/** A cohort campaign counts as concurrent once it shares this much of the campaign's flight. */
const CONCURRENT_OVERLAP = 0.5;

/** Above this share held by one campaign, the baseline is really just that campaign. */
const CONCENTRATION_LIMIT = 0.6;

/**
 * Campaigns needed before a quartile range is shown. With three, the quartiles are interpolated
 * from so few points that the band is really just the extremes wearing a statistic's clothes.
 */
const MIN_BAND_SAMPLE = 4;

export type BenchmarkFormat = "currency" | "percent";

/**
 * Volume, reported without a comparison on purpose. One campaign's install count against the sum
 * of a five-campaign cohort reads as "94% worse", which is arithmetic rather than a finding. Only
 * rates are benchmarked; size is given as context.
 */
export type BenchmarkVolume = {
  spend: number;
  impressions: number;
  clicks: number;
  installs: number;
  /** This campaign's share of everything the brand spent on the objective in the window. */
  spendShare: number;
};

/**
 * The middle of the spread across the cohort's individual campaigns, as a range.
 *
 * This is **not** an error bar around `baseline`, and conflating the two would misrepresent both.
 * `baseline` pools numerators and denominators, so it is weighted by volume and answers "what does
 * this brand pay on this objective". The band is unweighted across campaigns and answers a
 * different question: "where do individual campaigns on this objective usually land". One enormous
 * campaign can put the pooled baseline outside the band entirely, which is informative rather than
 * a contradiction.
 *
 * Quartiles rather than lowest-to-highest because the extremes on a real account are a $200 test
 * and an end-of-quarter push, and a range stretched to cover both describes nothing.
 */
export type BenchmarkBand = {
  /** 25th percentile across cohort campaigns. */
  low: number;
  /** 75th percentile. */
  high: number;
  /** Median, the figure to quote when only one number fits. */
  mid: number;
  /** Campaigns that could contribute, i.e. that had a denominator for this metric. */
  sample: number;
};

export type BenchmarkMetric = {
  key: string;
  label: string;
  format: BenchmarkFormat;
  lowerIsBetter: boolean;
  campaign: number;
  baseline: number;
  /** Signed share of the baseline, or null when the baseline is zero and a ratio says nothing. */
  delta: number | null;
  /** The objective's own KPI, which leads the panel and can invert a rates-only verdict. */
  primary: boolean;
  /** Null when too few campaigns carry this metric for a spread to mean anything. */
  band: BenchmarkBand | null;
  /** Where this campaign falls relative to the band. */
  position: "below" | "within" | "above" | null;
};

export type BenchmarkStatus =
  | "ok"
  /** The API gives no objective for this campaign, so there is nothing to match a cohort on. */
  | "no-objective"
  /** The brand has no other campaign on this objective worth comparing against. */
  | "no-cohort"
  /** The campaign itself never delivered in the window, so there is nothing to judge. */
  | "no-delivery";

/**
 * The older period mixed into the baseline, when the recent window held too little on its own.
 *
 * Carried so the panel can age the claim. "Versus the brand's last 90 days" and "versus the brand's
 * last year" support different sentences in front of an advertiser, and a baseline whose newest
 * campaign ended months ago describes a different auction from the one running today.
 */
export type BenchmarkLookback = {
  fromDate: string;
  toDate: string;
  /** Campaigns found in the older period and added to the cohort. */
  campaigns: number;
};

export type Benchmark = {
  status: BenchmarkStatus;
  objective: string | null;
  /** Which baseline was used. Null unless `status` is "ok". */
  basis: "concurrent" | "historical" | null;
  basisReason: string | null;
  windowDays: number;
  /** Null when the recent window was enough, or when nothing older was searched. */
  lookback: BenchmarkLookback | null;
  /** Why the older period added nothing, when it was searched and came back empty. */
  lookbackReason: string | null;
  /** Days the campaign delivered, and how many of those the baseline covers. */
  campaignDays: number;
  baselineDays: number;
  cohort: {
    campaigns: number;
    spend: number;
    /** Share of cohort spend held by its single largest campaign. */
    concentration: number;
    largestName: string | null;
    names: string[];
  };
  metrics: BenchmarkMetric[];
  volume: BenchmarkVolume | null;
  /** Caveats that change how the comparison should be read. Rendered, not hidden. */
  notes: string[];
};

type MetricSpec = {
  key: string;
  label: string;
  format: BenchmarkFormat;
  lowerIsBetter: boolean;
  value: (totals: Totals) => number;
  /** Skipped when the denominator is absent, so video rows never appear for a static campaign. */
  available?: (totals: Totals) => boolean;
};

const CPM: MetricSpec = {
  key: "cpm",
  label: "CPM",
  format: "currency",
  lowerIsBetter: true,
  value: (t) => t.cpm,
};
const CTR: MetricSpec = {
  key: "ctr",
  label: "CTR",
  format: "percent",
  lowerIsBetter: false,
  value: (t) => t.ctr,
};
const CPC: MetricSpec = {
  key: "cpc",
  label: "Cost per click",
  format: "currency",
  lowerIsBetter: true,
  value: (t) => t.cpc,
  available: (t) => t.clicks > 0,
};
const CPE: MetricSpec = {
  key: "cpe",
  label: "Cost per engagement",
  format: "currency",
  lowerIsBetter: true,
  value: (t) => t.cpe,
  available: (t) => t.engagements > 0,
};
const ENGAGEMENT_RATE: MetricSpec = {
  key: "engagementRate",
  label: "Engagement rate",
  format: "percent",
  lowerIsBetter: false,
  value: (t) => t.engagementRate,
};
const CPV: MetricSpec = {
  key: "cpv",
  label: "Cost per video view",
  format: "currency",
  lowerIsBetter: true,
  value: (t) => t.cpv,
  available: (t) => t.videoViews > 0,
};
const VIEW_RATE: MetricSpec = {
  key: "viewRate",
  label: "View rate",
  format: "percent",
  lowerIsBetter: false,
  value: (t) => t.viewRate,
  available: (t) => t.videoViews > 0,
};
const CPI: MetricSpec = {
  key: "costPerInstall",
  label: "Cost per install",
  format: "currency",
  lowerIsBetter: true,
  value: (t) => t.costPerInstall,
  available: (t) => t.installs > 0,
};
const CPRE: MetricSpec = {
  key: "costPerReEngage",
  label: "Cost per re-engagement",
  format: "currency",
  lowerIsBetter: true,
  value: (t) => t.costPerReEngage,
  available: (t) => t.reEngages > 0,
};
const CPF: MetricSpec = {
  key: "cpf",
  label: "Cost per follow",
  format: "currency",
  lowerIsBetter: true,
  value: (t) => t.cpf,
  available: (t) => t.follows > 0,
};

/**
 * The metric a campaign should actually be judged on, by objective, followed by supporting rates.
 *
 * This mapping is the whole point of the feature. Two live app-install campaigns ranked opposite
 * ways depending on whether CPM or cost per install led: the one running at roughly twice the
 * cohort CPM bought installs at a third of the price. Leading with the objective's own KPI is what
 * stops the panel from confidently recommending the worse buy.
 */
const OBJECTIVE_METRICS: Record<string, MetricSpec[]> = {
  APP_INSTALLS: [CPI, CPM, CTR],
  APP_ENGAGEMENTS: [CPRE, CPM, CTR],
  APP_RE_ENGAGEMENTS: [CPRE, CPM, CTR],
  FOLLOWERS: [CPF, CPM, ENGAGEMENT_RATE],
  ENGAGEMENTS: [CPE, ENGAGEMENT_RATE, CPM],
  TWEET_ENGAGEMENTS: [CPE, ENGAGEMENT_RATE, CPM],
  VIDEO_VIEWS: [CPV, VIEW_RATE, CPM],
  PREROLL_VIEWS: [CPV, VIEW_RATE, CPM],
  WEBSITE_CLICKS: [CPC, CTR, CPM],
  LINK_CLICKS: [CPC, CTR, CPM],
  REACH: [CPM, ENGAGEMENT_RATE, CTR],
};

/** Used when the objective is one we have no specific KPI for. */
const DEFAULT_METRICS: MetricSpec[] = [CPM, CTR, ENGAGEMENT_RATE, CPE];

function metricsFor(objective: string): MetricSpec[] {
  return OBJECTIVE_METRICS[objective] ?? DEFAULT_METRICS;
}

/** "October 2025", for dating a baseline that reaches back past the dashboard's window. */
function monthLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Indices where a campaign actually delivered. Spend alone misses free-delivering days. */
function activeDays(series: MetricSeries): Set<number> {
  const days = new Set<number>();
  series.impressions.forEach((impressions, index) => {
    if (impressions > 0 || (series.billed_charge_local_micro[index] ?? 0) > 0) days.add(index);
  });
  return days;
}

/** A copy of the series with every day outside `days` zeroed, so totals cover only those days. */
function restrictTo(series: MetricSeries, days: Set<number>): MetricSeries {
  const restricted = {} as MetricSeries;
  for (const [metric, values] of Object.entries(series) as Array<[keyof MetricSeries, number[]]>) {
    restricted[metric] = values.map((value, index) => (days.has(index) ? value : 0));
  }
  return restricted;
}

/**
 * Linear-interpolated percentile over a sorted list, which is what spreadsheets call PERCENTILE.INC.
 * Matching that matters: these numbers get read next to figures the team produced in a sheet.
 */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/**
 * Whether a campaign has a figure for this metric that belongs in a range.
 *
 * Costs and rates need different tests, and conflating them biases the band. A campaign with no
 * installs has no cost per install, so entering it as $0 would drag the band toward free — but a
 * campaign with no clicks has a perfectly real CTR of zero, and dropping it leaves a range built
 * only from the campaigns that worked. Measured on a live cohort, that was the difference between a
 * CTR range of 0.19–0.23% across 9 campaigns and the truth, which was that 8 of the 17 got no
 * clicks at all. `format` separates the two exactly: every cost is currency, every rate a percent.
 */
function contributesTo(spec: MetricSpec, totals: Totals): boolean {
  if (spec.available ? !spec.available(totals) : totals.impressions <= 0) return false;
  // A cost needs money behind it to be a price anybody could quote.
  return spec.format === "currency" ? totals.spend > 0 : true;
}

/** The quartile band for one metric across the cohort's campaigns. */
function bandFor(spec: MetricSpec, cohortTotals: Totals[]): BenchmarkBand | null {
  const values = cohortTotals
    .filter((totals) => contributesTo(spec, totals))
    .map((totals) => spec.value(totals))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (values.length < MIN_BAND_SAMPLE) return null;

  return {
    low: percentile(values, 0.25),
    high: percentile(values, 0.75),
    mid: percentile(values, 0.5),
    sample: values.length,
  };
}

/**
 * Explains a weighted baseline that falls outside its own quartile band.
 *
 * On screen those two numbers look like they disagree, and the delta can read the opposite way from
 * the range beside it: a campaign can be cheaper than what the brand pays overall while being dearer
 * than its typical campaign. Both are true, and saying so beats leaving a rep to work out which
 * number is the broken one. Exported so the wording can be checked against real metric values
 * without rebuilding a 90-day account.
 */
export function skewNote(metrics: BenchmarkMetric[]): string | null {
  const skewed = metrics.filter(
    (metric) =>
      metric.band && (metric.baseline < metric.band.low || metric.baseline > metric.band.high),
  );
  if (skewed.length === 0) return null;

  // "Cost per install" reads better lowercased mid-sentence; CPM and CTR do not.
  const names = skewed.map((metric) =>
    metric.label === metric.label.toUpperCase() ? metric.label : metric.label.toLowerCase(),
  );
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  return (
    `The brand's weighted ${list} ${skewed.length === 1 ? "sits" : "sit"} outside the range its ` +
    `individual campaigns usually land in, because the spend is concentrated in campaigns that ` +
    `price differently from the typical one. The range describes a campaign; the weighted figure ` +
    `describes the money.`
  );
}

/**
 * One cohort member, flattened so recent campaigns and older ones can be treated alike.
 *
 * Recent campaigns carry a daily series aligned to the dashboard's range; older ones carry a
 * single-column total, because fetching a year day by day is not affordable and nothing here needs
 * the days. Everything downstream of the concurrency test works from totals, so the two coexist.
 */
type CohortMember = {
  name: string;
  retired: boolean;
  series: MetricSeries;
  /** True for a member with no aligned days, which can therefore never be judged concurrent. */
  older: boolean;
};

export function buildBenchmark(options: {
  campaign: CampaignRow;
  /** The brand's own history for the window, already excluding takeovers. */
  history: CampaignRow[];
  rawSeries: Record<string, MetricSeries>;
  windowDays: number;
  /**
   * Campaigns from before the window, fetched only because it held too little. Each carries a total
   * for the whole older period rather than a daily series.
   */
  older?: ExtendedCampaign[];
  /** The older period searched, whether or not it yielded anything. */
  lookback?: { fromDate: string; toDate: string; reason: string | null };
}): Benchmark {
  const { campaign, history, rawSeries, windowDays, older = [], lookback } = options;

  const empty: Benchmark["cohort"] = {
    campaigns: 0,
    spend: 0,
    concentration: 0,
    largestName: null,
    names: [],
  };
  const base = {
    objective: campaign.objective,
    basis: null,
    basisReason: null,
    windowDays,
    lookback: null,
    lookbackReason: lookback?.reason ?? null,
    campaignDays: 0,
    baselineDays: 0,
    cohort: empty,
    metrics: [],
    volume: null,
    notes: [],
  } satisfies Omit<Benchmark, "status">;

  if (!campaign.objective) return { ...base, status: "no-objective" };

  const own = rawSeries[campaign.id];
  const ownDays = own ? activeDays(own) : new Set<number>();
  if (!own || ownDays.size === 0) {
    return { ...base, status: "no-delivery", campaignDays: 0 };
  }

  /**
   * Retired campaigns stay in the cohort: they were real spend against the same objective, and
   * dropping them would quietly shrink the history of any brand that cleans up its account.
   */
  const cohortRows = history.filter(
    (row) =>
      row.id !== campaign.id &&
      !row.takeover &&
      row.objective === campaign.objective &&
      row.totals.spend >= MIN_COHORT_SPEND &&
      Boolean(rawSeries[row.id]),
  );

  const recent: CohortMember[] = cohortRows.map((row) => ({
    name: row.name,
    retired: row.retired,
    series: rawSeries[row.id]!,
    older: false,
  }));

  /**
   * Older campaigns are held to the same spend floor as recent ones. The floor lives here rather
   * than in the fetch so there is one definition of what counts as history.
   */
  const olderMembers: CohortMember[] = older
    .filter((entry) => totalsFrom(entry.series).spend >= MIN_COHORT_SPEND)
    .map((entry) => ({
      name: entry.name,
      retired: entry.retired,
      series: entry.series,
      older: true,
    }));

  if (recent.length === 0 && olderMembers.length === 0) {
    return { ...base, status: "no-cohort", campaignDays: ownDays.size };
  }

  // Concurrent where possible: a baseline drawn from different weeks is partly a measure of how
  // the auction moved, not of how this campaign was run.
  const overlapping = recent.filter((member) => {
    const days = activeDays(member.series);
    let shared = 0;
    for (const day of ownDays) if (days.has(day)) shared += 1;
    return shared >= Math.ceil(ownDays.size * CONCURRENT_OVERLAP);
  });

  /**
   * A cohort reaching back months is historical by definition, so the concurrency test is not even
   * attempted once older campaigns are in it. Skipping the test is also what keeps it honest: an
   * older member's total sits in column zero, and a campaign that delivered on only one or two days
   * could share that column by coincidence and be called concurrent with a campaign from last year.
   */
  const concurrent =
    olderMembers.length === 0 && overlapping.length >= Math.min(SMALL_COHORT, recent.length);
  const selected = concurrent ? overlapping : [...recent, ...olderMembers];
  const basis = concurrent ? "concurrent" : "historical";

  // A concurrent baseline is also restricted to the same days, or it would still be comparing a
  // 12-day campaign against a 90-day one.
  const cohortSeries = selected.map((member) =>
    concurrent ? restrictTo(member.series, ownDays) : member.series,
  );

  const length = own.impressions.length;
  const baselineTotals = totalsFrom(combineSeries(cohortSeries, length));
  const campaignTotals = totalsFrom(restrictTo(own, ownDays));

  const spends = selected
    .map((member, index) => ({ name: member.name, spend: totalsFrom(cohortSeries[index]!).spend }))
    .sort((a, b) => b.spend - a.spend);
  const cohortSpend = spends.reduce((total, entry) => total + entry.spend, 0);
  const concentration = cohortSpend > 0 ? (spends[0]?.spend ?? 0) / cohortSpend : 0;

  /**
   * Counted over the window's own columns, so older members contribute nothing: their total sits in
   * a single column that stands for months, and adding it would report a year of history as one day.
   * `lookback` is what describes the older period's extent.
   */
  const baselineDays = new Set<number>();
  for (const [index, member] of selected.entries()) {
    if (member.older) continue;
    for (const day of activeDays(cohortSeries[index]!)) baselineDays.add(day);
  }

  // Per-campaign totals, which the pooled baseline deliberately throws away and the band needs.
  const perCampaignTotals = cohortSeries.map((series) => totalsFrom(series));

  const metrics = metricsFor(campaign.objective)
    .filter(
      (spec) =>
        !spec.available || spec.available(campaignTotals) || spec.available(baselineTotals),
    )
    .map((spec, index) => {
      const campaignValue = spec.value(campaignTotals);
      const baselineValue = spec.value(baselineTotals);
      const band = bandFor(spec, perCampaignTotals);
      return {
        key: spec.key,
        label: spec.label,
        format: spec.format,
        lowerIsBetter: spec.lowerIsBetter,
        campaign: campaignValue,
        baseline: baselineValue,
        delta: baselineValue > 0 ? (campaignValue - baselineValue) / baselineValue : null,
        primary: index === 0,
        band,
        position:
          band == null || campaignValue <= 0
            ? null
            : campaignValue < band.low
              ? "below"
              : campaignValue > band.high
                ? "above"
                : "within",
      } satisfies BenchmarkMetric;
    });

  const notes: string[] = [];

  if (concentration > CONCENTRATION_LIMIT && spends[0]) {
    notes.push(
      `${spends[0].name} is ${Math.round(concentration * 100)}% of the baseline spend, so this is ` +
        `close to a comparison against that one campaign.`,
    );
  }

  if (selected.length < SMALL_COHORT) {
    notes.push(
      `Only ${selected.length} comparable campaign${selected.length === 1 ? "" : "s"}, so the ` +
        `baseline moves a lot with any one of them.`,
    );
  }

  /**
   * When the volume-weighted figure sits outside the range most campaigns land in, the two numbers
   * on screen look like they disagree. They do not: it means the brand's spend on this objective is
   * concentrated in campaigns that price differently from its typical one. Saying so is better than
   * letting a rep decide which number is the broken one.
   */
  const skew = skewNote(metrics);
  if (skew) notes.push(skew);

  /**
   * Said before the generic non-concurrent caveat, because it is the stronger version of the same
   * point: a cohort reaching back months is not describing today's auction, and a rep quoting it to
   * an advertiser should know which months they are quoting.
   */
  if (olderMembers.length > 0 && lookback) {
    notes.push(
      `The last ${windowDays} days held ${
        recent.length === 0
          ? "no campaign on this objective"
          : `only ${recent.length} campaign${recent.length === 1 ? "" : "s"} on this objective`
      }, so the baseline reaches back to ${monthLabel(lookback.fromDate)} and adds ${
        olderMembers.length
      } older one${olderMembers.length === 1 ? "" : "s"}. Prices from that far back reflect a ` +
        `different auction, so treat this as the brand's track record rather than its current rate.`,
    );
  } else if (!concurrent) {
    notes.push(
      `No campaign on this objective shared enough of the flight, so the baseline is the full ` +
        `${windowDays} days and partly reflects how the auction moved.`,
    );
  }

  /**
   * View-through installs are credited to people who never touched the ad, and the two live
   * campaigns checked differed enormously on this: 96% against 72%. A cost per install built
   * mostly from view-through is a weaker claim than the same number built from engagement.
   */
  if (campaignTotals.installs > 0 && baselineTotals.installs > 0) {
    const mine = Math.round(campaignTotals.installViewThroughShare * 100);
    const theirs = Math.round(baselineTotals.installViewThroughShare * 100);
    notes.push(
      `Installs counted here are post-engagement plus view-through, the only figures the API ` +
        `reports. View-through is ${mine}% of this campaign's installs against ${theirs}% of the ` +
        `baseline's.`,
    );
  }

  if (selected.some((member) => member.retired)) {
    const retired = selected.filter((member) => member.retired).length;
    notes.push(
      `${retired} of the ${selected.length} baseline campaign${retired === 1 ? " was" : "s were"} ` +
        `deleted but spent in this window, and ${retired === 1 ? "it is" : "they are"} still counted as history.`,
    );
  }

  return {
    status: "ok",
    objective: campaign.objective,
    basis,
    basisReason: concurrent
      ? `${selected.length} campaign${selected.length === 1 ? "" : "s"} on this objective ran over the same days`
      : olderMembers.length > 0 && lookback
        ? `Compared against this objective's history back to ${monthLabel(lookback.fromDate)}`
        : `Compared against ${windowDays} days of history on this objective`,
    windowDays,
    lookback:
      olderMembers.length > 0 && lookback
        ? {
            fromDate: lookback.fromDate,
            toDate: lookback.toDate,
            campaigns: olderMembers.length,
          }
        : null,
    lookbackReason: lookback?.reason ?? null,
    campaignDays: ownDays.size,
    baselineDays: baselineDays.size,
    cohort: {
      campaigns: selected.length,
      spend: cohortSpend,
      concentration,
      largestName: spends[0]?.name ?? null,
      names: spends.map((entry) => entry.name),
    },
    metrics,
    volume: {
      spend: campaignTotals.spend,
      impressions: campaignTotals.impressions,
      clicks: campaignTotals.clicks,
      installs: campaignTotals.installs,
      spendShare:
        cohortSpend + campaignTotals.spend > 0
          ? campaignTotals.spend / (cohortSpend + campaignTotals.spend)
          : 0,
    },
    notes,
  };
}
