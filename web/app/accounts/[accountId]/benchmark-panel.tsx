"use client";

import { useQuery } from "@tanstack/react-query";

import { AskGrok } from "@/components/ask-grok";
import { Badge, Callout, cx, Skeleton } from "@/components/ui";
import { formatCurrency, formatNumber, formatPercent, formatUnitCost, titleCase } from "@/lib/format";
import type { Benchmark, BenchmarkMetric } from "@/lib/x/benchmark";

const BENCHMARK_SUGGESTIONS = [
  "Is this campaign a good buy for this brand?",
  "The CPM and the objective KPI disagree — which should I believe?",
  "How much weight does this comparison actually deserve?",
  "What should I take into the advertiser conversation?",
];

type BenchmarkResponse = {
  currency: string | null;
  campaignName: string;
  benchmark: Benchmark;
};

/**
 * How this campaign compares to what the brand itself normally gets for the same objective.
 *
 * Fetched separately from the rest of the drawer because it costs a 90-day account build, and
 * enabled only when the drawer is open so a rep scanning the table never pays for it.
 */
export function BenchmarkPanel({
  accountId,
  campaignId,
  asUser,
}: {
  accountId: string;
  campaignId: string;
  asUser: string | null;
}) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["benchmark", accountId, campaignId, asUser ?? "direct"],
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (asUser) params.set("asUser", asUser);
      const response = await fetch(
        `/api/accounts/${accountId}/campaigns/${campaignId}/benchmark?${params.toString()}`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not load the brand's history.");
      return payload as BenchmarkResponse;
    },
  });

  return (
    <section>
      <header>
        <h3 className="text-sm font-semibold text-ink">Versus this brand&rsquo;s own history</h3>
        <p className="mt-0.5 text-xs text-muted">
          The advertiser&rsquo;s own campaigns on the same objective, excluding this one and any
          takeovers. The last 90 days, reaching back up to a year when that is too thin.
        </p>
      </header>

      <div className="mt-3">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : isError ? (
          <Callout tone="warn">{(error as Error).message}</Callout>
        ) : data ? (
          <Body
            response={data}
            accountId={accountId}
            campaignId={campaignId}
            asUser={asUser}
          />
        ) : null}
      </div>
    </section>
  );
}

function Body({
  response,
  accountId,
  campaignId,
  asUser,
}: {
  response: BenchmarkResponse;
  accountId: string;
  campaignId: string;
  asUser: string | null;
}) {
  const { benchmark: b, currency } = response;

  if (b.status !== "ok") {
    return (
      <div className="space-y-2">
        <Callout tone="warn">{explain(b)}</Callout>
        {/*
          Rendered here too, because the one note that can accompany a failure is the one that
          explains it: a custom buy whose only company on this objective is other custom buys has
          no standard baseline, and "no comparable campaign" on its own sends a rep looking for a
          data problem that is not there.
        */}
        {b.notes.map((note) => (
          <p key={note} className="text-[11px] leading-relaxed text-muted">
            {note}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={b.basis === "concurrent" ? "accent" : b.lookback ? "warn" : "neutral"}>
              {b.basis === "concurrent"
                ? "Same days"
                : b.lookback
                  ? `Back to ${monthLabel(b.lookback.fromDate)}`
                  : `${b.windowDays}-day history`}
            </Badge>
            {b.objective ? <Badge tone="neutral">{titleCase(b.objective)}</Badge> : null}
            {/*
              Named on the row itself, not only in the note below. Every percentage in this panel
              means something different once the cohort is standard buys only, and the rep reading
              "18% better CPE" needs to know it is better than regular rather than better than
              average before they repeat it to the advertiser.
            */}
            {b.customComparison ? (
              <Badge tone="accent">
                {b.customComparison.kind === "l4r" ? "L4R" : "Custom"} vs standard
              </Badge>
            ) : null}
          </div>
          <p className="text-[11px] text-muted">
            {b.cohort.campaigns} campaign{b.cohort.campaigns === 1 ? "" : "s"} ·{" "}
            {formatCurrency(b.cohort.spend, currency)} of history
          </p>
        </div>

        <div className="divide-y divide-border">
          {b.metrics.map((metric) => (
            <MetricRow key={metric.key} metric={metric} currency={currency} />
          ))}
        </div>

        <footer className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted">
          {b.basisReason}. This campaign delivered on {b.campaignDays} day
          {b.campaignDays === 1 ? "" : "s"}.
          {b.volume ? (
            <>
              {" "}
              It is {formatPercent(b.volume.spendShare, 0)} of the brand&rsquo;s spend on this
              objective
              {b.volume.installs > 0 ? `, and drove ${formatNumber(b.volume.installs)} installs` : ""}
              .
            </>
          ) : null}
        </footer>
      </div>

      {b.notes.map((note) => (
        <p key={note} className="text-[11px] leading-relaxed text-muted">
          {note}
        </p>
      ))}

      <AskGrok
        endpoint={`/api/accounts/${accountId}/campaigns/${campaignId}/benchmark-summary`}
        body={{ asUser }}
        title="Ask Grok about this comparison"
        description="Every comparison above is computed from the API figures, not by the model."
        primaryLabel="Explain the comparison"
        emptyState="Nothing generated yet. Explain the comparison, or ask whether the objective KPI or the CPM read should win."
        suggestions={BENCHMARK_SUGGESTIONS}
        askPlaceholder="Ask about this comparison…"
        unconfiguredHint="Add your own xAI API key to have this comparison explained."
      />
    </div>
  );
}

function MetricRow({
  metric,
  currency,
}: {
  metric: BenchmarkMetric;
  currency: string | null;
}) {
  const show = (value: number) =>
    metric.format === "currency"
      ? formatUnitCost(value, currency)
      : formatPercent(value);

  // A negative delta is good for a cost and bad for a rate, so the sign alone cannot pick a colour.
  const better = metric.delta == null ? null : metric.delta < 0 === metric.lowerIsBetter;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p
          className={cx(
            "truncate text-sm",
            metric.primary ? "font-semibold text-ink" : "text-ink",
          )}
        >
          {metric.label}
          {metric.primary ? (
            <span className="ml-2 text-[10px] font-medium tracking-wide text-accent uppercase">
              objective KPI
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          {metric.band ? (
            <>
              usually{" "}
              <span className="nums text-ink">
                {show(metric.band.low)}&ndash;{show(metric.band.high)}
              </span>{" "}
              across {metric.band.sample} campaigns · {show(metric.baseline)} weighted
              {/*
                Said only when the campaign falls outside the range, because that is the case where
                the delta against the weighted figure can read the opposite way — a campaign can be
                cheaper than what the brand pays overall and still dearer than its typical campaign.
              */}
              {metric.position === "above" || metric.position === "below" ? (
                <span className={metric.lowerIsBetter === (metric.position === "below") ? "text-positive" : "text-negative"}>
                  {" "}· {metric.position} the usual range
                </span>
              ) : null}
            </>
          ) : (
            <>brand normally {show(metric.baseline)}</>
          )}
        </p>
      </div>

      <div className="nums flex shrink-0 items-center gap-3 text-right">
        <span className="text-sm font-semibold text-ink">{show(metric.campaign)}</span>
        <span
          className={cx(
            "w-16 text-xs font-semibold",
            better == null ? "text-muted" : better ? "text-positive" : "text-negative",
          )}
        >
          {metric.delta == null
            ? "—"
            : `${metric.delta > 0 ? "+" : ""}${Math.round(metric.delta * 100)}%`}
        </span>
      </div>
    </div>
  );
}

/** Joins a sentence onto a clause, since the reasons are written to stand alone. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "Oct 2025", short because it sits in a badge. */
function monthLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Each of these is a refusal rather than a fallback. Comparing a campaign to a cohort it does not
 * belong to would produce a confident number that means nothing, which is worse than a blank.
 */
function explain(b: Benchmark): string {
  switch (b.status) {
    case "no-objective":
      return "The Ads API reports no objective for this campaign, so there is no comparable history to measure it against.";
    case "no-cohort":
      // Saying the older period was searched matters: otherwise this reads as a 90-day limitation
      // that a rep might reasonably expect to be worked around.
      return (
        `No other campaign in this account ran on the same objective in the last ${b.windowDays} days` +
        (b.lookbackReason
          ? `, and the year before was searched as well — ${lowerFirst(b.lookbackReason)}`
          : ", so there is no history to compare against.")
      );
    case "no-delivery":
      return "This campaign did not deliver in the window, so there is nothing to compare.";
    default:
      return "No comparison available.";
  }
}
