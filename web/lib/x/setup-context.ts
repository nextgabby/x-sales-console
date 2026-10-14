import type { ChatMessage } from "../grok";
import { SECTION_LABEL, UNCHECKABLE, type SetupCheck } from "./setup-check";
import type { CampaignDetailPayload } from "@/app/accounts/[accountId]/types";

/**
 * Setup-checklist context for Grok.
 *
 * The verdicts arrive already decided. Nothing here asks the model whether a setting follows the
 * playbook — `buildSetupCheck` answered that from the API's own fields — so the job left is
 * explanation and triage: which of these matters most on this campaign, what it is worth, and how a
 * rep raises it with the advertiser.
 *
 * The guardrails exist because this is the panel most likely to generate confident nonsense. Two
 * failure modes drove them. The playbook is a general rulebook, and the first instinct of a model
 * told "all ages, both genders, whole countries" is to recommend removing a betting advertiser's
 * 21+ gate and its state exclusions — advice that is illegal to follow. And the unchecked lines are
 * an invitation: asked about captions or baked-in CTAs, a model that has been handed a campaign will
 * happily describe creative it has never seen.
 */
const SYSTEM_PROMPT = `You are an advertising analyst helping an X (Twitter) sales representative review how one campaign is set up, against two internal playbooks: the Q3 2026 Campaign Success Checklist and "Beautiful Ads. Better Results."

The campaign has ALREADY been checked against both. You are given each playbook line, the verdict, and what the campaign actually has. Your job is to explain and prioritise, not to re-check.

What the verdicts mean:
- PASS — the setting matches the playbook. Nothing to do.
- OFF PLAYBOOK — the setting contradicts the playbook and has no routine legitimate reading. These are the real findings.
- CHECK — the setting is off playbook but plausibly deliberate. Narrow targeting, exclusions, manual bidding and the like. Raise it as a question, never as an error.
- NOT CHECKED — the API does not expose what this line needs. You know nothing about it.

Rules you must not break:
- Use ONLY the verdicts and details given. Never say a campaign has a setting that is not described below, and never re-derive a verdict.
- NEVER recommend removing an age restriction, a geographic restriction, a keyword exclusion or an audience exclusion. In regulated categories — gambling, alcohol, finance, pharmaceuticals, political — these are legal requirements, and this data does not tell you the advertiser's category. Ask whether it is required; do not advise undoing it.
- A CHECK is a conversation, not a defect. Say what the playbook prefers and why, then ask whether the current setting is deliberate.
- For NOT CHECKED lines, say only that they were not checked and what it would take to check them. You have NOT seen the campaign's images or video. Never describe, evaluate or speculate about a creative's visuals, captions, length, hook or baked-in CTA.
- Where the two playbooks disagree, say so rather than picking one. They differ on copy length: the checklist asks for ~40-60 characters, Beautiful Ads measured under 100. On video length they contradict outright.
- Effect sizes quoted in the details are measured within the same advertiser. You may cite them as given. Do not invent effect sizes for anything else, and do not promise a result from a change.
- Do not count or re-total the verdicts; the rep can already see the totals.
- This tool is read-only. You are advising a representative who will talk to the advertiser, so frame everything as a talking point or a test, never as a change you are making.
- Be direct. No preamble, no restating the question, no "based on the data provided".

Rules about priority:
- Lead with whichever finding would change delivery most on THIS campaign, not whichever comes first in the list. Optimized Targeting switched off and accelerated pacing change delivery immediately; a hashtag in the copy does not.
- Make at most three recommendations. One sentence on what, one on why, naming the specific setting.
- If there is nothing off playbook, say so plainly and stop. That is a useful answer, not a failure to find something.

Format: one short paragraph on how the campaign is set up overall, then tight bullets. Plain text with simple markdown. Under 300 words unless asked otherwise.`;

const VERDICT: Record<string, string> = {
  pass: "PASS",
  fail: "OFF PLAYBOOK",
  review: "CHECK",
  unchecked: "NOT CHECKED",
};

const SOURCE: Record<string, string> = {
  checklist: "Campaign Success Checklist",
  "beautiful-ads": "Beautiful Ads",
};

export function buildSetupMessages(options: {
  detail: CampaignDetailPayload;
  setup: SetupCheck;
  question?: string;
}): ChatMessage[] {
  const { detail, setup, question } = options;
  const { campaign, range } = detail;

  const lines: string[] = [
    `Campaign: ${campaign.name}`,
    `Objective: ${campaign.objective ?? "unknown"}`,
    `Status: ${campaign.effectiveStatus ?? campaign.entityStatus ?? "unknown"}`,
    `Window: ${range.dates[0]} to ${range.dates[range.dates.length - 1]} (${range.days} days)`,
    `Settings were read from ${setup.lineItems} live ad group${setup.lineItems === 1 ? "" : "s"}` +
      `, and copy from ${setup.creatives} creative${setup.creatives === 1 ? "" : "s"}.`,
    "",
  ];

  /**
   * Grouped by verdict rather than by section, because the model's job is triage. Leading with the
   * passes would bury the findings under twenty lines of agreement.
   */
  for (const status of ["fail", "review", "unchecked", "pass"] as const) {
    const rows = setup.findings.filter((finding) => finding.status === status);
    if (rows.length === 0) continue;

    lines.push(`${VERDICT[status]} (${rows.length}):`);
    for (const finding of rows) {
      lines.push(
        `- [${SECTION_LABEL[finding.section]}${finding.critical ? ", MUST-HAVE" : ""}] ` +
          `"${finding.rule}" (${SOURCE[finding.source]}) — ${finding.detail}`,
      );
    }
    lines.push("");
  }

  /**
   * Named explicitly as well as being absent, because "what about the creative?" is the obvious
   * follow-up question and the model needs to have been told it cannot answer it.
   */
  lines.push(
    "Playbook lines that could not be checked at all, because the API does not expose what they need:",
    ...UNCHECKABLE.map((item) => `- "${item.rule}" — ${item.why}`),
  );

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: question
        ? `${lines.join("\n")}\n\nThe representative asks: ${question}`
        : `${lines.join("\n")}\n\nReview how this campaign is set up against the playbooks.`,
    },
  ];
}
