"use client";

import { useState } from "react";
import {
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { cx } from "@/components/ui";
import {
  formatCompactCurrency,
  formatCurrency,
  formatPercent,
  formatUnitCost,
} from "@/lib/format";
import { SERIES_COLORS } from "../metrics";
import type { CampaignRow } from "../types";

type Axis = {
  key: string;
  label: string;
  value: (row: CampaignRow) => number;
  format: (value: number, currency: string | null) => string;
  /** Cheaper or more efficient sits toward this end of the axis. */
  better: "higher" | "lower";
};

const AXES: Axis[] = [
  {
    key: "ctr",
    label: "CTR",
    value: (row) => row.totals.ctr,
    format: (v) => formatPercent(v),
    better: "higher",
  },
  {
    key: "engagementRate",
    label: "Engagement rate",
    value: (row) => row.totals.engagementRate,
    format: (v) => formatPercent(v),
    better: "higher",
  },
  {
    key: "cpe",
    label: "CPE",
    value: (row) => row.totals.cpe,
    format: (v, c) => formatUnitCost(v, c),
    better: "lower",
  },
  {
    key: "cpm",
    label: "CPM",
    value: (row) => row.totals.cpm,
    format: (v, c) => formatUnitCost(v, c),
    better: "lower",
  },
];

export function CompareScatter({
  campaigns,
  currency,
}: {
  campaigns: CampaignRow[];
  currency: string | null;
}) {
  const [axisKey, setAxisKey] = useState("ctr");
  const axis = AXES.find((entry) => entry.key === axisKey) ?? AXES[0]!;

  const points = campaigns.map((campaign, index) => ({
    id: campaign.id,
    name: campaign.name,
    spend: campaign.totals.spend,
    efficiency: axis.value(campaign),
    color: SERIES_COLORS[index % SERIES_COLORS.length],
  }));

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Spend against efficiency</h2>
          <p className="mt-0.5 text-xs text-muted">
            {axis.better === "higher"
              ? "Higher and further right means a large campaign that is also performing."
              : "Lower and further right means a large campaign that is also cheap."}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {AXES.map((entry) => (
            <button
              key={entry.key}
              onClick={() => setAxisKey(entry.key)}
              className={cx(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                entry.key === axis.key
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-border text-muted hover:border-border-strong hover:text-ink",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
            <CartesianGrid stroke="var(--color-border)" />
            <XAxis
              type="number"
              dataKey="spend"
              name="Spend"
              tick={{ fontSize: 11, fill: "var(--color-muted)" }}
              stroke="var(--color-border)"
              tickLine={false}
              tickFormatter={(value: number) => formatCompactCurrency(value, currency)}
              label={{
                value: "Spend",
                position: "insideBottom",
                offset: -14,
                fill: "var(--color-muted)",
                fontSize: 11,
              }}
            />
            <YAxis
              type="number"
              dataKey="efficiency"
              name={axis.label}
              tick={{ fontSize: 11, fill: "var(--color-muted)" }}
              stroke="var(--color-border)"
              tickLine={false}
              width={64}
              tickFormatter={(value: number) => axis.format(value, currency)}
            />
            {/* Fixed dot size; the third dimension is not meaningful here. */}
            <ZAxis range={[140, 140]} />
            <Tooltip
              contentStyle={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border-strong)",
                borderRadius: 12,
                fontSize: 12,
                color: "var(--color-ink)",
              }}
              formatter={(value, name) => [
                name === "Spend"
                  ? formatCurrency(Number(value) || 0, currency)
                  : axis.format(Number(value) || 0, currency),
                name,
              ]}
              labelFormatter={() => ""}
              content={({ payload }) => {
                const point = payload?.[0]?.payload as (typeof points)[number] | undefined;
                if (!point) return null;
                return (
                  <div className="rounded-xl border border-border-strong bg-surface px-3 py-2 text-xs">
                    <div className="font-semibold text-ink">{point.name}</div>
                    <div className="nums mt-1 text-muted">
                      Spend {formatCurrency(point.spend, currency)}
                    </div>
                    <div className="nums text-muted">
                      {axis.label} {axis.format(point.efficiency, currency)}
                    </div>
                  </div>
                );
              }}
            />
            <Scatter data={points} isAnimationActive={false}>
              {points.map((point) => (
                <Cell key={point.id} fill={point.color} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
