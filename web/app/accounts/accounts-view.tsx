"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Badge, Button, Callout, Input, Skeleton } from "@/components/ui";
import { createLimiter } from "@/lib/limiter";
import { AccountCard } from "./account-card";
import { AddAdvertisers } from "./add-advertisers";

export type AccountRef = {
  id: string;
  name: string;
  businessName: string | null;
  timezone: string;
  approvalStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  access: "direct" | "spy";
  asUser: string | null;
};

type AccountGroup = {
  source: "direct" | "spy";
  asUser: string | null;
  accounts: AccountRef[];
  error: string | null;
};

type SpyGrant = {
  accountId: string;
  asUser: string;
  name: string;
  timezone: string;
  addedAt: string;
};

type AccountsPayload = {
  handle: string | null;
  favorites: string[];
  spyGrants: SpyGrant[];
  groups: AccountGroup[];
  /** Set by a demo deployment, where nothing is stored and nothing can be changed. */
  demo?: boolean;
  /** Set by the shared hosted deployment, where signing out matters. */
  hosted?: boolean;
};

/** Shared across every card so the cap is global, not per component. */
const summaryLimiter = createLimiter(4);

async function fetchAccounts(): Promise<AccountsPayload> {
  const response = await fetch("/api/accounts", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.detail ?? payload.error ?? "Request failed");
    (error as Error & { code?: string }).code = payload.error;
    throw error;
  }
  return payload;
}

export function AccountsView() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["accounts"],
    queryFn: fetchAccounts,
  });

  const toggleFavorite = useMutation({
    mutationFn: async (accountId: string) => {
      const response = await fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      return response.json() as Promise<{ favorites: string[] }>;
    },
    onSuccess: (result) => {
      queryClient.setQueryData<AccountsPayload>(["accounts"], (current) =>
        current ? { ...current, favorites: result.favorites } : current,
      );
    },
  });

  const favorites = useMemo(() => new Set(data?.favorites ?? []), [data?.favorites]);

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.groups ?? []).map((group) => ({
      ...group,
      accounts: group.accounts
        .filter((account) => {
          if (!term) return true;
          return [account.name, account.businessName, account.asUser, account.id]
            .filter(Boolean)
            .some((value) => value!.toLowerCase().includes(term));
        })
        .sort((a, b) => {
          const favoriteDelta = Number(favorites.has(b.id)) - Number(favorites.has(a.id));
          if (favoriteDelta !== 0) return favoriteDelta;
          // Recently updated accounts are the ones a rep is most likely working on.
          return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
        }),
    }));
  }, [data?.groups, favorites, search]);

  const totalAccounts = groups.reduce((sum, group) => sum + group.accounts.length, 0);
  const notConnected = (error as (Error & { code?: string }) | null)?.code === "not-connected";

  if (notConnected) {
    return (
      <Shell handle={null} demo={false} hosted={false}>
        <Callout tone="warn">
          Your stored authorization is no longer valid.{" "}
          {/*
           * Straight into the handshake, not to /setup. The stored token still looks like a session
           * to the app — it cannot tell a revoked token from a live one without calling X — so
           * /setup would report "connected" and send the rep back here. Re-authorizing overwrites
           * the token in place, which is the actual fix in every case that lands here: a revoked
           * app, a rotated consumer key, or an authorization that predates Ads API approval.
           */}
          <a className="font-semibold underline" href="/api/auth/start">
            Re-authorize with X
          </a>
          .
        </Callout>
      </Shell>
    );
  }

  return (
    <Shell
      handle={data?.handle ?? null}
      demo={Boolean(data?.demo)}
      hosted={Boolean(data?.hosted)}
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Advertiser accounts</h1>
          <p className="mt-1 text-sm text-muted">
            {isLoading
              ? "Loading your accounts…"
              : `${totalAccounts} account${totalAccounts === 1 ? "" : "s"} across ${
                  groups.filter((group) => group.accounts.length > 0).length
                } source${
                  groups.filter((group) => group.accounts.length > 0).length === 1 ? "" : "s"
                }. Spend covers the last 7 complete days.`}
          </p>
        </div>
        <Button variant="secondary" onClick={() => refetch()} disabled={isRefetching}>
          {isRefetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* Adding advertisers writes stored grants, which a demo deployment does not have. */}
      {!isLoading && !data?.demo ? (
        <AddAdvertisers
          spyGrants={data?.spyGrants ?? []}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["accounts"] })}
        />
      ) : null}

      {error && !notConnected ? (
        <Callout tone="negative">
          Could not load accounts: {(error as Error).message}
        </Callout>
      ) : null}

      {!isLoading && (data?.groups.length ?? 0) > 0 ? (
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by account name, advertiser, or account ID"
          className="mb-8 max-w-sm"
        />
      ) : null}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-52" />
          ))}
        </div>
      ) : (
        <div className="space-y-10">
          {groups.map((group) => (
            <AccountGroupSection
              key={group.asUser ?? "direct"}
              group={group}
              favorites={favorites}
              demo={Boolean(data?.demo)}
              onToggleFavorite={(id) => toggleFavorite.mutate(id)}
              onRemoveHandle={() =>
                queryClient.invalidateQueries({ queryKey: ["accounts"] })
              }
            />
          ))}
        </div>
      )}
    </Shell>
  );
}

function AccountGroupSection({
  group,
  favorites,
  demo,
  onToggleFavorite,
  onRemoveHandle,
}: {
  group: AccountGroup;
  favorites: Set<string>;
  demo: boolean;
  onToggleFavorite: (accountId: string) => void;
  onRemoveHandle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Large spy groups stay collapsed so 40 cards do not all start fetching at once.
  const INITIAL_VISIBLE = 9;
  const visible = expanded ? group.accounts : group.accounts.slice(0, INITIAL_VISIBLE);
  const hidden = group.accounts.length - visible.length;

  const removeHandle = useMutation({
    mutationFn: async () => {
      await fetch(`/api/spy?asUser=${encodeURIComponent(group.asUser ?? "")}`, {
        method: "DELETE",
      });
    },
    onSuccess: onRemoveHandle,
  });

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold tracking-tight">
            {group.source === "direct" ? "Granted directly to you" : `@${group.asUser}`}
          </h2>
          {group.source === "spy" ? <Badge tone="accent">Impersonating</Badge> : null}
          <span className="text-xs text-muted">{group.accounts.length}</span>
        </div>
        {/* Removing a grant is a stored-settings change, which a demo deployment cannot make. */}
        {group.source === "spy" && !demo ? (
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            onClick={() => removeHandle.mutate()}
            disabled={removeHandle.isPending}
          >
            Remove
          </Button>
        ) : null}
      </div>

      {group.error ? (
        <Callout tone="warn">{group.error}</Callout>
      ) : group.accounts.length === 0 ? (
        <p className="py-4 text-sm text-muted">
          {group.source === "direct"
            ? "No advertiser has granted your handle direct access yet."
            : "No accounts matched your search in this advertiser."}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((account) => (
              <AccountCard
                key={`${account.asUser ?? "direct"}:${account.id}`}
                account={account}
                limiter={summaryLimiter}
                isFavorite={favorites.has(account.id)}
                onToggleFavorite={() => onToggleFavorite(account.id)}
              />
            ))}
          </div>
          {hidden > 0 ? (
            <Button
              variant="secondary"
              className="mt-4"
              onClick={() => setExpanded(true)}
            >
              Show {hidden} more
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

function SignOutButton() {
  const [signingOut, setSigningOut] = useState(false);

  return (
    <button
      type="button"
      disabled={signingOut}
      onClick={async () => {
        setSigningOut(true);
        await fetch("/api/auth/disconnect", { method: "POST" });
        /**
         * A full page load, not a router push. Every cached query, and anything else still in
         * memory, belongs to the rep who just signed out; a client-side navigation would keep it
         * all and hand it to whoever signs in next on the same machine.
         */
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = "/setup";
      }}
      className="rounded-full px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
    >
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
  );
}

function Shell({
  handle,
  demo,
  hosted,
  children,
}: {
  handle: string | null;
  demo: boolean;
  hosted: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2 text-sm font-bold tracking-tight">
            <span className="text-xl leading-none">𝕏</span>
            <span>Ads Sales Console</span>
          </div>
          <div className="flex items-center gap-3">
            {handle ? (
              <span className="text-xs text-muted">
                Signed in as <span className="font-semibold text-ink">@{handle}</span>
              </span>
            ) : null}
            {/* Settings only change stored credentials, of which a demo has none. */}
            {demo ? null : (
              <a
                href="/setup"
                className="rounded-full px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-surface hover:text-ink"
              >
                Settings
              </a>
            )}
            {/* On a shared deployment, leaving a session open on a borrowed laptop is the risk. */}
            {hosted ? <SignOutButton /> : null}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
