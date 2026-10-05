"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge, Callout, cx, Skeleton } from "@/components/ui";
import { formatDayLabel, formatTimezone } from "@/lib/format";
import { MAX_COMPARE, SERIES_COLORS } from "../metrics";
import type { DashboardPayload } from "../types";
import { CompareChart } from "./compare-chart";
import { CompareScatter } from "./compare-scatter";
import { CompareTable } from "./compare-table";
import { SummaryPanel } from "./summary-panel";

const RANGES = [7, 14, 30, 90];

export function CompareView({ accountId }: { accountId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const asUser = searchParams.get("asUser");
  const requestedDays = Number(searchParams.get("days") ?? 7);
  const range = RANGES.includes(requestedDays) ? requestedDays : 7;
  const ids = (searchParams.get("ids") ?? "").split(",").filter(Boolean);
  const baselineParam = searchParams.get("baseline");
  const takeovers = searchParams.get("takeovers") === "1";

  /**
   * Deliberately the same query key the dashboard uses, so arriving here from the campaign
   * table is instant and comparing costs no extra API calls. The takeover flag has to be part of
   * that key, or a takeover selected on the dashboard would not be found here.
   */
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
        throw new Error(payload.detail ?? "Could not load this account.");
      }
      return (await response.json()) as DashboardPayload;
    },
  });

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Ordered by the URL so the colour assignment is stable and shareable.
  const selected = ids
    .map((id) => data?.campaigns.find((campaign) => campaign.id === id))
    .filter((campaign): campaign is NonNullable<typeof campaign> => Boolean(campaign))
    .slice(0, MAX_COMPARE);

  const dashboardHref = `/accounts/${accountId}?${new URLSearchParams({
    ...(asUser ? { asUser } : {}),
    days: String(range),
  }).toString()}`;

  const baselineId =
    baselineParam && selected.some((campaign) => campaign.id === baselineParam)
      ? baselineParam
      : (selected[0]?.id ?? "");

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <Link
        href={dashboardHref}
        className="text-xs font-semibold text-muted transition-colors hover:text-ink"
      >
        ← {data?.account.name ?? "Back to account"}
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink">Compare campaigns</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {asUser ? <Badge tone="accent">as @{asUser}</Badge> : null}
            {data ? (
              <>
                <Badge>{formatTimezone(data.account.timezone)}</Badge>
                <span className="text-xs text-muted">
                  {formatDayLabel(data.range.dates[0]!)} –{" "}
                  {formatDayLabel(data.range.dates[data.range.dates.length - 1]!)}
                </span>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex rounded-full border border-border bg-surface p-1">
          {RANGES.map((option) => (
            <button
              key={option}
              onClick={() => update({ days: String(option) })}
              className={cx(
                "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                option === range ? "bg-accent text-white" : "text-muted hover:text-ink",
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
          <Skeleton className="h-64" />
          <Skeleton className="h-80" />
          <Skeleton className="h-72" />
        </div>
      ) : data ? (
        selected.length < 2 ? (
          <div className="mt-6">
            <Callout tone="warn">
              Pick at least two campaigns to compare.{" "}
              <Link className="font-semibold underline" href={dashboardHref}>
                Back to the campaign table
              </Link>
              .
            </Callout>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {selected.map((campaign, index) => (
                <span
                  key={campaign.id}
                  className="inline-flex max-w-xs items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5"
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }}
                  />
                  <span className="truncate text-xs text-ink" title={campaign.name}>
                    {campaign.name}
                  </span>
                  {selected.length > 2 ? (
                    <button
                      onClick={() =>
                        update({
                          ids: selected
                            .filter((entry) => entry.id !== campaign.id)
                            .map((entry) => entry.id)
                            .join(","),
                        })
                      }
                      aria-label={`Remove ${campaign.name}`}
                      className="text-muted transition-colors hover:text-negative"
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
            </div>

            {ids.length > MAX_COMPARE ? (
              <Callout tone="warn">
                Showing the first {MAX_COMPARE} of {ids.length} selected campaigns — beyond
                that the chart stops being readable.
              </Callout>
            ) : null}

            <SummaryPanel
              accountId={accountId}
              asUser={asUser}
              days={range}
              takeovers={takeovers}
              campaigns={selected}
            />

            <CompareTable
              campaigns={selected}
              currency={data.account.currency}
              baselineId={baselineId}
              onBaselineChange={(id) => update({ baseline: id })}
            />

            <CompareChart
              campaigns={selected}
              dates={data.range.dates}
              currency={data.account.currency}
            />

            <CompareScatter campaigns={selected} currency={data.account.currency} />

            {data.range.provisionalDays > 0 ? (
              <p className="text-xs text-muted">
                The last {data.range.provisionalDays} days of spend are provisional, so
                efficiency metrics for those days may still move.
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
