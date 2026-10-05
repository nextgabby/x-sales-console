"use client";

import { Badge, cx } from "@/components/ui";
import { formatDelta } from "@/lib/format";
import { bestIndex, METRICS, SERIES_COLORS } from "../metrics";
import type { CampaignRow } from "../types";

export function CompareTable({
  campaigns,
  currency,
  baselineId,
  onBaselineChange,
}: {
  campaigns: CampaignRow[];
  currency: string | null;
  baselineId: string;
  onBaselineChange: (id: string) => void;
}) {
  const hasVideo = campaigns.some((campaign) => campaign.totals.videoViews > 0);
  const specs = METRICS.filter((spec) => !spec.video || hasVideo);
  const baselineIndex = Math.max(
    0,
    campaigns.findIndex((campaign) => campaign.id === baselineId),
  );

  return (
    <section className="rounded-2xl border border-border bg-surface">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">Side by side</h2>
        <p className="mt-0.5 text-xs text-muted">
          The better value in each row is highlighted. Percentages compare against the
          baseline column — click a campaign name to change it.
        </p>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="w-44 px-5 py-3 text-left text-[11px] font-medium tracking-wide text-muted uppercase">
                Metric
              </th>
              {campaigns.map((campaign, index) => (
                <th key={campaign.id} className="min-w-[11rem] px-4 py-3 text-right align-bottom">
                  <button
                    onClick={() => onBaselineChange(campaign.id)}
                    className="group/head block w-full text-right"
                    title="Use as baseline"
                  >
                    <span className="flex items-center justify-end gap-1.5">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{
                          background: SERIES_COLORS[index % SERIES_COLORS.length],
                        }}
                      />
                      <span className="truncate text-xs font-semibold text-ink group-hover/head:text-accent">
                        {campaign.name}
                      </span>
                    </span>
                    {index === baselineIndex ? (
                      <span className="mt-1 inline-block">
                        <Badge tone="accent">Baseline</Badge>
                      </span>
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {specs.map((spec) => {
              const values = campaigns.map((campaign) => spec.value(campaign.totals));
              const winner = bestIndex(values, spec.direction);
              const baseValue = values[baselineIndex] ?? 0;

              return (
                <tr key={spec.key} className="border-b border-border/60 last:border-0">
                  <th
                    scope="row"
                    className="px-5 py-3 text-left text-xs font-medium text-muted"
                    title={spec.hint}
                  >
                    {spec.label}
                  </th>
                  {values.map((value, index) => {
                    const isWinner = winner === index;
                    const raw =
                      index === baselineIndex
                        ? null
                        : formatDelta(value, baseValue, spec.direction === "lower");
                    // Outspending another campaign is neither good nor bad, so a directionless
                    // metric shows the size of the gap without colouring it as a win or a loss.
                    const delta =
                      raw && spec.direction === "neutral"
                        ? { ...raw, tone: "neutral" as const }
                        : raw;

                    return (
                      <td key={campaigns[index]!.id} className="px-4 py-3 text-right">
                        <div
                          className={cx(
                            "nums text-sm font-semibold",
                            isWinner ? "text-positive" : "text-ink",
                          )}
                        >
                          {spec.format(value, currency)}
                          {isWinner ? <span className="ml-1 text-[10px]">★</span> : null}
                        </div>
                        {delta ? (
                          <div
                            className={cx(
                              "nums mt-0.5 text-[11px]",
                              delta.tone === "positive"
                                ? "text-positive"
                                : delta.tone === "negative"
                                  ? "text-negative"
                                  : "text-muted",
                            )}
                          >
                            {delta.label}
                          </div>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
