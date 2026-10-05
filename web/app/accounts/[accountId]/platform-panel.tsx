"use client";

import { Badge, Callout, cx, Skeleton } from "@/components/ui";
import { formatCurrency, formatNumber, formatPercent, formatUnitCost } from "@/lib/format";
import type { SegmentBreakdown, SegmentRow, SpotlightSplit } from "@/lib/x/segments";
import { useSegments, type SegmentsQuery } from "./use-segments";

/**
 * Where a campaign's money went by platform.
 *
 * Loaded separately from the drawer because segmented figures come only from the asynchronous jobs
 * endpoint, which takes seconds: the drawer opens on the synchronous numbers and this fills in behind
 * it, sharing one request with the insights and audience panels.
 */
export function PlatformPanel({
  currency,
  ...query
}: SegmentsQuery & { currency: string | null }) {
  const { data, isLoading, isError, error } = useSegments(query);

  return (
    <section>
      <header>
        <h3 className="text-sm font-semibold text-ink">Where it ran</h3>
        <p className="mt-0.5 text-xs text-muted">
          The same spend split by the device people saw it on.
        </p>
      </header>

      <div className="mt-3">
        {isLoading ? (
          <Skeleton className="h-36 w-full" />
        ) : isError ? (
          <Callout tone="warn">{(error as Error).message}</Callout>
        ) : data ? (
          <Body breakdown={data.breakdown} currency={currency} />
        ) : null}
      </div>
    </section>
  );
}

function Body({
  breakdown,
  currency,
}: {
  breakdown: SegmentBreakdown;
  currency: string | null;
}) {
  if (breakdown.status !== "ok") {
    return <Callout tone="warn">{breakdown.reason ?? "No breakdown available."}</Callout>;
  }

  const { rows, efficiency, hasVideo } = breakdown;

  return (
    <div className="space-y-3">
      {efficiency ? (
        <Callout tone="neutral">
          {efficiency.material ? (
            <>
              {efficiency.cheapest.label} delivers the cheapest {efficiency.label} at{" "}
              {formatUnitCost(efficiency.cheapest.value, currency)}, against{" "}
              {formatUnitCost(efficiency.dearest.value, currency)} on {efficiency.dearest.label} —{" "}
              {formatPercent(efficiency.gap, 0)} more for the same thing, on{" "}
              {formatPercent(efficiency.dearest.spendShare, 0)} of the spend.
            </>
          ) : (
            <>
              Every platform is within {formatPercent(efficiency.gap, 0)} of the others on{" "}
              {efficiency.label}, so there is nothing to shift here.
            </>
          )}
        </Callout>
      ) : null}

      <div className="rounded-2xl border border-border bg-surface">
        <div className="divide-y divide-border">
          {rows.map((row) => (
            <PlatformRow
              key={row.key}
              row={row}
              currency={currency}
              hasVideo={hasVideo}
              leader={Boolean(efficiency?.material) && efficiency?.cheapest.label === row.label}
            />
          ))}
        </div>

        <footer className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted">
          {breakdown.reconciliation?.reconciles
            ? "Platform rows add up to the campaign's total spend."
            : "Read the shares rather than the absolute figures."}
        </footer>
      </div>

      {breakdown.spotlight ? (
        <Spotlight split={breakdown.spotlight} currency={currency} />
      ) : null}

      {breakdown.notes.map((note) => (
        <p key={note} className="text-[11px] leading-relaxed text-muted">
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * Spotlight delivery. Deliberately worded as a slice of the total rather than a row alongside the
 * platforms, because it is counted inside every figure above it and a rep must not add it on.
 */
function Spotlight({
  split,
  currency,
}: {
  split: SpotlightSplit;
  currency: string | null;
}) {
  const dearer = split.rest.cpm > 0 ? split.cpm / split.rest.cpm - 1 : 0;

  return (
    <div className="rounded-2xl border border-border bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">Spotlight</p>
        <p className="nums shrink-0 text-sm font-semibold text-ink">
          {formatCurrency(split.spend, currency)}
        </p>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        {formatPercent(split.spendShare, 0)} of this campaign&rsquo;s spend served in Spotlight, at{" "}
        {formatUnitCost(split.cpm, currency)} per thousand impressions against{" "}
        {formatUnitCost(split.rest.cpm, currency)} everywhere else —{" "}
        {Math.abs(dearer) < 0.05
          ? "much the same price"
          : `${formatPercent(Math.abs(dearer), 0)} ${dearer > 0 ? "dearer" : "cheaper"}`}
        . This is part of the totals above, not an addition to them.
      </p>
    </div>
  );
}

function PlatformRow({
  row,
  currency,
  hasVideo,
  leader,
}: {
  row: SegmentRow;
  currency: string | null;
  hasVideo: boolean;
  leader: boolean;
}) {
  const t = row.totals;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-semibold text-ink">{row.label}</p>
          {leader ? <Badge tone="positive">Cheapest</Badge> : null}
        </div>
        <p className="nums shrink-0 text-sm font-semibold text-ink">
          {formatCurrency(t.spend, currency)}
        </p>
      </div>

      {/* The share bar is the point of the row: it shows where the budget actually went. */}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={cx("h-full rounded-full", leader ? "bg-positive" : "bg-accent")}
          style={{ width: `${Math.max(row.spendShare * 100, 1)}%` }}
        />
      </div>

      <dl className="nums mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <Stat label="share" value={formatPercent(row.spendShare, 0)} />
        <Stat label="impressions" value={formatNumber(t.impressions)} />
        <Stat label="CPM" value={formatUnitCost(t.cpm, currency)} />
        {hasVideo ? (
          <>
            <Stat label="CPV" value={formatUnitCost(t.cpv, currency)} />
            <Stat label="view rate" value={formatPercent(t.viewRate)} />
          </>
        ) : (
          <Stat label="CTR" value={formatPercent(t.ctr)} />
        )}
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  );
}
