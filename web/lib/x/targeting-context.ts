import { formatCurrency, formatNumber, formatPercent, formatUnitCost } from "../format";
import type { ChatMessage } from "../grok";
import type { TargetingSummary } from "./targeting";
import type { CampaignDetailPayload, LineItemRow } from "@/app/accounts/[accountId]/types";

/**
 * Targeting context for Grok: what the campaign is set to reach, line item by line item, beside
 * what each line item delivered.
 *
 * The guardrails below are longer than the usual set, because targeting is the one area where a
 * plausible-sounding recommendation can do real damage. Three cases drove them. An exclusion looks
 * like a mistake and is usually a licensing restriction or a regulator — a model told to optimise
 * reach will suggest removing it. A custom audience is an opaque name over a list this tool cannot
 * see inside, so anything said about who is in it is invention. And the targeting a campaign does
 * not have is unbounded: without being told to stay close to what is configured, the answer becomes
 * a generic list of X ad products rather than advice about this campaign.
 *
 * Delivered demographics are deliberately absent. They come from the segmented async jobs, which
 * can take most of a minute, and a rep pressing this button should not wait for two of them before
 * the first token arrives. The system prompt says so, so the model cannot claim them.
 */

const SYSTEM_PROMPT = `You are an advertising analyst helping an X (Twitter) sales representative review the targeting on one campaign and advise the advertiser on it.

You will be given the campaign's actual targeting criteria, read from the X Ads API, grouped by targeting type and broken down by line item, along with each line item's delivery in the reporting window.

Rules about the targeting data:
- Use ONLY the criteria listed. Never state or imply that a campaign targets something that is not in the list.
- A targeting type that is absent from the list is not set on this campaign. You may raise it as something to consider, but never describe it as currently configured.
- Criteria marked EXCLUDED are negative targeting. Exclusions are almost always deliberate — regulatory restrictions, licensing, brand safety, or an audience being handled by another campaign — and the reason is NOT in this data. You may note that an exclusion narrows reach. You must NOT recommend removing one, and must not describe one as a mistake or an error.
- Custom audiences are advertiser-uploaded lists. You are given their names only. Do not infer who is in a list beyond what its name literally says, and do not estimate its size or quality.
- An audience marked DELETED no longer exists, so it contributes nothing. That is worth raising directly.
- Where a criterion is noted as being on some line items and not others, that asymmetry is a fact you may reason about. Where no such note appears, it is on every line item.
- Targeting is set on line items, not campaigns. Say "line item" when you mean one.
- You cannot see audience sizes, reach estimates, forecasted impressions, or how many people match a criterion. None of that is available; never produce a number for it.
- Delivered audience demographics (the age and gender the campaign actually reached) are NOT in this data. Do not claim to know them or compare them against the age targeting.

Rules about the performance figures:
- Every figure is already formatted for display, including currency symbols and percent signs. Quote them exactly as written. Do not rescale, reformat or recombine them.
- Do not describe impressions as reach or as people; they are delivery counts.
- A line item with little delivery cannot support a verdict on its targeting. Say the read is directional.
- Correlation between a line item's targeting and its performance is not proof. Frame it as the pattern in the data and name the obvious alternative explanations (bid, budget, creative, placement) where they apply.

Rules about recommendations:
- Stay close to what is configured. Recommend changes to this campaign's targeting, not a tour of every X targeting product.
- Make at most three recommendations, each one sentence of what to change and one of why, pointing at the specific criterion or line item.
- If the targeting looks sound given the objective, say so plainly and recommend nothing. That is a valid and useful answer.
- This tool is read-only and you are advising a sales representative who will discuss it with the advertiser. Frame everything as a talking point or a test, never as a change you are making.
- Be direct and specific. No preamble, no restating the question, no filler like "based on the data provided".

Format: a short paragraph on what the targeting is, then tight bullets. Plain text with simple markdown. Under 300 words unless asked otherwise.`;

/** Values listed per group before the rest are summarised as a count. */
const VALUES_PER_GROUP = 25;

function valueList(
  values: TargetingSummary["groups"][number]["included"],
  lineItemCount: number,
  lineItemNumbers: Map<string, number>,
): string {
  const shown = values.slice(0, VALUES_PER_GROUP).map((value) => {
    const notes: string[] = [];
    if (value.missing) notes.push("DELETED — this list no longer exists");
    if (!value.everywhere && lineItemCount > 1) {
      const which = value.lineItemIds
        .map((id) => lineItemNumbers.get(id))
        .filter((n): n is number => n != null)
        .sort((a, b) => a - b);
      notes.push(`only on line item ${which.join(", ")} of ${lineItemCount}`);
    }
    return notes.length > 0 ? `${value.label} (${notes.join("; ")})` : value.label;
  });

  const omitted = values.length - shown.length;
  if (omitted > 0) shown.push(`and ${omitted} more not listed`);
  return shown.join(", ");
}

function lineItemBlock(options: {
  item: LineItemRow;
  number: number;
  currency: string | null;
  own: string[];
}): string {
  const { item, number, currency, own } = options;
  const lines = [`${number}. ${item.name ?? item.id}${item.retired ? " [RETIRED]" : ""}`];

  lines.push(
    `   delivery: ${formatCurrency(item.totals.spend, currency)} spend, ` +
      `${formatNumber(item.totals.impressions)} impressions, ` +
      `${formatPercent(item.totals.ctr)} CTR, ` +
      `${formatUnitCost(item.totals.cpm, currency)} CPM`,
  );
  lines.push(
    own.length > 0
      ? `   targeting: ${own.join(" | ")}`
      : "   targeting: none of its own — delivery on this line item is unconstrained",
  );

  return lines.join("\n");
}

export function buildTargetingPrompt(options: {
  detail: CampaignDetailPayload;
  question: string | null;
}): ChatMessage[] {
  const { detail, question } = options;
  const { campaign, currency, range, targeting } = detail;

  /**
   * Numbered rather than referred to by id, so the model has a short handle for each line item that
   * matches the list it is reading. Only live line items appear in the targeting, so a retired one
   * is numbered too but will show no criteria.
   */
  const lineItemNumbers = new Map(detail.lineItems.map((item, index) => [item.id, index + 1]));
  const lineItemCount = targeting.lineItems;

  const header = [
    `Campaign: ${campaign.name}`,
    `Objective: ${campaign.objective ?? "unknown"}`,
    `Status: ${campaign.effectiveStatus ?? campaign.entityStatus ?? "unknown"}`,
    `Currency: ${currency ?? "USD"}`,
    `Window: ${range.dates[0]} to ${range.dates[range.dates.length - 1]} (${range.days} days)`,
    `Campaign spend in this window: ${formatCurrency(detail.totals.spend, currency)}`,
    `Campaign CTR: ${formatPercent(detail.totals.ctr)}, CPM: ${formatUnitCost(detail.totals.cpm, currency)}`,
    campaign.dailyBudget != null
      ? `Daily budget: ${formatCurrency(campaign.dailyBudget, currency)}`
      : null,
    detail.warnings.length > 0 ? `Data caveats: ${detail.warnings.join(" ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const groupLines = targeting.groups.flatMap((group) => {
    const lines: string[] = [];
    if (group.included.length > 0) {
      lines.push(`- ${group.label}: ${valueList(group.included, lineItemCount, lineItemNumbers)}`);
    }
    if (group.excluded.length > 0) {
      lines.push(
        `- ${group.label} EXCLUDED: ${valueList(group.excluded, lineItemCount, lineItemNumbers)}`,
      );
    }
    return lines;
  });

  /** Each line item's own criteria, inverted from the grouped values. */
  const ownCriteria = new Map<string, string[]>();
  for (const group of targeting.groups) {
    for (const [values, prefix] of [
      [group.included, ""],
      [group.excluded, "not "],
    ] as const) {
      for (const value of values) {
        for (const id of value.lineItemIds) {
          const existing = ownCriteria.get(id) ?? [];
          existing.push(`${group.label}: ${prefix}${value.label}`);
          ownCriteria.set(id, existing);
        }
      }
    }
  }

  const body = [
    header,
    "",
    `Targeting across the campaign's ${lineItemCount} live line item${lineItemCount === 1 ? "" : "s"}:`,
    groupLines.length > 0 ? groupLines.join("\n") : "- none set on any line item",
    targeting.untargetedLineItems > 0
      ? `\n${targeting.untargetedLineItems} of ${lineItemCount} line items carry no criteria at all, so their delivery is unconstrained.`
      : null,
    "",
    `Line items (${detail.lineItems.length}):`,
    detail.lineItems
      .map((item, index) =>
        lineItemBlock({
          item,
          number: index + 1,
          currency,
          own: ownCriteria.get(item.id) ?? [],
        }),
      )
      .join("\n\n"),
    "",
    "Metric definitions: CTR = clicks / impressions. CPM = cost per 1,000 impressions, where lower is better.",
  ]
    .filter(Boolean)
    .join("\n");

  const task = question
    ? `Answer this question about the targeting above: ${question}`
    : [
        "Review this targeting. Cover:",
        "- what the campaign is currently set to reach, in plain terms a rep can say out loud",
        "- whether that targeting fits the campaign's objective",
        "- anything in it that is working against delivery, including line items with no targeting and audiences that no longer exist",
        "- at most three recommendations, or none if the targeting is sound",
      ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${body}\n\n---\n\n${task}` },
  ];
}
