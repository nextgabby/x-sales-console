"use client";

import { formatCompact } from "@/lib/format";
import type { CampaignRow } from "./types";

/**
 * The seven figures a takeover wrap is built from. Order matches the recap sales already
 * sends: delivery first, then how far through the video people got.
 */
const LINES: Array<{ label: string; value: (row: CampaignRow) => number }> = [
  { label: "Total impressions", value: (row) => row.totals.impressions },
  { label: "Total clicks", value: (row) => row.totals.clicks },
  { label: "Video views", value: (row) => row.totals.videoViews },
  { label: "25% video views", value: (row) => row.totals.videoViews25 },
  { label: "50% video views", value: (row) => row.totals.videoViews50 },
  { label: "75% video views", value: (row) => row.totals.videoViews75 },
  { label: "Video completions", value: (row) => row.totals.videoViews100 },
];

export function TakeoverWrap({ rows }: { rows: CampaignRow[] }) {
  if (rows.length === 0) return null;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">Takeover wrap</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          One card per takeover day. These figures stay out of the rates above.
        </p>
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        {rows.map((row) => (
          <article
            key={row.id}
            className="max-w-md rounded-xl border border-border bg-surface px-4 py-4"
          >
            <h3 className="text-sm font-semibold text-ink">{row.name}</h3>
            <dl className="mt-3 space-y-2">
              {LINES.map((line) => (
                <div key={line.label} className="flex items-baseline gap-3">
                  <dd className="nums w-16 shrink-0 text-sm font-semibold text-accent">
                    {formatCompact(line.value(row))}
                  </dd>
                  <dt className="text-xs text-muted">{line.label}</dt>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
