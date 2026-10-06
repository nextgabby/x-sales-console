"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge, Button, buttonClasses, Callout, cx, Skeleton } from "@/components/ui";
import { formatCurrency, formatDayLabel, formatTimezone, titleCase } from "@/lib/format";
import { CampaignDrawer } from "./campaign-drawer";
import { CampaignTable } from "./campaign-table";
import { KpiTiles } from "./kpi-tiles";
import { PacingPanel } from "./pacing-panel";
import { TrendChart, type TrendMetric } from "./trend-chart";
import type { DashboardPayload } from "./types";

const RANGES = [7, 14, 30, 90];

export function DashboardView({ accountId }: { accountId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const asUser = searchParams.get("asUser");
  const days = Number(searchParams.get("days") ?? 7);
  const range = RANGES.includes(days) ? days : 7;
  const takeovers = searchParams.get("takeovers") === "1";

  const [openCampaign, setOpenCampaign] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["dashboard", accountId, asUser ?? "direct", range, takeovers],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const params = new URLSearchParams({ days: String(range) });
      if (asUser) params.set("asUser", asUser);
      if (takeovers) params.set("takeovers", "1");
      const response = await fetch(
        `/api/accounts/${accountId}/dashboard?${params.toString()}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          payload.error === "no-access"
            ? "You do not have access to this account. Spy grants lapse — re-open it from the spy manager and add it again."
            : (payload.detail ?? "Could not load this account."),
        );
      }
      return (await response.json()) as DashboardPayload;
    },
  });

  /**
   * Whether the prior window holds anything to compare against, and when the spend on show
   * actually started.
   *
   * An account whose flight launched inside the current window has a prior window of pure zeros,
   * which is accurate but makes every tile read "New" — indistinguishable, to a rep who just added
   * the account, from the page having failed to load. Stated once here instead.
   */
  const baseline = useMemo(() => {
    if (!data) return null;
    if (data.previousTotals.spend > 0 || data.previousTotals.impressions > 0) return null;

    // Earliest start among the campaigns that actually spent, which is the flight on screen
    // rather than the oldest campaign sitting on the account.
    const starts = data.campaigns
      .filter((campaign) => campaign.totals.spend > 0 && campaign.startTime)
      .map((campaign) => campaign.startTime!.slice(0, 10))
      .sort();

    return { startedOn: starts[0] ?? null };
  }, [data]);

  // The range lives in the URL so a rep can share or bookmark a specific view.
  const setRange = useCallback(
    (next: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("days", String(next));
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const setTakeovers = useCallback(
    (next: boolean) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set("takeovers", "1");
      else params.delete("takeovers");
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const toggleSelect = (id: string) =>
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id],
    );

  // The whole comparison lives in the URL, so a rep can paste it into a deal thread.
  const compareHref = `/accounts/${accountId}/compare?${new URLSearchParams({
    ...(asUser ? { asUser } : {}),
    ...(takeovers ? { takeovers: "1" } : {}),
    days: String(range),
    ids: selected.join(","),
  }).toString()}`;

  const metrics: TrendMetric[] = data
    ? [
        { key: "spend", label: "Spend", values: data.spendSeries, kind: "currency" },
        {
          key: "impressions",
          label: "Impressions",
          values: data.series.impressions ?? [],
          kind: "count",
        },
        {
          key: "engagements",
          label: "Engagements",
          values: data.series.engagements ?? [],
          kind: "count",
        },
        { key: "clicks", label: "Clicks", values: data.series.clicks ?? [], kind: "count" },
        ...(data.totals.videoViews > 0
          ? [
              {
                key: "video",
                label: "Video views",
                values: data.series.video_total_views ?? [],
                kind: "count" as const,
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <Link
        href="/accounts"
        className="text-xs font-semibold text-muted transition-colors hover:text-ink"
      >
        ← All accounts
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {isLoading ? (
            <Skeleton className="h-8 w-64" />
          ) : (
            <h1 className="truncate text-2xl font-bold tracking-tight text-ink">
              {data?.account.name ?? accountId}
            </h1>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {asUser ? <Badge tone="accent">as @{asUser}</Badge> : null}
            {data ? (
              <>
                <Badge>{formatTimezone(data.account.timezone)}</Badge>
                {data.account.approvalStatus &&
                data.account.approvalStatus !== "ACCEPTED" ? (
                  <Badge tone="warn">{titleCase(data.account.approvalStatus)}</Badge>
                ) : null}
                <code className="font-mono text-[11px] text-muted">{accountId}</code>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex rounded-full border border-border bg-surface p-1">
          {RANGES.map((option) => (
            <button
              key={option}
              onClick={() => setRange(option)}
              className={cx(
                "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                option === range
                  ? "bg-accent text-white"
                  : "text-muted hover:text-ink",
              )}
            >
              {option}d
            </button>
          ))}
        </div>
      </header>

      {isError ? (
        <div className="mt-6">
          <Callout tone="negative">{(error as Error).message}</Callout>
        </div>
      ) : null}

      {isLoading ? (
        <div className="mt-6 space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-80" />
          <Skeleton className="h-64" />
        </div>
      ) : data ? (
        <div className="mt-6 space-y-4">
          {data.warnings.length > 0 ? (
            <Callout tone={data.partial ? "negative" : "warn"}>
              {data.warnings.join(" · ")}
            </Callout>
          ) : null}

          <KpiTiles
            totals={data.totals}
            previousTotals={data.previousTotals}
            currency={data.account.currency}
            spendSeries={data.spendSeries}
            rangeDays={range}
            comparable={baseline === null}
          />

          {baseline ? (
            <p className="text-xs text-muted">
              Nothing ran in the prior {range} days, so there is no period-over-period comparison.
              {baseline.startedOn
                ? ` The campaigns spending here started ${formatDayLabel(baseline.startedOn)}.`
                : null}
            </p>
          ) : null}

          {data.range.provisionalDays > 0 ? (
            <p className="text-xs text-muted">
              The last {data.range.provisionalDays} day
              {data.range.provisionalDays === 1 ? "" : "s"} of spend are provisional. Billing
              can be revised for up to 14 days.
            </p>
          ) : null}

          {/* Ahead of the charts: this is the part with something to do about it. */}
          <PacingPanel
            summary={data.pacing}
            campaigns={data.campaigns}
            currency={data.account.currency}
          />

          <TrendChart
            dates={data.range.dates}
            metrics={metrics}
            currency={data.account.currency}
            provisionalDays={data.range.provisionalDays}
          />

          <CampaignTable
            campaigns={data.campaigns}
            currency={data.account.currency}
            selected={selected}
            onToggleSelect={toggleSelect}
            onOpen={setOpenCampaign}
          />

          <TakeoverNotice
            takeovers={data.takeovers}
            currency={data.account.currency}
            onChange={setTakeovers}
          />

          <FundingSummary data={data} />
        </div>
      ) : null}

      {selected.length >= 2 ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2.5 shadow-xl">
            <span className="text-xs text-muted">
              {selected.length} campaigns selected
            </span>
            <Button
              variant="secondary"
              className="px-3 py-1 text-xs"
              onClick={() => setSelected([])}
            >
              Clear
            </Button>
            <Link href={compareHref} className={buttonClasses("primary", "px-3 py-1 text-xs")}>
              Compare
            </Link>
          </div>
        </div>
      ) : null}

      {openCampaign && data ? (
        <CampaignDrawer
          accountId={accountId}
          campaignId={openCampaign}
          asUser={asUser}
          days={range}
          timezone={data.account.timezone}
          onClose={() => setOpenCampaign(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Takeovers are hidden by default because Ads Manager hides them, and because a flat day rate and
 * an auction rate do not belong in the same average. The spend is still named here rather than
 * silently dropped, since on one real account it was 89% of the quarter.
 */
function TakeoverNotice({
  takeovers,
  currency,
  onChange,
}: {
  takeovers: DashboardPayload["takeovers"];
  currency: string | null;
  onChange: (next: boolean) => void;
}) {
  if (takeovers.count === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <p className="text-xs leading-relaxed text-muted">
        {takeovers.included ? (
          <>
            Includes {takeovers.count} takeover{takeovers.count === 1 ? "" : "s"} worth{" "}
            <span className="font-semibold text-ink">
              {formatCurrency(takeovers.spend, currency)}
            </span>
            . Takeovers are day buys at a flat rate, so their CPM is not comparable to the auction
            campaigns above and the account totals now mix the two.
          </>
        ) : (
          <>
            {takeovers.count} takeover{takeovers.count === 1 ? "" : "s"} worth{" "}
            <span className="font-semibold text-ink">
              {formatCurrency(takeovers.spend, currency)}
            </span>{" "}
            {takeovers.count === 1 ? "is" : "are"} excluded, as in Ads Manager. Day buys at a flat
            rate would distort the rates above.
          </>
        )}
      </p>
      <Button
        variant="secondary"
        className="shrink-0 px-3 py-1.5 text-xs"
        onClick={() => onChange(!takeovers.included)}
      >
        {takeovers.included ? "Hide takeovers" : "Show takeovers"}
      </Button>
    </div>
  );
}

function FundingSummary({ data }: { data: DashboardPayload }) {
  if (data.fundingInstruments.length === 0) return null;

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-ink">Funding</h2>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {data.fundingInstruments.map((instrument) => (
          <div
            key={instrument.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-canvas px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">
                {instrument.description || instrument.id}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {instrument.ableToFund ? "Able to fund" : "Not able to fund"}
              </p>
            </div>
            <div className="nums shrink-0 text-right">
              <div className="text-sm font-semibold text-ink">
                {formatCurrency(instrument.fundedAmount ?? 0, instrument.currency)}
              </div>
              <div className="text-[11px] text-muted">funded</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
