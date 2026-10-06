"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Badge, Skeleton, Sparkline } from "@/components/ui";
import { formatCurrency, formatTimezone, titleCase } from "@/lib/format";
import type { AccountRef } from "./accounts-view";

type AccountSummary = {
  id: string;
  advertiserHandle: string | null;
  permissions: string[];
  currency: string | null;
  activeCampaigns: number;
  pausedCampaigns: number;
  totalCampaigns: number;
  spendSparkline: number[];
  spend7d: number;
  accessible: boolean;
  /** `denied` means X refused it, which is the only case re-adding fixes. */
  accessState: "ok" | "denied" | "unavailable";
  warnings: string[];
};

export function AccountCard({
  account,
  limiter,
  isFavorite,
  onToggleFavorite,
}: {
  account: AccountRef;
  limiter: <T>(task: () => Promise<T>) => Promise<T>;
  isFavorite: boolean;
  onToggleFavorite: () => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["summary", account.asUser ?? "direct", account.id],
    // Stats are the expensive part, so hold them longer than the account list.
    staleTime: 5 * 60_000,
    queryFn: () =>
      limiter(async () => {
        const params = new URLSearchParams({
          timezone: account.timezone,
          name: account.name,
        });
        if (account.asUser) params.set("asUser", account.asUser);
        if (account.approvalStatus) params.set("approvalStatus", account.approvalStatus);

        const response = await fetch(
          `/api/accounts/${account.id}/summary?${params.toString()}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail ?? "Could not load stats.");
        }
        return (await response.json()) as AccountSummary;
      }),
  });

  const trendTone = data ? describeTrend(data.spendSparkline) : "flat";
  const dashboardHref = account.asUser
    ? `/accounts/${account.id}?asUser=${encodeURIComponent(account.asUser)}`
    : `/accounts/${account.id}`;

  return (
    <article className="rise group relative flex flex-col rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-border-strong hover:bg-surface-2">
      {/* Overlay link so the whole card is clickable while the star stays on top of it. */}
      <Link
        href={dashboardHref}
        aria-label={`Open ${account.name} dashboard`}
        className="absolute inset-0 z-10 rounded-2xl focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      />

      <button
        onClick={onToggleFavorite}
        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
        className={`absolute right-4 top-4 z-20 text-lg leading-none transition-colors ${
          isFavorite ? "text-warn" : "text-muted/40 hover:text-muted"
        }`}
      >
        {isFavorite ? "★" : "☆"}
      </button>

      <div className="pr-8">
        <h3 className="truncate text-base font-semibold text-ink" title={account.name}>
          {account.name}
        </h3>
        <p className="mt-0.5 truncate text-xs text-muted">
          {data?.advertiserHandle ? `@${data.advertiserHandle} · ` : ""}
          {formatTimezone(account.timezone)}
        </p>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        {isLoading ? (
          <>
            <div className="space-y-1.5">
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-7 w-24" />
          </>
        ) : isError ? (
          <div className="text-xs text-warn">Stats unavailable</div>
        ) : data && !data.accessible ? (
          data.accessState === "denied" ? (
            <div className="text-xs leading-relaxed text-warn">
              <span className="font-semibold">
                {account.access === "spy" ? "Spy access has lapsed." : "You no longer have access."}
              </span>{" "}
              {account.access === "spy"
                ? "Re-open it in the spy list, then add it again. It stays here until you remove it."
                : "Ask the advertiser to restore your access."}
            </div>
          ) : (
            /* Not a permissions refusal, so re-adding the account would achieve nothing. */
            <div className="text-xs leading-relaxed text-warn">
              <span className="font-semibold">Could not load this account.</span> Try Refresh in a
              moment.
            </div>
          )
        ) : (
          <>
            <div>
              <div className="nums text-2xl font-bold tracking-tight">
                {formatCurrency(data?.spend7d ?? 0, data?.currency ?? null)}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">Spend, last 7 days</div>
            </div>
            <Sparkline
              values={data?.spendSparkline ?? []}
              className={`h-7 w-24 ${
                trendTone === "up"
                  ? "text-positive"
                  : trendTone === "down"
                    ? "text-negative"
                    : "text-muted"
              }`}
            />
          </>
        )}
      </div>

      <div className="mt-4 flex min-h-6 flex-wrap gap-1.5">
        {account.access === "spy" ? (
          <Badge tone="accent">as @{account.asUser}</Badge>
        ) : null}
        {data?.accessible ? (
          <>
            {data.activeCampaigns > 0 ? (
              <Badge tone="positive">{data.activeCampaigns} active</Badge>
            ) : (
              <Badge>No active campaigns</Badge>
            )}
            {data.pausedCampaigns > 0 ? <Badge>{data.pausedCampaigns} paused</Badge> : null}
          </>
        ) : null}
        {account.approvalStatus && account.approvalStatus !== "ACCEPTED" ? (
          <Badge tone="warn">{titleCase(account.approvalStatus)}</Badge>
        ) : null}
      </div>

      {data && data.warnings.length > 0 ? (
        <p className="mt-3 text-[11px] leading-relaxed text-warn/80">
          {data.warnings.join(" · ")}
        </p>
      ) : null}

      <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
        <code className="font-mono text-[11px] text-muted">{account.id}</code>
        <span className="text-xs font-semibold text-muted transition-colors group-hover:text-accent">
          Open dashboard →
        </span>
      </div>
    </article>
  );
}

function describeTrend(values: number[]): "up" | "down" | "flat" {
  if (values.length < 4) return "flat";
  const half = Math.floor(values.length / 2);
  const earlier = values.slice(0, half).reduce((sum, value) => sum + value, 0);
  const later = values.slice(half).reduce((sum, value) => sum + value, 0);
  if (later > earlier * 1.1) return "up";
  if (later < earlier * 0.9) return "down";
  return "flat";
}
