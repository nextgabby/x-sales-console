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
  /** Only shown when the campaigns being compared produced video metrics. */
  video?: boolean;
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
    key: "videoViews",
    label: "Video views",
    value: (t) => t.videoViews,
    format: (v) => formatNumber(v),
    direction: "higher",
    video: true,
  },
  {
    key: "viewRate",
    label: "View rate",
    value: (t) => t.viewRate,
    format: (v) => formatPercent(v),
    direction: "higher",
    video: true,
    hint: "Views ÷ impressions",
  },
  {
    key: "cpv",
    label: "CPV",
    value: (t) => t.cpv,
    format: (v, c) => formatUnitCost(v, c),
    direction: "lower",
    video: true,
    hint: "Cost per view",
  },
  {
    key: "completions",
    label: "Completions",
    value: (t) => t.videoViews100,
    format: (v) => formatNumber(v),
    direction: "higher",
    video: true,
    hint: "Reached 100% of the video",
  },
];

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
