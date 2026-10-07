"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Badge, Callout, cx } from "@/components/ui";
import type { CampaignLabelKind } from "@/lib/store/types";

/**
 * Lets a rep say how a campaign is bought, in the cases the Ads API cannot express.
 *
 * The options do two different jobs, and the hints say which, because a rep choosing between them
 * needs to know what each one changes:
 *
 * - Trend Genius changes the **pacing verdict**. It only delivers when a matching trend fires, so
 *   against a flight that assumes every day it reads as behind pace or stopped while doing exactly
 *   what it was sold to do.
 * - L4R and Custom change the **comparison**. They deliver continuously, so they pace like anything
 *   else; what they fix is the baseline. A custom unit measured against a mix that includes the
 *   brand's other custom units cannot answer the question it was built to answer, which is whether
 *   custom beats regular on this objective.
 *
 * Deliberately a short list rather than free text. The point is not to annotate campaigns, it is to
 * change a verdict or a cohort, and only these do either.
 */
const OPTIONS: Array<{ kind: CampaignLabelKind | null; label: string; hint: string }> = [
  {
    kind: null,
    label: "Standard buy",
    hint: "Paced against its flight day by day, and compared against the brand's other campaigns on this objective.",
  },
  {
    kind: "trend-genius",
    label: "Trend Genius",
    hint: "Delivers when a matching trend fires, so gaps between bursts are expected and it is not paced against a daily rate.",
  },
  {
    kind: "l4r",
    label: "L4R",
    hint: "A custom unit. Paced normally, but compared against the brand's standard buys on this objective rather than its other custom ones.",
  },
  {
    kind: "custom",
    label: "Custom",
    hint: "Any other unit Creative Strategy built. Paced normally, but compared against the brand's standard buys on this objective.",
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
     *
     * The benchmark goes too, since a custom label changes which campaigns are in its baseline. It
     * is keyed by campaign rather than by account, so only the open drawer's comparison is refetched.
     */
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", accountId] });
      queryClient.invalidateQueries({ queryKey: ["benchmark", accountId, campaignId] });
    },
  });

  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">How this campaign is bought</h3>
        <Badge>Shared with the team</Badge>
      </header>
      <p className="mt-0.5 text-xs text-muted">
        The Ads API names neither trend buys nor custom creative, so a trend campaign gets reported
        as behind pace and a custom unit gets compared against the wrong campaigns. Saying which it
        is fixes both, for everyone on this advertiser.
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
