import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatUnitCost,
} from "@/lib/format";
import type { Totals } from "@/lib/x/stats";

/**
 * Whether a bigger number is better. Spend is `neutral` on purpose — outspending another
 * campaign is not winning, so highlighting the biggest spender would be misleading.
 */
export type MetricDirection = "higher" | "lower" | "neutral";

export type MetricSpec = {
  key: string;
  label: string;
  value: (totals: Totals) => number;
  format: (value: number, currency: string | null) => string;
  direction: MetricDirection;
  /**
   * Omitted from the default tiles until the account actually produced that result, or the rep
   * asks for it. Video used to be the only case; cost per install is the same kind of choice.
   */
  when?: "video" | "install" | "follow" | "reengage";
  hint?: string;
};

export const METRICS: MetricSpec[] = [
  {
    key: "spend",
    label: "Spend",
    value: (t) => t.spend,
    format: (v, c) => formatCurrency(v, c),
    direction: "neutral",
  },
  {
    key: "impressions",
    label: "Impressions",
    value: (t) => t.impressions,
    format: (v) => formatNumber(v),
    direction: "higher",
  },
  {
    key: "engagements",
    label: "Engagements",
    value: (t) => t.engagements,
    format: (v) => formatNumber(v),
    direction: "higher",
  },
  {
    key: "engagementRate",
    label: "Engagement rate",
    value: (t) => t.engagementRate,
    format: (v) => formatPercent(v),
    direction: "higher",
    hint: "Engagements ÷ impressions",
  },
  {
    key: "clicks",
    label: "Clicks",
    value: (t) => t.clicks,
    format: (v) => formatNumber(v),
    direction: "higher",
  },
  {
    key: "ctr",
    label: "CTR",
    value: (t) => t.ctr,
    format: (v) => formatPercent(v),
    direction: "higher",
    hint: "Clicks ÷ impressions",
  },
  {
    key: "cpm",
    label: "CPM",
    value: (t) => t.cpm,
    format: (v, c) => formatUnitCost(v, c),
    direction: "lower",
    hint: "Cost per 1,000 impressions",
  },
  {
    key: "cpe",
    label: "CPE",
    value: (t) => t.cpe,
    format: (v, c) => formatUnitCost(v, c),
    direction: "lower",
    hint: "Cost per engagement",
  },
  {
    key: "cpc",
    label: "CPC",
    value: (t) => t.cpc,
    format: (v, c) => formatUnitCost(v, c),
    direction: "lower",
    hint: "Cost per click",
  },
  {
    key: "installs",
    label: "Installs",
    value: (t) => t.installs,
    format: (v) => formatNumber(v),
    direction: "higher",
    when: "install",
    hint: "App installs, post-view plus post-engagement",
  },
  {
    key: "costPerInstall",
    label: "CPI",
    value: (t) => t.costPerInstall,
    format: (v, c) => formatUnitCost(v, c),
    direction: "lower",
    when: "install",
    hint: "Cost per install",
  },
  {
    key: "follows",
    label: "Follows",
    value: (t) => t.follows,
    format: (v) => formatNumber(v),
    direction: "higher",
    when: "follow",
  },
  {
    key: "cpf",
    label: "CPF",
    value: (t) => t.cpf,
    format: (v, c) => formatUnitCost(v, c),
    direction: "lower",
    when: "follow",
    hint: "Cost per follow",
  },
  {
    key: "reEngages",
    label: "Re-engages",
    value: (t) => t.reEngages,
    format: (v) => formatNumber(v),
    direction: "higher",
    when: "reengage",
  },
  {
    key: "costPerReEngage",
    label: "CPRE",
    value: (t) => t.costPerReEngage,
    format: (v, c) => formatUnitCost(v, c),
    direction: "lower",
    when: "reengage",
    hint: "Cost per re-engagement",
  },
  {
    key: "videoViews",
    label: "Video views",
    value: (t) => t.videoViews,
    format: (v) => formatNumber(v),
    direction: "higher",
    when: "video",
  },
  {
    key: "viewRate",
    label: "View rate",
    value: (t) => t.viewRate,
    format: (v) => formatPercent(v),
    direction: "higher",
    when: "video",
    hint: "Views ÷ impressions",
  },
  {
    key: "cpv",
    label: "CPV",
    value: (t) => t.cpv,
    format: (v, c) => formatUnitCost(v, c),
    direction: "lower",
    when: "video",
    hint: "Cost per view",
  },
  {
    key: "completions",
    label: "Completions",
    value: (t) => t.videoViews100,
    format: (v) => formatNumber(v),
    direction: "higher",
    when: "video",
    hint: "Reached 100% of the video",
  },
];

/** Whether this metric has a denominator on these totals. A zero tile is not a result. */
export function metricApplies(spec: MetricSpec, totals: Totals): boolean {
  switch (spec.when) {
    case undefined:
      return true;
    case "video":
      return totals.videoViews > 0;
    case "install":
      return totals.installs > 0;
    case "follow":
      return totals.follows > 0;
    case "reengage":
      return totals.reEngages > 0;
    default: {
      const exhaustive: never = spec.when;
      return exhaustive;
    }
  }
}

/**
 * Extra tiles for the objective on screen. App installs lead with cost per install rather than
 * cost per view; with no objective selected, video tiles stay up when the account has views,
 * which is what the page did before the tiles could be changed.
 */
const OBJECTIVE_TILES: Record<string, NonNullable<MetricSpec["when"]>[]> = {
  APP_INSTALLS: ["install"],
  APP_ENGAGEMENTS: ["reengage"],
  APP_RE_ENGAGEMENTS: ["reengage"],
  FOLLOWERS: ["follow"],
  VIDEO_VIEWS: ["video"],
  PREROLL_VIEWS: ["video"],
};

export function defaultOptionalKeys(totals: Totals, objective: string | null): string[] {
  const groups = new Set<NonNullable<MetricSpec["when"]>>();
  const named = objective ? OBJECTIVE_TILES[objective] : undefined;
  if (named) {
    for (const group of named) groups.add(group);
  } else if (totals.videoViews > 0) {
    groups.add("video");
  }
  return METRICS.filter(
    (spec) => spec.when && groups.has(spec.when) && metricApplies(spec, totals),
  ).map((spec) => spec.key);
}

/** Optional metrics the rep has turned on, in display order. */
export function chosenOptionalMetrics(keys: string[]): MetricSpec[] {
  const chosen = new Set(keys);
  return METRICS.filter((spec) => spec.when && chosen.has(spec.key));
}

/** `null` means the rep has not chosen, so the objective default applies. */
export function optionalKeysFromParam(
  value: string | null,
  totals: Totals,
  objective: string | null,
): string[] {
  if (value === null) return defaultOptionalKeys(totals, objective);
  const known = new Set(METRICS.filter((spec) => spec.when).map((spec) => spec.key));
  return value
    .split(",")
    .map((key) => key.trim())
    .filter((key) => known.has(key));
}

/** Distinct enough to tell apart on a line chart and on a dark background. */
export const SERIES_COLORS = [
  "#1d9bf0",
  "#f59e0b",
  "#00ba7c",
  "#e879f9",
  "#f4212e",
  "#22d3ee",
  "#a3e635",
  "#fb923c",
];

/** Beyond this the chart stops being readable and the colours start repeating. */
export const MAX_COMPARE = SERIES_COLORS.length;

/**
 * Which of several values wins, or null when the metric has no direction, every value is
 * identical, or there is nothing to compare.
 */
export function bestIndex(values: number[], direction: MetricDirection): number | null {
  if (direction === "neutral" || values.length < 2) return null;
  const usable = values.filter((value) => Number.isFinite(value) && value > 0);
  if (usable.length === 0) return null;
  if (new Set(values).size === 1) return null;

  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    const candidate = values[index]!;
    const incumbent = values[best]!;
    // A zero cost means "never charged", not "cheapest", so it never wins a lower-is-better row.
    if (direction === "lower") {
      if (incumbent <= 0 || (candidate > 0 && candidate < incumbent)) best = index;
    } else if (candidate > incumbent) {
      best = index;
    }
  }
  return values[best]! > 0 ? best : null;
}
