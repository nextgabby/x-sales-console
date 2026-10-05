"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cx } from "@/components/ui";
import {
  formatCompact,
  formatCompactCurrency,
  formatCurrency,
  formatDayLabel,
  formatNumber,
} from "@/lib/format";
import { SERIES_COLORS } from "../metrics";
import type { CampaignRow } from "../types";

type ChartMetric = { key: string; label: string; currency: boolean };

const CHART_METRICS: ChartMetric[] = [
  { key: "spend", label: "Spend", currency: true },
  { key: "impressions", label: "Impressions", currency: false },
  { key: "engagements", label: "Engagements", currency: false },
  { key: "clicks", label: "Clicks", currency: false },
  { key: "videoViews", label: "Video views", currency: false },
];

type Mode = "absolute" | "indexed";

export function CompareChart({
  campaigns,
  dates,
  currency,
}: {
  campaigns: CampaignRow[];
  dates: string[];
  currency: string | null;
}) {
  const [metricKey, setMetricKey] = useState("spend");
  const [mode, setMode] = useState<Mode>("absolute");

  const available = CHART_METRICS.filter((metric) =>
    campaigns.some((campaign) => (campaign.series?.[metric.key] ?? []).some((v) => v > 0)),
  );
  const metric =
    available.find((entry) => entry.key === metricKey) ?? available[0] ?? CHART_METRICS[0]!;

  const seriesFor = (campaign: CampaignRow) =>
    campaign.series?.[metric.key] ?? new Array(dates.length).fill(0);

  const data = useMemo(() => {
    if (mode === "absolute") {
      return dates.map((date, index) => {
        const row: Record<string, string | number> = { x: formatDayLabel(date) };
        for (const campaign of campaigns) {
          row[campaign.id] = seriesFor(campaign)[index] ?? 0;
        }
        return row;
      });
    }

    /**
     * Indexed mode rebases each campaign to 100 on its own first active day and plots against
     * days-since-launch rather than the calendar. Without it a campaign that started last week
     * looks like it collapsed, when really it simply had not started yet.
     */
    const rebased = campaigns.map((campaign) => {
      const values = seriesFor(campaign);
      const start = values.findIndex((value) => value > 0);
      if (start === -1) return { id: campaign.id, values: [] as number[] };
      const base = values[start]!;
      return {
        id: campaign.id,
        values: values.slice(start).map((value) => (value / base) * 100),
      };
    });

    const longest = Math.max(0, ...rebased.map((entry) => entry.values.length));
    return Array.from({ length: longest }, (_, offset) => {
      const row: Record<string, string | number> = { x: `Day ${offset + 1}` };
      for (const entry of rebased) {
        if (offset < entry.values.length) row[entry.id] = entry.values[offset]!;
      }
      return row;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaigns, dates, metric.key, mode]);

  const formatValue = (value: number) => {
    if (mode === "indexed") return `${Math.round(value)}`;
    return metric.currency ? formatCurrency(value, currency) : formatNumber(value);
  };

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Daily trend</h2>
          <p className="mt-0.5 text-xs text-muted">
            {mode === "absolute"
              ? "Actual values on the account's calendar."
              : "Each campaign rebased to 100 on its own first active day."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            {available.map((entry) => (
              <button
                key={entry.key}
                onClick={() => setMetricKey(entry.key)}
                className={cx(
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  entry.key === metric.key
                    ? "border-accent/40 bg-accent-soft text-accent"
                    : "border-border text-muted hover:border-border-strong hover:text-ink",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="flex rounded-full border border-border p-0.5">
            {(["absolute", "indexed"] as Mode[]).map((option) => (
              <button
                key={option}
                onClick={() => setMode(option)}
                className={cx(
                  "rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors",
                  option === mode ? "bg-accent text-white" : "text-muted hover:text-ink",
                )}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 h-80 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="x"
              tick={{ fontSize: 11, fill: "var(--color-muted)" }}
              stroke="var(--color-border)"
              tickLine={false}
              axisLine={false}
              minTickGap={16}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--color-muted)" }}
              stroke="var(--color-border)"
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) =>
                mode === "indexed"
                  ? String(Math.round(value))
                  : metric.currency
                    ? formatCompactCurrency(value, currency)
                    : formatCompact(value)
              }
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border-strong)",
                borderRadius: 12,
                fontSize: 12,
                color: "var(--color-ink)",
              }}
              labelStyle={{ color: "var(--color-muted)" }}
              cursor={{ stroke: "var(--color-border-strong)" }}
              formatter={(value, name) => [formatValue(Number(value) || 0), name]}
            />
            <Legend verticalAlign="top" height={30} iconType="plainline" wrapperStyle={{ fontSize: 12 }} />

            {campaigns.map((campaign, index) => (
              <Line
                key={campaign.id}
                type="monotone"
                dataKey={campaign.id}
                name={campaign.name}
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
