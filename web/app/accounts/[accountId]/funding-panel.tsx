"use client";

import { useMemo, useState } from "react";

import { Badge, Callout, cx } from "@/components/ui";
import { formatCompactCurrency, formatCurrency } from "@/lib/format";
import { isLiveCommitment, type FundingStatus } from "@/lib/x/funding";
import type { FundingInstrumentRow } from "./types";

const STATUS_LABEL: Record<FundingStatus, string> = {
  underpacing: "Behind",
  "on-pace": "On pace",
  overpacing: "Ahead",
  blocked: "Cannot spend",
  scheduled: "Not started",
  ended: "Flight ended",
  unfunded: "No commitment",
};

const STATUS_TONE: Record<FundingStatus, "positive" | "negative" | "warn" | "neutral"> = {
  underpacing: "negative",
  "on-pace": "positive",
  overpacing: "warn",
  blocked: "negative",
  scheduled: "neutral",
  ended: "neutral",
  unfunded: "neutral",
};

/** Worst first, because the panel exists to surface money that will not be spent. */
const ORDER: FundingStatus[] = [
  "blocked",
  "underpacing",
  "overpacing",
  "on-pace",
  "ended",
  "scheduled",
  "unfunded",
];

/**
 * Budget pacing for each insertion order, which is the commitment the advertiser actually agreed
 * to. Campaign pacing answers a different question: an account can split one order across
 * campaigns that each pace fine while the order as a whole falls short.
 */
export function FundingPanel({
  instruments,
  currency,
  timeZone,
}: {
  instruments: FundingInstrumentRow[];
  currency: string | null;
  timeZone: string;
}) {
  const [showAll, setShowAll] = useState(false);

  const { live, hidden } = useMemo(() => {
    /**
     * Funded and in flight, not `entity_status === "ACTIVE"`.
     *
     * Status is the wrong filter and a live account shows why: an instrument described as "(no
     * payment method has been set up yet)" is ACTIVE and able to fund with nothing in it, while
     * the orders holding the budget are PAUSED. Filtering on status keeps the empty one and hides
     * the money.
     */
    const isLive = (row: FundingInstrumentRow) =>
      isLiveCommitment({
        fundedAmount: row.fundedAmount,
        startTime: row.startTime,
        endTime: row.endTime,
      });
    return {
      live: instruments.filter(isLive),
      hidden: instruments.filter((row) => !isLive(row)),
    };
  }, [instruments]);

  const shown = showAll ? instruments : live;
  const sorted = [...shown].sort((a, b) => {
    const rank = (row: FundingInstrumentRow) =>
      row.pacing ? ORDER.indexOf(row.pacing.status) : ORDER.length;
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    return (b.pacing?.atRisk ?? 0) - (a.pacing?.atRisk ?? 0);
  });

  const atRisk = live.reduce((total, row) => total + (row.pacing?.atRisk ?? 0), 0);

  if (instruments.length === 0) return null;

  return (
    <section className="rounded-2xl border border-border bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Funding sources</h2>
          <p className="mt-0.5 text-xs text-muted">
            Each insertion order paced against its own flight, not the selected range. This is the
            commitment the advertiser agreed to, which campaign pacing does not answer.
          </p>
        </div>
        {hidden.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowAll((previous) => !previous)}
            className="shrink-0 text-xs text-muted underline transition-colors hover:text-ink"
          >
            {showAll ? `Hide ${hidden.length} not in flight` : `Show ${hidden.length} more`}
          </button>
        ) : null}
      </header>

      {atRisk > 0 ? (
        <div className="px-5 pt-4">
          <Callout tone="warn">
            {formatCurrency(atRisk, currency)} committed is projected to go unspent across{" "}
            {live.filter((row) => (row.pacing?.atRisk ?? 0) > 0).length} of {live.length} funding
            {live.length === 1 ? " source" : " sources"}.
          </Callout>
        </div>
      ) : null}

      <ul className="divide-y divide-border/60">
        {sorted.map((row) => (
          <InstrumentRow key={row.id} row={row} currency={currency} timeZone={timeZone} />
        ))}
      </ul>
    </section>
  );
}

function InstrumentRow({
  row,
  currency,
  timeZone,
}: {
  row: FundingInstrumentRow;
  currency: string | null;
  timeZone: string;
}) {
  const pacing = row.pacing;

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">
              {row.description ?? `Funding source ${row.id}`}
            </span>
            {pacing ? (
              <Badge tone={STATUS_TONE[pacing.status]}>{STATUS_LABEL[pacing.status]}</Badge>
            ) : null}
            {row.ioHeader ? <Badge>{row.ioHeader}</Badge> : null}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {describeFlight(row, timeZone)}
            {row.campaigns > 0
              ? ` · ${row.campaigns} campaign${row.campaigns === 1 ? "" : "s"}`
              : ""}
          </div>
        </div>

        {pacing && pacing.fundedAmount > 0 ? (
          <div className="text-right">
            <div className="nums text-sm font-semibold text-ink">
              {formatCompactCurrency(pacing.spendToDate, currency)}
              <span className="font-normal text-muted">
                {" of "}
                {formatCompactCurrency(pacing.fundedAmount, currency)}
              </span>
            </div>
            <div className="nums text-[11px] text-muted">
              {Math.round(pacing.shareSpent * 100)}% spent ·{" "}
              {Math.round(pacing.shareElapsed * 100)}% of flight
            </div>
          </div>
        ) : null}
      </div>

      {pacing && pacing.fundedAmount > 0 ? (
        <>
          {/*
            Two bars rather than one. A single progress bar cannot show that 53% spent is a problem
            only because 68% of the flight is gone -- the gap between them is the whole verdict.
          */}
          <div className="mt-3 space-y-1">
            <Bar
              share={pacing.shareSpent}
              tone={pacing.status === "underpacing" || pacing.status === "blocked" ? "bad" : "good"}
            />
            <Bar share={pacing.shareElapsed} tone="flight" />
          </div>
          <p className="mt-2 text-xs text-muted">{advice(pacing, row, currency)}</p>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted">
          Nothing committed on this source, so there is no commitment to pace against.
          {row.creditLimit != null
            ? ` Credit limit ${formatCurrency(row.creditLimit, currency)}.`
            : ""}
        </p>
      )}
    </li>
  );
}

function Bar({ share, tone }: { share: number; tone: "good" | "bad" | "flight" }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
      <div
        className={cx(
          "h-full rounded-full",
          tone === "bad" ? "bg-negative" : tone === "good" ? "bg-positive" : "bg-border",
        )}
        style={{ width: `${Math.min(Math.max(share, 0), 1) * 100}%` }}
      />
    </div>
  );
}

/**
 * Flight dates in the account's timezone, not UTC. X expresses an order's boundaries as the
 * advertiser's own day: a flight ending `2026-11-02T04:59:59Z` runs through the end of November 1st
 * in New York, and rendering that in UTC would advertise an extra day the order does not have.
 */
function describeFlight(row: FundingInstrumentRow, timeZone: string): string {
  const label = (value: string | null) =>
    value
      ? new Date(value).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone,
        })
      : null;
  const start = label(row.startTime);
  const end = label(row.endTime);
  const type = row.type ? row.type.toLowerCase().replace(/_/g, " ") : "funding source";
  if (start && end) return `${type} · ${start}–${end}`;
  if (start) return `${type} · from ${start}`;
  return type;
}

/**
 * One sentence saying what to do. Blocked leads with the reason rather than the shortfall: a
 * paused order is behind pace *because* it is paused, and reporting the shortfall first sends a
 * rep to raise budgets on campaigns that cannot spend whatever their caps say.
 */
function advice(
  pacing: NonNullable<FundingInstrumentRow["pacing"]>,
  row: FundingInstrumentRow,
  currency: string | null,
): string {
  const remaining = `${pacing.daysRemaining} day${pacing.daysRemaining === 1 ? "" : "s"} left`;

  switch (pacing.status) {
    case "blocked":
      return (
        `This source is ${pacing.blockedReason ?? "unable to fund"}, so none of its commitment can ` +
        `be spent. ${formatCurrency(pacing.fundedAmount - pacing.spendToDate, currency)} ` +
        `is unspent with ${remaining}.`
      );
    case "underpacing":
      return (
        `At the current rate this finishes at ` +
        `${formatCurrency(pacing.projectedSpend, currency)}, leaving ` +
        `${formatCurrency(pacing.atRisk, currency)} unspent with ${remaining}.` +
        (row.campaigns === 0
          ? " No campaigns are drawing on it in this range, which is the first thing to check."
          : "")
      );
    case "overpacing":
      return `On track to exhaust the commitment before the flight ends, with ${remaining}.`;
    case "on-pace":
      return `Spending in line with the flight, with ${remaining}.`;
    case "ended":
      return pacing.atRisk > 0
        ? `The flight is over and ${formatCurrency(pacing.atRisk, currency)} went unspent.`
        : "The flight is over and the commitment was delivered in full.";
    case "scheduled":
      return "The flight has not started yet.";
    default:
      return "No commitment to pace against.";
  }
}
