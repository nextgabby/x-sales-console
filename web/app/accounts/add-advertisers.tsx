"use client";

import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Badge, Button, buttonClasses, Field, Input } from "@/components/ui";
import { extractAccountId, extractHandle, parseSpyPaste, SPY_MANAGER_URL } from "@/lib/handles";

type SpyGrant = { accountId: string; asUser: string; name: string };

type VerifyResult = {
  accountId: string;
  asUser: string;
  name: string | null;
  ok: boolean;
  reason: string | null;
};

type SpyResponse = { results: VerifyResult[]; notes?: string[] };

/**
 * Spy access cannot be discovered through the API — there is no endpoint that answers "which
 * accounts am I spied into" — so the list has to be entered. Two fields rather than a paste box,
 * because one account at a time is what reps actually do, and a labelled field makes it obvious
 * which value goes where. Bulk pasting is still available for anyone moving several at once.
 */
export function AddAdvertisers({
  spyGrants,
  onChanged,
}: {
  spyGrants: SpyGrant[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(spyGrants.length === 0);
  const [bulk, setBulk] = useState(false);
  const [accountInput, setAccountInput] = useState("");
  const [handleInput, setHandleInput] = useState("");
  const [text, setText] = useState("");
  const [results, setResults] = useState<VerifyResult[] | null>(null);

  // Both accept a pasted URL, so whatever is on the clipboard tends to work.
  const accountId = useMemo(() => extractAccountId(accountInput), [accountInput]);
  const handle = useMemo(() => extractHandle(handleInput), [handleInput]);
  const parsed = useMemo(() => parseSpyPaste(text), [text]);

  const canSubmit = bulk ? text.trim().length > 0 : Boolean(handle);

  const add = useMutation({
    mutationFn: async () => {
      /**
       * A handle with no account ID is sent as text, which makes the server list that advertiser's
       * accounts and test each one. Slower and broader, but it is the only way to add an account
       * whose ID the rep does not have — and spy access is per account, so the ones they cannot
       * open are rejected rather than stored.
       */
      const body =
        bulk || !accountId
          ? { text: bulk ? text : `@${handle}` }
          : { entries: [{ accountId, handle }] };

      const response = await fetch("/api/spy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not add those accounts.");
      return payload as SpyResponse;
    },
    onSuccess: (payload) => {
      setResults(payload.results);
      if (payload.results.some((result) => result.ok)) {
        setAccountInput("");
        setHandleInput("");
        setText("");
        onChanged();
      }
    },
  });

  const added = results?.filter((result) => result.ok) ?? [];
  const rejected = results?.filter((result) => !result.ok) ?? [];
  const handleCount = new Set(spyGrants.map((grant) => grant.asUser)).size;

  return (
    <div className="mb-8 rounded-2xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-sm font-semibold text-ink">Accounts you can spy into</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            The API cannot tell us which accounts you have spy access to, so add them here once.
            Granting access in the spy manager does not make an account appear on this page, and
            Refresh will not find it either.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={SPY_MANAGER_URL}
            target="_blank"
            rel="noreferrer"
            className={buttonClasses("secondary")}
          >
            Open spy list ↗
          </a>
          {spyGrants.length > 0 ? (
            <Button onClick={() => setOpen((value) => !value)}>
              {open ? "Hide" : "Add an account"}
            </Button>
          ) : null}
        </div>
      </div>

      {spyGrants.length > 0 ? (
        <p className="mt-3 text-xs text-muted">
          <span className="font-semibold text-ink">{spyGrants.length}</span> account
          {spyGrants.length === 1 ? "" : "s"} across{" "}
          <span className="font-semibold text-ink">{handleCount}</span> advertiser
          {handleCount === 1 ? "" : "s"} added.
        </p>
      ) : null}

      {open ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setResults(null);
            if (canSubmit) add.mutate();
          }}
        >
          {bulk ? (
            <>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={5}
                spellCheck={false}
                placeholder={
                  "One account per pair of lines, as copied from the spy list:\n\nDraftKings - Barstool @barstoolsports\n18ce55ttqxm\nPrizePicks @PrizePicks\n18ce53z9ttr"
                }
                className="w-full rounded-lg border border-border bg-canvas px-3 py-2.5 font-mono text-xs text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
              />
              {parsed.entries.length > 0 ? (
                <p className="text-xs text-muted">
                  Found {parsed.entries.length} account
                  {parsed.entries.length === 1 ? "" : "s"}
                  {parsed.bareHandles.length > 0
                    ? `, and ${parsed.bareHandles.length} handle${
                        parsed.bareHandles.length === 1 ? "" : "s"
                      } with no ID — every account under those will be checked`
                    : ""}
                  .
                </p>
              ) : null}
            </>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Advertiser handle"
                hint="Required. The @name you are spying as."
              >
                <Input
                  value={handleInput}
                  onChange={(event) => setHandleInput(event.target.value)}
                  placeholder="@Novig"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="Ad account ID"
                hint="Optional. Paste the spy URL and the ID is taken from it."
              >
                <Input
                  value={accountInput}
                  onChange={(event) => setAccountInput(event.target.value)}
                  placeholder="18ce55wp6cv"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </div>
          )}

          {/* Shown rather than silently applied, so a URL that parsed to the wrong ID is visible. */}
          {!bulk && accountInput.trim() ? (
            accountId ? (
              <p className="text-xs text-muted">
                Account <span className="font-mono text-ink">{accountId}</span>
                {handle ? (
                  <>
                    {" "}
                    as <span className="font-semibold text-ink">@{handle}</span>
                  </>
                ) : null}
                .
              </p>
            ) : (
              <p className="text-xs text-warn">
                No account ID found in that. IDs start with <span className="font-mono">18ce</span>.
                Leave it empty to check every account under the handle instead.
              </p>
            )
          ) : null}

          {!bulk && handle && !accountInput.trim() ? (
            <p className="text-xs text-muted">
              No ID given, so every account under @{handle} will be checked and only the ones you
              can open are kept. This takes a few seconds longer.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={add.isPending || !canSubmit}>
              {add.isPending ? "Checking…" : "Add account"}
            </Button>
            <button
              type="button"
              onClick={() => setBulk((value) => !value)}
              className="text-xs font-semibold text-muted underline transition-colors hover:text-ink"
            >
              {bulk ? "Add one at a time" : "Paste several at once"}
            </button>
          </div>
        </form>
      ) : null}

      {add.isError ? (
        <p className="mt-3 text-xs text-negative">{(add.error as Error).message}</p>
      ) : null}

      {results ? (
        <div className="mt-4 space-y-2 text-xs">
          {added.length > 0 ? (
            <div>
              <p className="mb-1 font-semibold text-positive">
                Added {added.length} account{added.length === 1 ? "" : "s"}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {added.map((result) => (
                  <Badge key={result.accountId} tone="positive">
                    {result.name} · @{result.asUser}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
          {rejected.length > 0 ? (
            <details className="text-muted" open={added.length === 0}>
              <summary className="cursor-pointer text-warn">
                {added.length === 0
                  ? `Could not add ${rejected.length} account${rejected.length === 1 ? "" : "s"}`
                  : `${rejected.length} you cannot open`}
              </summary>
              <ul className="mt-1.5 space-y-0.5">
                {rejected.map((result) => (
                  <li key={result.accountId}>{result.reason}</li>
                ))}
              </ul>
              <p className="mt-2">
                Spy access is granted per ad account. If you have just granted it, give it a moment
                and try again.
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
