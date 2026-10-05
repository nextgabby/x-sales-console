"use client";

import { Skeleton } from "@/components/ui";
import { buildInsights } from "@/lib/x/insights";
import { useSegments, type SegmentsQuery } from "./use-segments";

/**
 * The handful of things worth saying about this campaign's delivery.
 *
 * Every line is arithmetic over the figures in the panels below, computed by `buildInsights` rather
 * than written by a model, so an insight can never contradict the chart it sits above. Renders
 * nothing when the data does not support a claim — an empty section is better than a filler one.
 */
export function InsightsPanel({
  currency,
  ...query
}: SegmentsQuery & { currency: string | null }) {
  const { data, isLoading } = useSegments(query);

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data) return null;

  const insights = buildInsights({
    platform: data.breakdown,
    audience: data.audience,
    currency,
  });
  if (insights.length === 0) return null;

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <header className="flex items-center gap-2">
        <CheckIcon />
        <h3 className="text-sm font-semibold text-ink">Insights</h3>
      </header>

      <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {insights.map((insight) => (
          <div key={insight.title} className="text-xs leading-relaxed">
            <dt className="inline font-semibold text-ink">{insight.title}</dt>{" "}
            <dd className="inline text-muted">{insight.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4 text-positive" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6.5 10.25l2.4 2.4 4.6-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
