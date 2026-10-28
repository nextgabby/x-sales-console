"use client";

import { cx, Sparkline } from "@/components/ui";
import { formatDelta } from "@/lib/format";
import type { Totals } from "@/lib/x/stats";
import { METRICS, metricApplies } from "./metrics";

/** The optional metrics a rep can turn on. Core tiles stay on without a chip. */
export function MetricChoices({
  totals,
  optionalKeys,
  onToggleOptional,
}: {
  totals: Totals;
  optionalKeys: string[];
  onToggleOptional: (key: string) => void;
}) {
  const chosen = new Set(optionalKeys);
  const choices = METRICS.filter(
    (spec) => spec.when && (metricApplies(spec, totals) || chosen.has(spec.key)),
  );
  if (choices.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-muted">Also show</span>
      {choices.map((spec) => {
        const on = chosen.has(spec.key);
        return (
          <button
            key={spec.key}
            type="button"
            aria-pressed={on}
            title={spec.hint ?? spec.label}
            onClick={() => onToggleOptional(spec.key)}
            className={cx(
              "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
              on
                ? "border-accent bg-accent text-white"
                : "border-border bg-surface text-muted hover:text-ink",
            )}
          >
            {spec.label}
          </button>
        );
      })}
    </div>
  );
}

export function KpiTiles({
  totals,
  previousTotals,
  currency,
  spendSeries,
  rangeDays,
  comparable,
  optionalKeys,
  onToggleOptional,
}: {
  totals: Totals;
  previousTotals: Totals;
  currency: string | null;
  spendSeries: number[];
  rangeDays: number;
  /**
   * Whether the prior window is a baseline at all. When nothing ran in it, every delta is "New"
   * against zero on every tile, which reads as a broken page rather than as an account that
   * started spending recently. The caller explains it once instead.
   */
  comparable: boolean;
  /** Optional tiles currently on, such as CPI or CPV. Core tiles are always on. */
  optionalKeys: string[];
  onToggleOptional: (key: string) => void;
}) {
  const chosen = new Set(optionalKeys);
  const specs = METRICS.filter((spec) => !spec.when || chosen.has(spec.key));

  return (
    <div className="space-y-3">
      <MetricChoices
        totals={totals}
        optionalKeys={optionalKeys}
        onToggleOptional={onToggleOptional}
      />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {specs.map((spec) => {
          const current = spec.value(totals);
          const previous = spec.value(previousTotals);
          const delta = formatDelta(current, previous, spec.direction === "lower");
          const isSpend = spec.key === "spend";

          return (
            <div
              key={spec.key}
              className="rise rounded-2xl border border-border bg-surface p-4"
              title={spec.hint}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium tracking-wide text-muted uppercase">
                  {spec.label}
                </span>
                {comparable ? (
                  <span
                    className={cx(
                      "nums text-[11px] font-semibold",
                      delta.tone === "positive"
                        ? "text-positive"
                        : delta.tone === "negative"
                          ? "text-negative"
                          : "text-muted",
                    )}
                  >
                    {delta.label}
                  </span>
                ) : null}
              </div>

              <div className="nums mt-2 text-2xl font-bold tracking-tight">
                {spec.format(current, currency)}
              </div>

              {/*
                Spend carries the sparkline because when the money went out matters as much as the
                total: a period that doubled on one burst and one that ramped steadily read the same
                from a single figure. It keeps the comparison line too, being the number a rep is
                most likely to say out loud.
              */}
              {isSpend ? (
                <Sparkline values={spendSeries} className="mt-2 h-7 w-full text-accent" />
              ) : null}

              {comparable ? (
                <div className="mt-2 text-[11px] text-muted">
                  vs {spec.format(previous, currency)} prior {rangeDays}d
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}
