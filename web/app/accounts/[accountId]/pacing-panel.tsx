"use client";

import { useState } from "react";

import { Badge, cx } from "@/components/ui";
import { formatCompactCurrency, formatCurrency, formatPercent } from "@/lib/format";
import {
  dailyStake,
  type BudgetAdvice,
  type CampaignPacing,
  type PacingStatus,
} from "@/lib/x/pacing";
import { CAMPAIGN_LABEL_NAME, isBursty } from "@/lib/store/types";
import { isQuiet } from "./types";
import type { CampaignRow, PacingSummary } from "./types";

/** How many rows show before the panel collapses the rest. */
const VISIBLE_ROWS = 6;

const STATUS_LABEL: Record<PacingStatus, string> = {
  "on-pace": "On pace",
  underpacing: "Behind",
  overpacing: "Ahead",
  dark: "Stopped",
  idle: "Never delivered",
  ended: "Flight ended",
  scheduled: "Not started",
  paused: "Paused",
  "no-budget": "No budget set",
  unknown: "Unknown",
};

const STATUS_TONE: Record<PacingStatus, "neutral" | "positive" | "warn" | "negative"> = {
  "on-pace": "positive",
  underpacing: "negative",
  overpacing: "warn",
  dark: "negative",
  idle: "warn",
  ended: "neutral",
  scheduled: "neutral",
  paused: "neutral",
  "no-budget": "neutral",
  unknown: "neutral",
};

/** Statuses a rep should act on. Everything else is context, not a task. */
const ACTIONABLE = new Set<PacingStatus>(["dark", "underpacing", "idle", "overpacing"]);

/**
 * Ranked on two keys. Within a tier it is money at stake per day, so a big idle budget outranks a
 * small shortfall. The tier exists for bursty campaigns: a trend buy is often the largest daily
 * budget on the account and would otherwise head a panel of things to do today, having given up its
 * claim to be one of them. It stays above the healthy rows, because the commitment may still go
 * unspent, and sits below every campaign a rep can act on now. A custom creative label does not
 * demote anything, since those campaigns are as actionable as any other.
 */
function severity(pacing: CampaignPacing): { tier: number; stake: number } {
  if (!ACTIONABLE.has(pacing.status)) return { tier: 0, stake: 0 };
  // Overpacing stakes nothing but still belongs above the healthy rows.
  const stake = dailyStake(pacing) + (pacing.status === "overpacing" ? 0.01 : 0);
  return { tier: isBursty(pacing.label) ? 1 : 2, stake };
}

export function PacingPanel({
  summary,
  campaigns,
  currency,
}: {
  summary: PacingSummary;
  campaigns: CampaignRow[];
  currency: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  const ranked = campaigns
    .filter((row) => row.pacing.basis !== "none" || row.pacing.status === "ended")
    /**
     * Campaigns with no activity in the range sit behind a toggle in the campaign table, so
     * listing them here puts two panels on the same screen disagreeing about which campaigns the
     * account is running — hence the shared `isQuiet`. The exception is one that is live and funded
     * yet delivering nothing, which is the entire point of this panel and has no activity by
     * definition.
     */
    .filter((row) => !isQuiet(row) || ACTIONABLE.has(row.pacing.status))
    .map((row) => ({ row, score: severity(row.pacing) }))
    .sort((a, b) => b.score.tier - a.score.tier || b.score.stake - a.score.stake)
    .map(({ row }) => row);

  if (ranked.length === 0) return null;

  const shown = expanded ? ranked : ranked.slice(0, VISIBLE_ROWS);
  const hidden = ranked.length - shown.length;

  return (
    <section className="rounded-2xl border border-border bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Budget pacing</h2>
          <p className="mt-0.5 text-xs text-muted">
            Measured against each flight to date, not the selected range.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {summary.dark > 0 ? (
            <Badge tone="negative">
              {summary.dark} stopped · {formatCompactCurrency(summary.darkDailyBudget, currency)}/day
            </Badge>
          ) : null}
          {summary.idle > 0 ? (
            <Badge tone="warn">
              {summary.idle} never delivered ·{" "}
              {formatCompactCurrency(summary.idleDailyBudget, currency)}/day
            </Badge>
          ) : null}
        </div>
      </header>

      {summary.trackedCampaigns > 0 ? (
        <div className="grid gap-px border-b border-border bg-border sm:grid-cols-3">
          <Stat label="Committed" value={formatCurrency(summary.committedBudget, currency)} />
          <Stat
            label="Projected to spend"
            value={formatCurrency(summary.projectedSpend, currency)}
            hint={`at the current run rate across ${summary.trackedCampaigns} campaign${
              summary.trackedCampaigns === 1 ? "" : "s"
            }`}
          />
          <Stat
            label="Budget at risk"
            value={formatCurrency(summary.budgetAtRisk, currency)}
            tone={summary.budgetAtRisk > 0 ? "negative" : "positive"}
            hint={
              summary.budgetAtRisk > 0
                ? "projected to go unspent"
                : "every campaign is tracking to deliver"
            }
          />
        </div>
      ) : null}

      <ul className="divide-y divide-border/60">
        {shown.map((row) => (
          <PacingRow key={row.id} row={row} currency={currency} />
        ))}
      </ul>

      {hidden > 0 || expanded ? (
        <footer className="border-t border-border px-5 py-3">
          <button
            onClick={() => setExpanded((previous) => !previous)}
            className="text-xs font-semibold text-muted transition-colors hover:text-ink"
          >
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        </footer>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "negative" | "positive";
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <div className="text-[11px] tracking-wide text-muted uppercase">{label}</div>
      <div
        className={cx(
          "nums mt-1 text-xl font-bold",
          tone === "negative" ? "text-negative" : tone === "positive" ? "text-positive" : "text-ink",
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}

function PacingRow({ row, currency }: { row: CampaignRow; currency: string | null }) {
  const { pacing } = row;

  return (
    <li className="px-5 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-ink" title={row.name}>
            {row.name}
          </span>
          {/*
            A bursty campaign shows how it is bought *instead of* a verdict. "Behind" measures a
            daily rate the buy was never meant to hold, so on a trend campaign it is a false alarm,
            and a panel that cries wolf stops being read. The arithmetic is not hidden: the line
            below still says what share of the budget is gone and what goes unspent at this rate,
            and the shortfall is still counted in "Budget at risk" above.

            A custom creative label keeps its verdict and shows the label *beside* it. Those
            campaigns deliver continuously, so "Behind" means what it always means, and a custom
            unit is the last thing a rep should be quietly reassured about.
          */}
          {isBursty(pacing.label) ? null : (
            <Badge tone={STATUS_TONE[pacing.status]}>{STATUS_LABEL[pacing.status]}</Badge>
          )}
          {pacing.label ? <Badge tone="accent">{CAMPAIGN_LABEL_NAME[pacing.label]}</Badge> : null}
        </div>
        <div className="nums shrink-0 text-xs text-muted">
          {pacing.basis === "flight" ? (
            <>
              {formatCurrency(pacing.flightSpend ?? 0, currency)} of{" "}
              {formatCurrency(pacing.totalBudget ?? 0, currency)}
              {pacing.daysRemaining != null && pacing.status !== "ended"
                ? ` · ${pacing.daysRemaining}d left`
                : null}
            </>
          ) : pacing.dailyBudget != null ? (
            <>{formatCurrency(pacing.dailyBudget, currency)}/day budget</>
          ) : null}
        </div>
      </div>

      {pacing.basis === "flight" && pacing.elapsed != null && pacing.consumed != null ? (
        <FlightBar
          consumed={pacing.consumed}
          elapsed={pacing.elapsed}
          status={isBursty(pacing.label) ? null : pacing.status}
        />
      ) : null}

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        {explain(pacing, currency)}
      </p>

      {pacing.advice ? <Advice advice={pacing.advice} currency={currency} /> : null}
    </li>
  );
}

/**
 * The recommendation, kept visually separate from the explanation above it because it is the one
 * line that asks the rep to change something. Its wording turns on which lever actually applies —
 * a required rate the campaign is already permitted to spend is not a budget recommendation.
 */
function Advice({ advice, currency }: { advice: BudgetAdvice; currency: string | null }) {
  const required = formatCurrency(advice.requiredDaily, currency);

  /**
   * The only branch that recommends nothing. Every sentence below it is about a daily rate, and a
   * rep has said this campaign does not run to one — it delivers when a matching trend
   * fires. The shortfall is still named, because the committed money really may go unspent; what
   * changes is that the lever is coverage rather than budget.
   */
  if (advice.lever === "coverage") {
    return (
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        <span className="font-semibold text-ink">Budget is not the lever here.</span> This buy
        delivers in bursts, so the gaps are expected and the {required} a day that would finish the
        flight is a rate it was never meant to hold. If the commitment matters, the question is how
        often it is being triggered.
      </p>
    );
  }

  if (advice.lever === "fix-delivery") {
    return (
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        <span className="font-semibold text-ink">Budget is not the constraint.</span> Finishing in
        full needs {required} a day, which the current{" "}
        {formatCurrency(advice.currentDaily ?? 0, currency)} cap already allows. It is not spending
        what it has, so look at the bid and targeting rather than the budget.
      </p>
    );
  }

  const lift = advice.lift != null ? ` · ${advice.lift.toFixed(1)}× current` : "";

  if (advice.lever === "unrecoverable") {
    return (
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        <span className="font-semibold text-warn">Too far behind to fix with budget.</span>{" "}
        Delivering in full would take {required} a day{lift}. Worth revisiting the end date or the
        committed total with the advertiser.
      </p>
    );
  }

  return (
    <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-relaxed">
      <span className="font-semibold text-ink">
        Raise the daily budget to <span className="nums">{required}</span>
      </span>
      <span className="text-muted">
        {advice.currentDaily != null
          ? `from ${formatCurrency(advice.currentDaily, currency)}${lift} to deliver in full by the flight end.`
          : "to deliver the committed budget by the flight end."}
      </span>
    </p>
  );
}

/**
 * Spend against budget, with a marker at the point the flight has reached. The gap between the
 * bar and the marker *is* the pacing problem, which is faster to read than any percentage.
 */
function FlightBar({
  consumed,
  elapsed,
  status,
}: {
  consumed: number;
  elapsed: number;
  /** Null colours the bar as a plain measurement, for a buy whose pace is not a verdict. */
  status: PacingStatus | null;
}) {
  const fill = Math.min(100, consumed * 100);
  const marker = Math.min(100, elapsed * 100);
  const tone =
    status === null
      ? "bg-ink/40"
      : status === "underpacing"
        ? "bg-negative"
        : status === "overpacing"
          ? "bg-warn"
          : "bg-positive";

  return (
    <div className="relative mt-2 h-1.5 w-full rounded-full bg-surface-2">
      <div
        className={cx("h-full rounded-full transition-[width]", tone)}
        style={{ width: `${fill}%` }}
      />
      <div
        className="absolute top-[-3px] h-[12px] w-[2px] rounded-full bg-ink/60"
        style={{ left: `${marker}%` }}
        title={`${formatPercent(elapsed, 0)} of the flight elapsed`}
      />
    </div>
  );
}

function explain(pacing: CampaignPacing, currency: string | null): string {
  const rate =
    pacing.deliveryRate != null
      ? `Recent spend is ${formatPercent(pacing.deliveryRate, 0)} of the daily budget.`
      : "";

  switch (pacing.status) {
    case "dark":
      return `Was delivering, now spending nothing, with ${formatCurrency(
        pacing.dailyBudget ?? 0,
        currency,
      )} a day of budget available. Worth checking today.`;
    case "idle":
      return `Live with ${formatCurrency(
        pacing.dailyBudget ?? 0,
        currency,
      )} a day of budget but no delivery in this range at all.`;
    case "underpacing":
      if (pacing.basis === "flight") {
        return `${formatPercent(pacing.consumed ?? 0, 0)} of budget spent with ${formatPercent(
          pacing.elapsed ?? 0,
          0,
        )} of the flight gone. At this rate ${formatCurrency(
          pacing.projectedShortfall ?? 0,
          currency,
        )} goes unspent.`;
      }
      /**
       * "Recent spend is 0% of the daily budget" is the one line in this panel that reads as an
       * outage, and on a labelled buy between bursts it is the expected state.
       */
      return isBursty(pacing.label)
        ? `${rate} It delivers in bursts, so a quiet stretch is expected.`
        : rate;
    case "overpacing":
      return `${formatPercent(pacing.consumed ?? 0, 0)} of budget spent with ${formatPercent(
        pacing.elapsed ?? 0,
        0,
      )} of the flight gone. The budget runs out before the flight ends.`;
    case "on-pace":
      return pacing.basis === "flight"
        ? `${formatPercent(pacing.consumed ?? 0, 0)} spent against ${formatPercent(
            pacing.elapsed ?? 0,
            0,
          )} elapsed. Tracking to deliver in full.`
        : rate;
    case "ended":
      // Without a committed total there is no percentage to quote, and quoting 0% would read as
      // a flight that delivered nothing rather than one we cannot measure.
      return pacing.consumed != null
        ? `Flight closed having spent ${formatPercent(pacing.consumed, 0)} of the committed budget.`
        : "Flight has ended.";
    case "paused":
      return "Paused, so there is no pace to hold.";
    case "scheduled":
      return "Flight has not started yet.";
    default:
      return rate;
  }
}
