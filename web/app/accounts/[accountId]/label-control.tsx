"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Badge, Callout, cx } from "@/components/ui";
import type { CampaignLabelKind } from "@/lib/store/types";

/**
 * Lets a rep say how a campaign is bought, in the two cases the Ads API cannot.
 *
 * It exists because pacing is wrong without it. A Trend Genius buy only delivers when a matching
 * trend fires, and a subscription notification campaign only when there is something to notify
 * people about, so both read as behind pace or stopped against a flight that assumes every day.
 * Neither is identifiable from the API — a live trend campaign comes back as an ordinary
 * `PROMOTED_TWEETS` reach buy — and advertisers only sometimes name them as such.
 *
 * Deliberately a short list rather than free text. The point is not to annotate campaigns; it is to
 * change a verdict, and only these two change it.
 */
const OPTIONS: Array<{ kind: CampaignLabelKind | null; label: string; hint: string }> = [
  {
    kind: null,
    label: "Standard buy",
    hint: "Paced against its flight day by day, like every other campaign.",
  },
  {
    kind: "trend-genius",
    label: "Trend Genius",
    hint: "Delivers when a matching trend fires, so gaps between bursts are expected.",
  },
  {
    kind: "notification",
    label: "Notification buy",
    hint: "Delivers when there is something to notify subscribers about.",
  },
];

export function LabelControl({
  accountId,
  campaignId,
  asUser,
  label,
}: {
  accountId: string;
  campaignId: string;
  asUser: string | null;
  label: CampaignLabelKind | null;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (kind: CampaignLabelKind | null) => {
      const response = await fetch(`/api/accounts/${accountId}/labels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignId, kind, asUser }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not save the label.");
      return payload;
    },
    /**
     * The dashboard owns the verdict this changes, so it is refetched rather than patched here.
     * Flipping a label moves a campaign between "Behind" and "Behind, by design" and shifts the
     * headline counts with it, and recomputing that on the client would be a second copy of
     * `computePacing` waiting to disagree with the first.
     */
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard", accountId] }),
  });

  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">How this campaign is bought</h3>
        <Badge>Shared with the team</Badge>
      </header>
      <p className="mt-0.5 text-xs text-muted">
        The Ads API cannot tell a trend or notification buy from an ordinary one, so both get
        reported as behind pace. Saying which it is fixes that for everyone on this advertiser.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {OPTIONS.map((option) => {
          const selected = option.kind === label;
          return (
            <button
              key={option.kind ?? "standard"}
              type="button"
              title={option.hint}
              disabled={mutation.isPending}
              onClick={() => (selected ? undefined : mutation.mutate(option.kind))}
              className={cx(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-60",
                selected
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-border bg-surface-2 text-muted hover:text-ink",
              )}
              aria-pressed={selected}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        {mutation.isPending
          ? "Saving…"
          : (OPTIONS.find((option) => option.kind === label)?.hint ?? "")}
      </p>

      {mutation.isError ? (
        <div className="mt-2">
          <Callout tone="warn">{(mutation.error as Error).message}</Callout>
        </div>
      ) : null}
    </section>
  );
}
