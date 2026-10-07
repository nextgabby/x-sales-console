"use client";

import { useQuery } from "@tanstack/react-query";

import { Badge, Button, Callout, Skeleton, Sparkline } from "@/components/ui";
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatUnitCost,
  titleCase,
} from "@/lib/format";
import { AskGrok } from "@/components/ask-grok";
import { BenchmarkPanel } from "./benchmark-panel";
import { CreativeList } from "./creative-list";
import { AudiencePanel } from "./audience-panel";
import { InsightsPanel } from "./insights-panel";
import { PlatformPanel } from "./platform-panel";
import { TargetingPanel } from "./targeting-panel";
import type { CampaignDetailPayload } from "./types";

const CREATIVE_SUGGESTIONS = [
  "Rank these by CTR.",
  "Rank by best overall performance, not just CTR.",
  "Why is the top creative beating the others?",
  "How would you optimize the weakest ones?",
];

const TARGETING_SUGGESTIONS = [
  "Is this targeting too narrow for the objective?",
  "What would you recommend changing, and why?",
  "Which line item's targeting is working best?",
  "How would you explain this setup to the advertiser?",
];

export function CampaignDrawer({
  accountId,
  campaignId,
  asUser,
  days,
  timezone,
  onClose,
}: {
  accountId: string;
  campaignId: string;
  asUser: string | null;
  days: number;
  timezone: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["campaign", accountId, campaignId, asUser ?? "direct", days],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const params = new URLSearchParams({ days: String(days), timezone });
      if (asUser) params.set("asUser", asUser);
      const response = await fetch(
        `/api/accounts/${accountId}/campaigns/${campaignId}?${params.toString()}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail ?? "Could not load this campaign.");
      }
      return (await response.json()) as CampaignDetailPayload;
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        onClick={onClose}
        aria-label="Close campaign details"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />

      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-border bg-canvas shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-canvas/95 px-6 py-5 backdrop-blur">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-wide text-muted uppercase">
              Campaign
            </p>
            <h2 className="mt-0.5 truncate text-lg font-bold text-ink">
              {data?.campaign.name ?? campaignId}
            </h2>
            {data ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {data.campaign.effectiveStatus === "RUNNING" ? (
                  <Badge tone="positive">Running</Badge>
                ) : (
                  <Badge>{titleCase(data.campaign.entityStatus ?? "Unknown")}</Badge>
                )}
                {data.campaign.objective ? (
                  <Badge tone="accent">{titleCase(data.campaign.objective)}</Badge>
                ) : null}
                {data.campaign.dailyBudget ? (
                  <Badge>
                    {formatCurrency(data.campaign.dailyBudget, data.currency)}/day
                  </Badge>
                ) : null}
                {data.campaign.totalBudget ? (
                  <Badge>
                    {formatCurrency(data.campaign.totalBudget, data.currency)} total
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </div>
          <Button variant="ghost" onClick={onClose} className="shrink-0">
            Close
          </Button>
        </header>

        <div className="space-y-6 px-6 py-6">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : isError ? (
            <Callout tone="negative">{(error as Error).message}</Callout>
          ) : data ? (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric
                  label="Spend"
                  value={formatCurrency(data.totals.spend, data.currency)}
                />
                <Metric
                  label="Impressions"
                  value={formatNumber(data.totals.impressions)}
                />
                <Metric label="CTR" value={formatPercent(data.totals.ctr)} />
                <Metric
                  label="CPM"
                  value={formatUnitCost(data.totals.cpm, data.currency)}
                />
              </div>

              <section>
                <h3 className="text-sm font-semibold text-ink">
                  Line items{" "}
                  <span className="font-normal text-muted">({data.lineItems.length})</span>
                </h3>
                <div className="mt-3 space-y-2">
                  {data.lineItems.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-border bg-surface p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium text-ink">
                              {item.name || item.id}
                            </p>
                            {/* Deleted but it still spent in this window, so it is counted above. */}
                            {item.retired ? <Badge tone="warn">Retired</Badge> : null}
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted">
                            {[
                              item.objective ? titleCase(item.objective) : null,
                              item.productType ? titleCase(item.productType) : null,
                              item.goal ? titleCase(item.goal) : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <Sparkline
                          values={item.spendSeries}
                          className="h-6 w-16 shrink-0 text-accent"
                        />
                      </div>

                      <dl className="nums mt-3 grid grid-cols-4 gap-2 text-xs">
                        <Cell
                          label="Spend"
                          value={formatCurrency(item.totals.spend, data.currency)}
                        />
                        <Cell
                          label="Impr."
                          value={formatNumber(item.totals.impressions)}
                        />
                        <Cell label="CTR" value={formatPercent(item.totals.ctr)} />
                        <Cell
                          label="CPM"
                          value={formatUnitCost(item.totals.cpm, data.currency)}
                        />
                      </dl>
                    </div>
                  ))}
                  {data.lineItems.length === 0 ? (
                    <p className="text-sm text-muted">No line items on this campaign.</p>
                  ) : null}
                </div>
              </section>

              <InsightsPanel
                accountId={accountId}
                campaignId={campaignId}
                asUser={asUser}
                days={days}
                timezone={timezone}
                currency={data.currency}
              />

              <PlatformPanel
                accountId={accountId}
                campaignId={campaignId}
                asUser={asUser}
                days={days}
                timezone={timezone}
                currency={data.currency}
              />

              {/*
                Above the audience panel, which reports who the delivery actually reached: intent
                then outcome is the order a rep walks an advertiser through, and the disagreement
                between the two is usually the reason for the call.
              */}
              <TargetingPanel targeting={data.targeting} />

              {/* Nothing to advise on when no line item carries any criteria; the panel says so. */}
              {data.targeting.status === "ok" ? (
                <AskGrok
                  endpoint={`/api/accounts/${accountId}/campaigns/${campaignId}/targeting-summary`}
                  body={{ asUser, days, timezone }}
                  title="Ask Grok about this targeting"
                  description="Grounded in the criteria above, which are read from the Ads API rather than inferred."
                  primaryLabel="Review targeting"
                  emptyState="Nothing generated yet. Review the targeting, or ask whether it fits the objective."
                  suggestions={TARGETING_SUGGESTIONS}
                  askPlaceholder="Ask about this targeting…"
                  unconfiguredHint="Add your own xAI API key to review this targeting and get recommendations."
                />
              ) : null}

              <AudiencePanel
                accountId={accountId}
                campaignId={campaignId}
                asUser={asUser}
                days={days}
                timezone={timezone}
              />

              <BenchmarkPanel accountId={accountId} campaignId={campaignId} asUser={asUser} />

              <CreativeList
                posts={data.promotedPosts}
                currency={data.currency}
                hasVideo={data.totals.videoViews > 0}
              />

              {/* Only offered where something delivered; there is nothing to rank otherwise. */}
              {data.promotedPosts.some((post) => post.totals.impressions > 0) ? (
                <AskGrok
                  endpoint={`/api/accounts/${accountId}/campaigns/${campaignId}/creative-summary`}
                  body={{ asUser, days, timezone }}
                  title="Ask Grok about these creatives"
                  description="Rankings are computed from the API figures above, not by the model."
                  primaryLabel="Assess creatives"
                  emptyState="Nothing generated yet. Assess the creatives, or ask why one is beating the others."
                  suggestions={CREATIVE_SUGGESTIONS}
                  askPlaceholder="Ask about these creatives…"
                  unconfiguredHint="Add your own xAI API key to rank these creatives and ask why one is winning."
                />
              ) : null}

              {data.warnings.length > 0 ? (
                <Callout tone="warn">{data.warnings.join(" · ")}</Callout>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="text-[11px] tracking-wide text-muted uppercase">{label}</div>
      <div className="nums mt-1 text-lg font-bold text-ink">{value}</div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 font-semibold text-ink">{value}</dd>
    </div>
  );
}
