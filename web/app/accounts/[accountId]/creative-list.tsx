"use client";

import { useState } from "react";

import { Badge, Sparkline } from "@/components/ui";
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatUnitCost,
} from "@/lib/format";
import {
  bestByCtr,
  isRankable,
  MIN_CLICKS_TO_RANK,
} from "@/lib/x/creatives";
import type { MetricSpec } from "./metrics";
import type { Totals } from "@/lib/x/stats";
import type { PromotedPostRow } from "./types";

/** Rows shown before collapsing. Campaigns with 200 creatives are normal. */
const VISIBLE_LIMIT = 10;

export function CreativeList({
  posts,
  currency,
  extras,
}: {
  posts: PromotedPostRow[];
  currency: string | null;
  /** Metrics the campaign has turned on, such as CPI or video views. */
  extras: MetricSpec[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const delivered = posts.filter((post) => post.totals.impressions > 0);
  const inactive = posts.length - delivered.length;
  // Best click-through among creatives tested enough for the rate to mean something.
  const eligible = delivered.filter(isRankable);
  const bestCtr = bestByCtr(delivered);

  /**
   * Rest ordered by spend, but the best performer goes first. On a 187-creative campaign it ranked
   * about thirtieth by spend, so the badge marking the creative worth making more of sat well below
   * the fold — the one thing in this list a rep would act on, invisible.
   */
  const base = showInactive ? posts : delivered;
  const listed = bestCtr
    ? [bestCtr, ...base.filter((post) => post.id !== bestCtr.id)]
    : base;
  // A campaign can carry hundreds of creatives; an unbounded list is unscannable.
  const visible = showAll ? listed : listed.slice(0, VISIBLE_LIMIT);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">
          Creatives{" "}
          <span className="font-normal text-muted">({delivered.length} delivering)</span>
        </h3>
        {inactive > 0 ? (
          <button
            onClick={() => setShowInactive((previous) => !previous)}
            className="text-xs font-semibold text-muted transition-colors hover:text-ink"
          >
            {showInactive ? "Hide" : "Show"} {inactive} with no delivery
          </button>
        ) : null}
      </div>

      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        {eligible.length > 1 && bestCtr
          ? `Best performer first, then by spend. Ranked across ${eligible.length} creatives with at least ${formatNumber(
              MIN_CLICKS_TO_RANK,
            )} clicks — less-delivered ones are listed but not ranked, since a handful of clicks moves their rate too much to compare.`
          : `No creative here has the ${formatNumber(
              MIN_CLICKS_TO_RANK,
            )} clicks needed to compare rates reliably, so none is marked best.`}
      </p>

      <div className="mt-3 space-y-2">
        {visible.map((post) => (
          <article
            key={post.id}
            className="rounded-xl border border-border bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  {post.id === bestCtr?.id ? (
                    <Badge tone="positive">Best CTR</Badge>
                  ) : null}
                  {post.approvalStatus && post.approvalStatus !== "ACCEPTED" ? (
                    <Badge tone="negative">{post.approvalStatus}</Badge>
                  ) : null}
                  {post.lineItemName ? (
                    <span className="text-[11px] text-muted">{post.lineItemName}</span>
                  ) : null}
                </div>
                <p className="mt-1.5 line-clamp-3 text-sm text-ink">
                  {post.text ?? "Post text unavailable."}
                </p>
              </div>
              <Sparkline
                values={post.spendSeries}
                className="h-6 w-16 shrink-0 text-accent"
              />
            </div>

            <dl className="nums mt-3 grid grid-cols-4 gap-2 text-xs">
              <Cell label="Spend" value={formatCurrency(post.totals.spend, currency)} />
              <Cell label="Impr." value={formatNumber(post.totals.impressions)} />
              <Cell label="CTR" value={formatPercent(post.totals.ctr)} />
              <Cell label="CPM" value={formatUnitCost(post.totals.cpm, currency)} />
              {extras.map((spec) => (
                <Cell
                  key={spec.key}
                  label={spec.label}
                  value={formatMetric(spec, post.totals, currency)}
                />
              ))}
            </dl>

            <div className="mt-3 flex items-center gap-3 text-[11px]">
              {post.previewUrl ? (
                <button
                  onClick={() =>
                    setExpanded((current) => (current === post.id ? null : post.id))
                  }
                  className="font-semibold text-muted transition-colors hover:text-ink"
                >
                  {expanded === post.id ? "Hide preview" : "Preview creative"}
                </button>
              ) : null}
              {post.tweetId ? (
                <a
                  href={`https://x.com/${post.authorHandle ?? "i"}/status/${post.tweetId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-muted transition-colors hover:text-accent"
                >
                  Open on X ↗
                </a>
              ) : null}
            </div>

            {/* Mounted only when asked for: these are third-party iframes, one per creative. */}
            {expanded === post.id && post.previewUrl ? (
              <iframe
                src={post.previewUrl}
                title={`Creative preview for ${post.id}`}
                sandbox="allow-scripts"
                loading="lazy"
                className="mt-3 h-[480px] w-full rounded-lg border border-border bg-canvas"
              />
            ) : null}
          </article>
        ))}

        {visible.length === 0 ? (
          <p className="text-sm text-muted">No creatives delivered in this range.</p>
        ) : null}

        {listed.length > VISIBLE_LIMIT ? (
          <button
            onClick={() => setShowAll((previous) => !previous)}
            className="text-xs font-semibold text-muted transition-colors hover:text-ink"
          >
            {showAll ? `Show top ${VISIBLE_LIMIT}` : `Show all ${listed.length}`}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function formatMetric(spec: MetricSpec, totals: Totals, currency: string | null): string {
  const value = spec.value(totals);
  if (spec.direction === "lower" && value <= 0) return "—";
  return spec.format(value, currency);
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 font-semibold text-ink">{value}</dd>
    </div>
  );
}
