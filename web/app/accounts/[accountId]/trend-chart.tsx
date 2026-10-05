"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
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

export type TrendMetric = {
  key: string;
  label: string;
  values: number[];
  kind: "currency" | "count";
};

const PRIMARY = "#1d9bf0";
const SECONDARY = "#f59e0b";

export function TrendChart({
  dates,
  metrics,
  currency,
  provisionalDays,
}: {
  dates: string[];
  metrics: TrendMetric[];
  currency: string | null;
  provisionalDays: number;
}) {
  const [primaryKey, setPrimaryKey] = useState(metrics[0]?.key ?? "");
  const [secondaryKey, setSecondaryKey] = useState<string | null>(null);

  const primary = metrics.find((metric) => metric.key === primaryKey) ?? metrics[0];
  const secondary = metrics.find((metric) => metric.key === secondaryKey) ?? null;

  const data = useMemo(
    () =>
      dates.map((date, index) => ({
        date,
        label: formatDayLabel(date),
        primary: primary?.values[index] ?? 0,
        secondary: secondary?.values[index] ?? 0,
      })),
    [dates, primary, secondary],
  );

  const firstProvisionalIndex = dates.length - provisionalDays;

  const formatValue = (value: number, kind: "currency" | "count") =>
    kind === "currency" ? formatCurrency(value, currency) : formatNumber(value);

  if (!primary) return null;

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Daily trend</h2>
          <p className="mt-0.5 text-xs text-muted">
            Account timezone. Pick a second metric to overlay it.
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {metrics.map((metric) => {
            const isPrimary = metric.key === primary.key;
            const isSecondary = metric.key === secondary?.key;
            return (
              <button
                key={metric.key}
                onClick={() => {
                  if (isPrimary) return;
                  // Clicking the overlaid metric promotes it; clicking a third swaps the overlay.
                  if (isSecondary) {
                    setSecondaryKey(primary.key);
                    setPrimaryKey(metric.key);
                    return;
                  }
                  setSecondaryKey(metric.key);
                }}
                className={cx(
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  isPrimary
                    ? "border-accent/40 bg-accent-soft text-accent"
                    : isSecondary
                      ? "border-warn/40 bg-warn/10 text-warn"
                      : "border-border text-muted hover:border-border-strong hover:text-ink",
                )}
              >
                {metric.label}
              </button>
            );
          })}
          {secondary ? (
            <button
              onClick={() => setSecondaryKey(null)}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:text-ink"
            >
              Clear overlay
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-5 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="primaryFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.28} />
                <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--color-muted)" }}
              stroke="var(--color-border)"
              tickLine={false}
              axisLine={false}
              minTickGap={16}
            />
            <YAxis
              yAxisId="primary"
              tick={{ fontSize: 11, fill: "var(--color-muted)" }}
              stroke="var(--color-border)"
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) =>
                primary.kind === "currency"
                  ? formatCompactCurrency(value, currency)
                  : formatCompact(value)
              }
            />
            {secondary ? (
              <YAxis
                yAxisId="secondary"
                orientation="right"
                tick={{ fontSize: 11, fill: "var(--color-muted)" }}
                stroke="var(--color-border)"
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(value: number) =>
                  secondary.kind === "currency"
                    ? formatCompactCurrency(value, currency)
                    : formatCompact(value)
                }
              />
            ) : null}

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
              labelFormatter={(label) => {
                const index = data.findIndex((row) => row.label === label);
                // Trailing days may still be revised by billing; say so in the tooltip.
                return index >= firstProvisionalIndex ? `${label} · provisional` : label;
              }}
              formatter={(value, name) => {
                const metric = name === primary.label ? primary : secondary;
                return [formatValue(Number(value) || 0, metric?.kind ?? "count"), name];
              }}
            />
            <Legend
              verticalAlign="top"
              height={28}
              iconType="plainline"
              wrapperStyle={{ fontSize: 12 }}
            />

            <Area
              yAxisId="primary"
              type="monotone"
              dataKey="primary"
              name={primary.label}
              stroke={PRIMARY}
              strokeWidth={2}
              fill="url(#primaryFill)"
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            {secondary ? (
              <Line
                yAxisId="secondary"
                type="monotone"
                dataKey="secondary"
                name={secondary.label}
                stroke={SECONDARY}
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            ) : null}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
