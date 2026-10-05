"use client";

import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Badge, Button, buttonClasses } from "@/components/ui";
import { parseSpyPaste, SPY_MANAGER_URL } from "@/lib/handles";

type SpyGrant = { accountId: string; asUser: string; name: string };

type VerifyResult = {
  accountId: string;
  asUser: string;
  name: string | null;
  ok: boolean;
  reason: string | null;
};

/**
 * Spy access cannot be discovered through the API, so this sends reps to the spy manager —
 * the one place the list exists — and takes the pasted result.
 */
export function AddAdvertisers({
  spyGrants,
  onChanged,
}: {
  spyGrants: SpyGrant[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(spyGrants.length === 0);
  const [text, setText] = useState("");
  const [results, setResults] = useState<VerifyResult[] | null>(null);

  const parsed = useMemo(() => parseSpyPaste(text), [text]);
  const candidateCount = parsed.entries.length;

  const add = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/spy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not add those accounts.");
      return payload as { results: VerifyResult[] };
    },
    onSuccess: (payload) => {
      setResults(payload.results);
      if (payload.results.some((result) => result.ok)) {
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
            Spy access is granted per ad account and the API cannot list it, so it has to come
            from your spy list. Open it, copy the rows you want — name, handle and account ID —
            and paste them below. Each account is checked against the API, and only the ones you
            can actually open are kept.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={SPY_MANAGER_URL}
            target="_blank"
            rel="noreferrer"
            className={buttonClasses("primary")}
          >
            Open spy list ↗
          </a>
          {spyGrants.length > 0 ? (
            <Button variant="secondary" onClick={() => setOpen((value) => !value)}>
              {open ? "Hide" : "Add more"}
            </Button>
          ) : null}
        </div>
      </div>

      {spyGrants.length > 0 ? (
        <p className="mt-3 text-xs text-muted">
          <span className="font-semibold text-ink">{spyGrants.length}</span> account
          {spyGrants.length === 1 ? "" : "s"} across{" "}
          <span className="font-semibold text-ink">{handleCount}</span> advertiser
          {handleCount === 1 ? "" : "s"} verified.
        </p>
      ) : null}

      {open ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setResults(null);
            if (text.trim()) add.mutate();
          }}
        >
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={
              "Paste rows from the spy list:\n\nDraftKings - Barstool @barstoolsports\n18ce55ttqxm\nPrizePicks @PrizePicks\n18ce53z9ttr"
            }
            className="w-full rounded-lg border border-border bg-canvas px-3 py-2.5 font-mono text-xs text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={add.isPending || !text.trim()}>
              {add.isPending
                ? "Verifying…"
                : candidateCount > 0
                  ? `Verify ${candidateCount} account${candidateCount === 1 ? "" : "s"}`
                  : "Verify accounts"}
            </Button>
            {candidateCount > 0 && !add.isPending ? (
              <span className="text-xs text-muted">
                {candidateCount} account ID
                {candidateCount === 1 ? "" : "s"} found
                {parsed.bareHandles.length > 0
                  ? `, plus ${parsed.bareHandles.length} handle${
                      parsed.bareHandles.length === 1 ? "" : "s"
                    } with no ID (all their accounts will be checked)`
                  : ""}
              </span>
            ) : parsed.bareHandles.length > 0 && !add.isPending ? (
              <span className="text-xs text-warn">
                No account IDs found — every account under{" "}
                {parsed.bareHandles.map((handle) => `@${handle}`).join(", ")} will be checked,
                which is slower. Include the account ID lines for a precise match.
              </span>
            ) : null}
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
            <details className="text-muted">
              <summary className="cursor-pointer text-warn">
                {rejected.length} not accessible to you
              </summary>
              <ul className="mt-1.5 space-y-0.5">
                {rejected.map((result) => (
                  <li key={result.accountId}>{result.reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
