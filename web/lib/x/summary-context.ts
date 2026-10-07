import { formatCurrency } from "../format";
import type { ChatMessage } from "../grok";
import type { CampaignRow, DashboardPayload } from "@/app/accounts/[accountId]/types";
import { METRICS } from "@/app/accounts/[accountId]/metrics";

/**
 * The model receives pre-aggregated numbers, never raw API payloads. Two reasons: raw
 * responses would burn the context window on boilerplate, and a compact table of figures the
 * UI also renders makes it far harder for the model to invent a number.
 */

const SYSTEM_PROMPT = `You are an advertising analyst helping an X (Twitter) sales representative prepare for a conversation with an advertiser.

You will be given real campaign performance data for one ad account, already aggregated. Write a brief, concrete comparison a salesperson can use.

Rules you must follow:
- Use ONLY the numbers provided. Never estimate, extrapolate, or invent a figure. If something is not in the data, say it is not available.
- Refer to campaigns by their given name. When a claim rests on a number, quote that number.
- Every figure is already formatted for display, including currency symbols and percent signs. Quote them exactly as written and never rescale or reformat them.
- Do not compute new figures by combining the ones given; the values are rounded for display.
- Say "a retired campaign" for campaigns marked retired: they were deleted but still spent in this window, so they cannot be optimized, only explained.
- Entities marked TAKEOVER are day buys bought at a flat rate, not auction campaigns. Never compare their CPM, CPE or CPC to an auction campaign's, or describe them as bidding, buying inventory or being efficient or inefficient on cost — the price was negotiated, not won. Their reach and engagement are comparable; their costs are not. Some components are billed at nothing, so a near-zero cost per unit means the cost sat elsewhere in the package, not that it was cheap.
- Where a pacing line is given, treat it as the authoritative verdict and do not recompute it. Pacing is measured against the campaign's own flight, not the window shown, so do not compare it to the window's spend. A campaign that is behind pace or has stopped delivering is the most important thing to lead with, ahead of efficiency metrics.
- Days marked provisional may still change as billing settles. Do not present provisional spend as final.
- Do not recommend specific bid or budget changes as if you could make them; this tool is read-only. Frame suggestions as talking points.
- Be direct and specific. No preamble, no restating the question, no filler like "based on the data provided".

Format: 2 to 4 short paragraphs, or a short paragraph plus tight bullets. Plain text with simple markdown. Under 250 words unless asked otherwise.`;

/**
 * Values are rendered with the same formatter the UI uses, so the figures the model quotes are
 * character-for-character the ones on screen. Sending raw numbers instead invites unit
 * mistakes — a CTR of 0.0053 gets reported as "0.0053%" rather than "0.53%".
 */
function formatted(spec: (typeof METRICS)[number], totals: Parameters<typeof spec.value>[0], currency: string | null) {
  return spec.format(spec.value(totals), currency);
}

/** A coarse shape of the daily series, cheaper than sending every day and enough for trend talk. */
function describeTrend(series: number[] | undefined): string {
  const values = (series ?? []).filter((value) => Number.isFinite(value));
  const active = values.filter((value) => value > 0);
  if (active.length === 0) return "no activity";

  const half = Math.floor(values.length / 2);
  const first = values.slice(0, half).reduce((sum, value) => sum + value, 0);
  const second = values.slice(half).reduce((sum, value) => sum + value, 0);

  let direction = "steady";
  if (first > 0 && second > first * 1.15) direction = "rising";
  else if (first > 0 && second < first * 0.85) direction = "falling";
  else if (first === 0 && second > 0) direction = "started mid-window";

  const peak = Math.max(...active);
  const mean = active.reduce((sum, value) => sum + value, 0) / active.length;
  const spiky = peak > mean * 3 ? ", spiky" : "";

  return `${direction}, active ${active.length} of ${values.length} days${spiky}`;
}

/**
 * The budget recommendation, handed over verbatim for the same reason as the verdict: the model
 * asked to optimise a behind-pace campaign will otherwise reach for a daily figure of its own, and
 * it has no way to know whether the cap or the delivery is the binding constraint.
 */
function describeAdvice(
  advice: CampaignRow["pacing"]["advice"],
  currency: string | null,
): string {
  if (!advice) return "";

  const required = `${formatCurrency(advice.requiredDaily, currency)}/day`;
  switch (advice.lever) {
    case "raise-budget":
      return `; RECOMMENDED DAILY BUDGET ${required}${
        advice.currentDaily != null
          ? ` (up from ${formatCurrency(advice.currentDaily, currency)})`
          : ""
      } to deliver in full`;
    case "fix-delivery":
      return `; finishing in full needs only ${required}, which the current daily budget already allows — the constraint is delivery, not budget, so do NOT recommend raising it`;
    case "unrecoverable":
      return `; delivering in full would need ${required}, too large a change to recommend as a budget edit — the end date or the committed total is what needs revisiting`;
    case "coverage":
      /**
       * The one lever that forbids rather than recommends. A rep has told the app this campaign
       * only delivers when something fires, so the daily rate is arithmetic about a pattern the
       * buy does not follow; left unqualified the model reads the shortfall and recommends more
       * budget, which is the advice the label exists to prevent.
       */
      return `; this campaign delivers in bursts by design, so a daily rate is NOT the lever — do NOT recommend raising or lowering the budget, and do not treat the gaps in delivery as a fault. If the committed budget is at risk it is because the buy has not been triggered often enough, which is a question about trend coverage`;
  }
}

/**
 * Pacing in words, pre-computed. The model is told the verdict rather than the raw inputs because
 * deriving "behind pace" from a spend figure and two dates is exactly the arithmetic it should not
 * be doing, and the answer is already on screen.
 */
function describePacing(pacing: CampaignRow["pacing"], currency: string | null): string | null {
  const percent = (value: number | null) =>
    value == null ? "unknown" : `${Math.round(value * 100)}%`;

  /**
   * Named before the verdict, not after it. "BEHIND" is the first word the model reads, and a
   * caveat arriving three clauses later does not stop it opening with a campaign in trouble.
   */
  /**
   * Only the bursty label qualifies a verdict. A custom creative label is stated too, because it is
   * worth knowing what is being judged, but it is explicitly not an excuse: those campaigns deliver
   * continuously, and a model told "this is a bespoke unit" with no further instruction reaches for
   * exactly the reassurance the trend label is meant to earn and this one is not.
   */
  const labelled =
    pacing.label === "trend-genius"
      ? "LABELLED BY THE REP AS A TREND GENIUS BUY, which only delivers when a matching trend fires — intermittent delivery is expected. "
      : pacing.label === "l4r" || pacing.label === "custom"
        ? `LABELLED BY THE REP AS A CUSTOM CREATIVE BUY (${pacing.label === "l4r" ? "L4R" : "custom unit"}), which delivers continuously like any other campaign — this label does NOT excuse a pacing problem. `
        : "";

  switch (pacing.status) {
    case "underpacing":
      return labelled + (pacing.basis === "flight"
        ? `BEHIND — ${percent(pacing.consumed)} of the total budget spent with ${percent(
            pacing.elapsed,
          )} of the flight elapsed; ${formatCurrency(
            pacing.projectedShortfall ?? 0,
            currency,
          )} projected to go unspent, ${pacing.daysRemaining} days left${describeAdvice(
            pacing.advice,
            currency,
          )}`
        : `BEHIND — recent daily spend is ${percent(pacing.deliveryRate)} of the daily budget`);
    case "overpacing":
      return `AHEAD — ${percent(pacing.consumed)} of the total budget spent with ${percent(
        pacing.elapsed,
      )} of the flight elapsed; the budget runs out before the flight ends`;
    case "on-pace":
      return (
        labelled +
        (pacing.basis === "flight"
          ? `ON PACE — ${percent(pacing.consumed)} spent against ${percent(pacing.elapsed)} elapsed`
          : `ON PACE — recent daily spend is ${percent(pacing.deliveryRate)} of the daily budget`)
      );
    case "dark":
      return `STOPPED DELIVERING — still live with ${formatCurrency(
        pacing.dailyBudget ?? 0,
        currency,
      )} a day of budget but spending nothing recently`;
    case "idle":
      return `NEVER DELIVERED in this window despite ${formatCurrency(
        pacing.dailyBudget ?? 0,
        currency,
      )} a day of budget`;
    case "ended":
      return `FLIGHT ENDED having spent ${percent(pacing.consumed)} of the total budget`;
    case "paused":
      return "PAUSED";
    case "scheduled":
      return "FLIGHT NOT STARTED";
    default:
      return null;
  }
}

function campaignBlock(campaign: CampaignRow, currency: string | null, index: number): string {
  const lines = [
    `${index + 1}. ${campaign.name}${campaign.takeover ? " [TAKEOVER — flat-rate day buy, costs not comparable to auction campaigns]" : ""}${campaign.retired ? " [RETIRED — deleted but spent in this window]" : ""}`,
    `   id: ${campaign.id}`,
    `   objective: ${campaign.objective ?? "unknown"}`,
    `   status: ${campaign.effectiveStatus ?? campaign.entityStatus ?? "unknown"}`,
  ];

  if (campaign.dailyBudget != null) {
    lines.push(`   daily budget: ${formatCurrency(campaign.dailyBudget, currency)}`);
  }
  if (campaign.totalBudget != null) {
    lines.push(`   total budget: ${formatCurrency(campaign.totalBudget, currency)}`);
  }

  const pacingLine = describePacing(campaign.pacing, currency);
  if (pacingLine) lines.push(`   pacing: ${pacingLine}`);

  const hasVideo = campaign.totals.videoViews > 0;
  for (const spec of METRICS) {
    if (spec.video && !hasVideo) continue;
    lines.push(`   ${spec.label}: ${formatted(spec, campaign.totals, currency)}`);
  }

  lines.push(`   daily spend shape: ${describeTrend(campaign.series?.spend)}`);
  return lines.join("\n");
}

export function buildComparePrompt(options: {
  dashboard: DashboardPayload;
  selected: CampaignRow[];
  question: string | null;
}): ChatMessage[] {
  const { dashboard, selected, question } = options;
  const { account, range } = dashboard;
  const currency = account.currency ?? "USD";

  const header = [
    `Account: ${account.name}${account.businessName ? ` (${account.businessName})` : ""}`,
    `Currency: ${currency}`,
    `Timezone: ${account.timezone}`,
    `Window: ${range.dates[0]} to ${range.dates[range.dates.length - 1]} (${range.days} days)`,
    range.provisionalDays > 0
      ? `Provisional: the last ${range.provisionalDays} days of spend may still change.`
      : `Provisional: none — all spend in this window has settled.`,
    `Account spend across all campaigns in this window: ${formatCurrency(dashboard.totals.spend, account.currency)}`,
    dashboard.takeovers.count > 0
      ? dashboard.takeovers.included
        ? `That account figure MIXES ${dashboard.takeovers.count} flat-rate takeover buys (${formatCurrency(
            dashboard.takeovers.spend,
            account.currency,
          )}) with auction campaigns, so account-level cost rates are not a price the advertiser could buy at. Say so if you quote one.`
        : `It excludes ${dashboard.takeovers.count} takeover buys worth ${formatCurrency(
            dashboard.takeovers.spend,
            account.currency,
          )}, which are hidden here as they are in Ads Manager. Do not describe the account total as all of the advertiser's spend.`
      : null,
    dashboard.pacing.trackedCampaigns > 0
      ? `Account budget pacing, covering every budgeted campaign in the account and not just the ones below: ${formatCurrency(
          dashboard.pacing.committedBudget,
          account.currency,
        )} committed across ${dashboard.pacing.trackedCampaigns} campaigns, ${formatCurrency(
          dashboard.pacing.projectedSpend,
          account.currency,
        )} projected to be spent, ${formatCurrency(
          dashboard.pacing.budgetAtRisk,
          account.currency,
        )} at risk of going unspent. Do not attribute this to the campaigns below unless their own pacing lines account for it.`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const metricNotes = [
    "Metric definitions: CTR = clicks / impressions. Engagement rate = engagements / impressions.",
    "CPM = cost per 1,000 impressions. CPE = cost per engagement. CPC = cost per click. CPV = cost per video view.",
    "View rate = video views / impressions. Completions = views that reached 100%.",
    "For CPM, CPE, CPC and CPV, lower is better. Spend itself is neither good nor bad.",
    "Impressions are delivery counts, not unique people; do not describe them as reach.",
  ].join(" ");

  const body = [
    header,
    "",
    `Campaigns being compared (${selected.length}):`,
    selected.map((campaign, index) => campaignBlock(campaign, account.currency, index)).join("\n\n"),
    "",
    metricNotes,
  ].join("\n");

  const task = question
    ? `Answer this question about the campaigns above: ${question}`
    : [
        "Compare these campaigns. Cover:",
        "- any budget pacing problem, which matters more to this conversation than efficiency does",
        "- which is performing best and on which specific metrics",
        "- which is underperforming, and what the numbers suggest is behind it",
        "- anything notable in how spend moved over the window",
        "- two or three talking points for the advertiser conversation",
      ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${body}\n\n---\n\n${task}` },
  ];
}
