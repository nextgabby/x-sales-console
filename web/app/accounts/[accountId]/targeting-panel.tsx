"use client";

import { Badge, Callout } from "@/components/ui";
import type { TargetingGroup, TargetingSummary, TargetingValue } from "@/lib/x/targeting";

/**
 * What the campaign is set to target, read back from its line items.
 *
 * Sits directly above the audience panel on purpose: that one reports who the delivery actually
 * reached, and the two side by side are the conversation a rep is usually trying to have. Nothing
 * here is inferred — every value is a criterion the advertiser set, and the signals underneath are
 * arithmetic over them rather than advice, which is left to the Grok panel below.
 */
export function TargetingPanel({ targeting }: { targeting: TargetingSummary }) {
  return (
    <section>
      <header>
        <h3 className="text-sm font-semibold text-ink">Targeting</h3>
        <p className="mt-0.5 text-xs text-muted">
          What the campaign is set to reach, declared by the advertiser rather than inferred
          from delivery.
        </p>
      </header>

      <div className="mt-3">
        <Body targeting={targeting} />
      </div>
    </section>
  );
}

function Body({ targeting }: { targeting: TargetingSummary }) {
  if (targeting.status === "unavailable") {
    return <Callout tone="warn">{targeting.reason ?? "Targeting could not be loaded."}</Callout>;
  }

  if (targeting.status === "none") {
    return (
      <Callout>
        {targeting.lineItems === 0
          ? "This campaign has no live line items, so there is no targeting to read."
          : "No line item on this campaign carries any targeting criteria, so delivery is unconstrained."}
      </Callout>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-surface p-4">
        <dl className="divide-y divide-border">
          {targeting.groups.map((group) => (
            <Group key={group.type} group={group} lineItems={targeting.lineItems} />
          ))}
        </dl>
      </div>

      {targeting.signals.length > 0 ? (
        <dl className="rounded-2xl border border-border bg-surface p-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {targeting.signals.map((signal) => (
            <div key={signal.title} className="text-xs leading-relaxed">
              <dt className="inline font-semibold text-ink">{signal.title}</dt>{" "}
              <dd className="inline text-muted">{signal.detail}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function Group({ group, lineItems }: { group: TargetingGroup; lineItems: number }) {
  return (
    <div className="grid gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-muted">{group.label}</dt>
      <dd className="space-y-1.5">
        {group.included.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {group.included.map((value) => (
              <Value key={value.label} value={value} lineItems={lineItems} />
            ))}
          </div>
        ) : null}

        {/*
          Exclusions get their own row under an "except" label rather than being mixed in. Two
          reasons, both found by looking at it: wrapped pills put the separator in an ambiguous
          place, and "United States" beside "Alaska" in one list is the single misreading of this
          panel that would genuinely mislead someone about what the campaign reaches.
        */}
        {group.excluded.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted">except</span>
            {group.excluded.map((value) => (
              <Value key={value.label} value={value} lineItems={lineItems} />
            ))}
          </div>
        ) : null}
      </dd>
    </div>
  );
}

function Value({ value, lineItems }: { value: TargetingValue; lineItems: number }) {
  const label = value.missing ? `${value.label} (deleted)` : value.label;

  /**
   * Excluded values are not coloured as a problem. Red is the house signal for something wrong,
   * and this panel's own text says exclusions are usually a regulator or a licence — one live
   * account excludes four US states because that is where it may not take bets. The "except"
   * label above carries the meaning; the colour would only editorialise it.
   */
  const tone = value.missing ? "warn" : "neutral";

  /**
   * The line item count only appears when it is not the whole campaign. On a single-line-item
   * campaign every value would otherwise carry a redundant "1 of 1".
   */
  const partial = !value.everywhere && lineItems > 1;

  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={tone}>{label}</Badge>
      {partial ? (
        <span className="text-[10px] text-muted">
          {value.lineItemIds.length}/{lineItems}
        </span>
      ) : null}
    </span>
  );
}
