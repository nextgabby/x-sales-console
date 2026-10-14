"use client";

import { useState } from "react";

import { AskGrok } from "@/components/ask-grok";
import { Badge, Callout, cx } from "@/components/ui";
import {
  SECTION_LABEL,
  UNCHECKABLE,
  type SetupCheck,
  type SetupFinding,
  type SetupSection,
  type SetupStatus,
} from "@/lib/x/setup-check";

/**
 * The campaign against the internal setup playbooks.
 *
 * Ordered by what wants doing rather than by the checklist's own order: failures first, then the
 * off-playbook settings that may well be deliberate, and the passes collapsed. A rep opening this
 * mid-call needs the two or three things worth saying, not a wall of ticks — but the ticks have to
 * be reachable, because "we checked, and these 20 are right" is also a thing worth saying.
 */
const ORDER: SetupStatus[] = ["fail", "review", "unchecked", "pass"];

const TONE: Record<SetupStatus, "negative" | "warn" | "neutral" | "positive"> = {
  fail: "negative",
  review: "warn",
  unchecked: "neutral",
  pass: "positive",
};

const STATUS_LABEL: Record<SetupStatus, string> = {
  fail: "Off playbook",
  review: "Check",
  unchecked: "Not checked",
  pass: "Pass",
};

const SECTIONS: SetupSection[] = [
  "must-have",
  "targeting",
  "delivery",
  "structure",
  "creative",
  "hygiene",
];

export function SetupPanel({
  setup,
  accountId,
  campaignId,
  campaignName,
  asUser,
  days,
}: {
  setup: SetupCheck;
  accountId: string;
  campaignId: string;
  campaignName: string;
  asUser: string | null;
  days: number;
}) {
  const [showPasses, setShowPasses] = useState(false);

  const { counts } = setup;
  const actionable = setup.findings.filter(
    (finding) => finding.status === "fail" || finding.status === "review",
  );

  return (
    <section>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Setup against the playbook</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            Every line below is read from the campaign&rsquo;s own settings, not inferred. Measured
            against the Q3 2026 Campaign Success Checklist and Beautiful Ads.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {counts.fail > 0 ? <Badge tone="negative">{counts.fail} off playbook</Badge> : null}
          {counts.review > 0 ? <Badge tone="warn">{counts.review} to check</Badge> : null}
          <Badge tone="positive">{counts.pass} pass</Badge>
        </div>
      </header>

      <div className="mt-3 space-y-3">
        {actionable.length === 0 ? (
          <Callout>
            Nothing in this campaign&rsquo;s settings reads as off playbook. {counts.unchecked} line
            {counts.unchecked === 1 ? "" : "s"} could not be checked from the API — see below for
            which.
          </Callout>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface">
            {SECTIONS.map((section) => {
              const rows = sorted(actionable.filter((f) => f.section === section));
              if (rows.length === 0) return null;
              return <Group key={section} section={section} rows={rows} />;
            })}
          </div>
        )}

        <div>
          <button
            onClick={() => setShowPasses((value) => !value)}
            className="text-xs font-semibold text-muted transition-colors hover:text-ink"
          >
            {showPasses ? "Hide" : "Show"} the {counts.pass + counts.unchecked} line
            {counts.pass + counts.unchecked === 1 ? "" : "s"} that need nothing
          </button>
          {showPasses ? (
            <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-surface">
              {SECTIONS.map((section) => {
                const rows = sorted(
                  setup.findings.filter(
                    (f) =>
                      f.section === section &&
                      (f.status === "pass" || f.status === "unchecked"),
                  ),
                );
                if (rows.length === 0) return null;
                return <Group key={section} section={section} rows={rows} />;
              })}
            </div>
          ) : null}
        </div>

        {/*
          Listed, not hidden. A rep who reads "20 pass" and sees no mention of captions or baked-in
          CTAs would reasonably assume the creative had been reviewed, when in fact the image was
          never looked at — and the image is where most of the Beautiful Ads playbook lives.
        */}
        <details className="rounded-2xl border border-border bg-surface px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-muted transition-colors hover:text-ink">
            {UNCHECKABLE.length} playbook lines the API cannot answer
          </summary>
          <ul className="mt-2.5 space-y-2">
            {UNCHECKABLE.map((item) => (
              <li key={item.rule} className="text-xs leading-relaxed">
                <span className="font-medium text-ink">{item.rule}</span>
                <span className="text-muted"> — {item.why}</span>
              </li>
            ))}
          </ul>
        </details>

        <AskGrok
          endpoint={`/api/accounts/${accountId}/campaigns/${campaignId}/setup-summary`}
          body={{ asUser, days }}
          title="Ask Grok about this setup"
          description="Grounded in the verdicts above, which are computed from the campaign's settings rather than by the model."
          primaryLabel="Review the setup"
          emptyState={
            actionable.length === 0
              ? "Nothing reads as off playbook. Ask what to look at next, or what the unchecked lines would need."
              : `Nothing generated yet. Review the setup, or ask which of the ${actionable.length} to raise first.`
          }
          suggestions={[
            "What should I change first, and what would it be worth?",
            "Which of these are deliberate for this advertiser rather than mistakes?",
            "Write this up for the advertiser conversation",
            "What is this campaign doing right?",
          ]}
          askPlaceholder={`Ask about ${campaignName}'s setup…`}
          unconfiguredHint="Add an xAI key on the setup page to review the setup with Grok."
        />
      </div>
    </section>
  );
}

/** Failures before things to check, and the checklist's own criticals before the rest. */
function sorted(rows: SetupFinding[]): SetupFinding[] {
  return [...rows].sort(
    (a, b) =>
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      Number(b.critical) - Number(a.critical),
  );
}

function Group({ section, rows }: { section: SetupSection; rows: SetupFinding[] }) {
  return (
    <div className="border-b border-border last:border-0">
      <p className="bg-surface-2 px-4 py-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
        {SECTION_LABEL[section]}
      </p>
      <ul className="divide-y divide-border/60">
        {rows.map((finding) => (
          <li key={finding.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TONE[finding.status]}>{STATUS_LABEL[finding.status]}</Badge>
              <span
                className={cx(
                  "text-sm font-medium",
                  finding.status === "pass" ? "text-muted" : "text-ink",
                )}
              >
                {finding.rule}
              </span>
              {finding.critical ? (
                <span className="text-[10px] font-semibold tracking-wide text-accent uppercase">
                  must-have
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{finding.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
