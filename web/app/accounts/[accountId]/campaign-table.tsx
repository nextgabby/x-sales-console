"use client";

import { useMemo, useState } from "react";

import { Badge, cx, Sparkline } from "@/components/ui";
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatUnitCost,
  titleCase,
} from "@/lib/format";
import { CAMPAIGN_LABEL_NAME, isBursty } from "@/lib/store/types";
import type { CampaignRow } from "./types";

type Column = {
  key: string;
  label: string;
  numeric: boolean;
  /** A per-unit cost, where zero means "never charged" rather than a low price. */
  unitCost?: boolean;
  value: (row: CampaignRow) => number;
  render: (row: CampaignRow, currency: string | null) => string;
};

const COLUMNS: Column[] = [
  {
    key: "spend",
    label: "Spend",
    numeric: true,
    value: (row) => row.totals.spend,
    render: (row, currency) => formatCurrency(row.totals.spend, currency),
  },
  {
    key: "impressions",
    label: "Impressions",
    numeric: true,
    value: (row) => row.totals.impressions,
    render: (row) => formatNumber(row.totals.impressions),
  },
  {
    key: "engagements",
    label: "Engagements",
    numeric: true,
    value: (row) => row.totals.engagements,
    render: (row) => formatNumber(row.totals.engagements),
  },
  {
    key: "engagementRate",
    label: "Eng. rate",
    numeric: true,
    value: (row) => row.totals.engagementRate,
    render: (row) => formatPercent(row.totals.engagementRate),
  },
  {
    key: "ctr",
    label: "CTR",
    numeric: true,
    value: (row) => row.totals.ctr,
    render: (row) => formatPercent(row.totals.ctr),
  },
  {
    key: "cpm",
    label: "CPM",
    numeric: true,
    unitCost: true,
    value: (row) => row.totals.cpm,
    render: (row, currency) => showUnitCost(row.totals.cpm, currency),
  },
  {
    key: "cpe",
    label: "CPE",
    numeric: true,
    unitCost: true,
    value: (row) => row.totals.cpe,
    render: (row, currency) => showUnitCost(row.totals.cpe, currency),
  },
];

/**
 * A zero unit cost means the denominator was zero — never charged, or no engagements to divide by —
 * not that the impressions were free. Rendering "$0.00" invites a rep to read the row as the most
 * efficient buy on the page, so it reads as unknown instead.
 */
function showUnitCost(value: number, currency: string | null): string {
  return value > 0 ? formatUnitCost(value, currency) : "—";
}

export function CampaignTable({
  campaigns,
  currency,
  selected,
  onToggleSelect,
  onOpen,
}: {
  campaigns: CampaignRow[];
  currency: string | null;
  selected: string[];
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [sortKey, setSortKey] = useState("spend");
  const [ascending, setAscending] = useState(false);
  const [showDormant, setShowDormant] = useState(false);

  const dormantCount = campaigns.filter((row) => row.dormant).length;

  const rows = useMemo(() => {
    const column = COLUMNS.find((entry) => entry.key === sortKey);
    const visible = showDormant ? campaigns : campaigns.filter((row) => !row.dormant);
    if (!column) return visible;
    return [...visible].sort((a, b) => {
      const left = column.value(a);
      const right = column.value(b);

      /**
       * On a cost column a zero is "not charged", not "cheapest". Sorting it numerically floats a
       * campaign that was never billed to the top of an ascending CPE sort, above every real buy,
       * so those rows are held at the bottom whichever way the column is sorted.
       */
      if (column.unitCost) {
        if (left <= 0 && right <= 0) return 0;
        if (left <= 0) return 1;
        if (right <= 0) return -1;
      }

      const diff = left - right;
      return ascending ? diff : -diff;
    });
  }, [campaigns, sortKey, ascending, showDormant]);

  const toggleSort = (key: string) => {
    if (key === sortKey) {
      setAscending((previous) => !previous);
      return;
    }
    setSortKey(key);
    setAscending(false);
  };

  return (
    <section className="rounded-2xl border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Campaigns</h2>
          <p className="mt-0.5 text-xs text-muted">
            {rows.length} shown
            {selected.length > 0 ? ` · ${selected.length} selected to compare` : ""}
          </p>
        </div>
        {dormantCount > 0 ? (
          <button
            onClick={() => setShowDormant((previous) => !previous)}
            className="text-xs font-semibold text-muted transition-colors hover:text-ink"
          >
            {showDormant ? "Hide" : "Show"} {dormantCount} with no activity
          </button>
        ) : null}
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] tracking-wide text-muted uppercase">
              <th className="w-10 px-5 py-2.5" />
              <th className="px-3 py-2.5 text-left font-medium">Campaign</th>
              <th className="px-3 py-2.5 text-left font-medium">Trend</th>
              {COLUMNS.map((column) => (
                <th key={column.key} className="px-3 py-2.5 text-right font-medium">
                  <button
                    onClick={() => toggleSort(column.key)}
                    className={cx(
                      "inline-flex items-center gap-1 transition-colors hover:text-ink",
                      sortKey === column.key && "text-ink",
                    )}
                  >
                    {column.label}
                    {sortKey === column.key ? <span>{ascending ? "↑" : "↓"}</span> : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="group border-b border-border/60 last:border-0 transition-colors hover:bg-surface-2"
              >
                <td className="px-5 py-3">
                  <input
                    type="checkbox"
                    checked={selected.includes(row.id)}
                    onChange={() => onToggleSelect(row.id)}
                    aria-label={`Compare ${row.name}`}
                    className="size-4 accent-accent"
                  />
                </td>
                <td className="max-w-[22rem] px-3 py-3">
                  <button
                    onClick={() => onOpen(row.id)}
                    // Neither a retired campaign nor a takeover has line items left to drill into.
                    disabled={row.retired || row.takeover}
                    className={cx(
                      "block max-w-full truncate text-left font-medium text-ink transition-colors",
                      row.retired || row.takeover
                        ? "cursor-default text-muted"
                        : "group-hover:text-accent",
                    )}
                    title={row.name}
                  >
                    {row.name}
                  </button>
                  <div className="mt-1 flex items-center gap-1.5">
                    <StatusBadge row={row} />
                    <PaceBadge row={row} />
                    {row.pacing.label ? (
                      <Badge tone="accent">{CAMPAIGN_LABEL_NAME[row.pacing.label]}</Badge>
                    ) : null}
                    {row.objective ? (
                      <span className="text-[11px] text-muted">
                        {titleCase(row.objective)}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <Sparkline
                    values={row.spendSeries}
                    className="h-6 w-20 text-muted group-hover:text-accent"
                  />
                </td>
                {COLUMNS.map((column) => (
                  <td key={column.key} className="nums px-3 py-3 text-right whitespace-nowrap">
                    {column.render(row, currency)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 3} className="px-5 py-10 text-center text-muted">
                  No campaigns with activity in this range.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {rows.some((row) => row.retired || row.takeover) ? (
        <footer className="border-t border-border px-5 py-3 text-[11px] leading-relaxed text-muted">
          {rows.some((row) => row.retired)
            ? "Retired campaigns were deleted but still spent in this range. "
            : ""}
          {rows.some((row) => row.takeover)
            ? "Takeovers are flat-rate day buys, so their cost per impression reflects a negotiated price rather than the auction — read their reach and engagement, not their CPM. "
            : ""}
          Rows add up to the account total.
        </footer>
      ) : null}
    </section>
  );
}

/**
 * Only the pacing problems appear here. Repeating "on pace" on every healthy row would add a
 * badge to most of the table and make the ones that matter harder to spot.
 *
 * A bursty label suppresses the badge entirely, the same way the pacing panel does. The status
 * itself survives the label — the shortfall arithmetic is still real and still reported — but
 * calling a trend buy "behind pace" in the table while the panel below declines to is worse than
 * either answer on its own, and the label beside it says why there is no verdict.
 */
function PaceBadge({ row }: { row: CampaignRow }) {
  if (isBursty(row.pacing.label)) return null;
  switch (row.pacing.status) {
    case "dark":
      return <Badge tone="negative">Stopped</Badge>;
    case "underpacing":
      return <Badge tone="negative">Behind pace</Badge>;
    case "overpacing":
      return <Badge tone="warn">Ahead of pace</Badge>;
    case "idle":
      return <Badge tone="warn">No delivery</Badge>;
    default:
      return null;
  }
}

function StatusBadge({ row }: { row: CampaignRow }) {
  if (row.takeover) return <Badge tone="accent">Takeover</Badge>;
  if (row.retired) return <Badge tone="warn">Retired</Badge>;
  if (row.effectiveStatus === "RUNNING") return <Badge tone="positive">Running</Badge>;
  if (row.entityStatus === "PAUSED") return <Badge>Paused</Badge>;
  if (row.effectiveStatus) return <Badge tone="warn">{titleCase(row.effectiveStatus)}</Badge>;
  return <Badge>{titleCase(row.entityStatus ?? "Unknown")}</Badge>;
}
