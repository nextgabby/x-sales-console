import { formatCurrency, formatNumber, formatPercent, formatUnitCost, titleCase } from "../format";
import type { ChatMessage } from "../grok";
import type { Benchmark } from "./benchmark";

/**
 * Prompt for "how does this campaign compare to what this brand normally gets".
 *
 * The verdict is handed over already decided, for the same reason pacing is: whether +38% on a cost
 * metric is good or bad depends on which metric it is, and that is a rule, not a judgement. The
 * model's job is to explain the comparison and what to do about it, never to compute it.
 */
const SYSTEM_PROMPT = `You are an advertising analyst helping an X (Twitter) sales representative understand how one campaign compares to the same advertiser's own recent history on the same objective.

Rules you must follow:
- Use ONLY the numbers provided. Never estimate, extrapolate, or invent a figure.
- Every figure is already formatted for display, including currency symbols and percent signs. Quote them exactly as written and never rescale or reformat them.
- Each metric arrives with its comparison already computed and already labelled BETTER or WORSE than the brand's norm. Use those labels as given. Never decide for yourself whether a difference is good: for a cost, lower is better, but for a rate, higher is, and the labels already account for this.
- The metric marked OBJECTIVE KPI is what the campaign exists to achieve, and it outranks every other metric. When it disagrees with CPM or CTR, lead with the objective KPI and say plainly that the cheaper-impressions read is the wrong one. A campaign can pay well above the brand's normal CPM and still be its most efficient buy.
- The baseline is the advertiser's own campaigns, not an industry figure, and it excludes takeover day buys. Never describe it as a market or industry benchmark.
- Two baseline numbers are given per metric and they are not interchangeable. The "brand normally" figure is weighted by volume: what the brand pays overall. The "usual range" is unweighted across its individual campaigns: where one campaign lands. The percentage verdict is measured against the weighted figure only. When a campaign beats the weighted figure but sits outside the range, or the reverse, both readings are true and you must give both rather than picking one — the range is what the sales team quote to advertisers.
- Where the baseline reaches back beyond the recent window, say so and treat it as the brand's track record rather than its current rate. Never present a year-old price as what the advertiser would pay today.
- Volume figures are context only. Do not treat a campaign's spend or install count as better or worse than the baseline: one campaign against a cohort of several is not a fair comparison of size.
- The caveats given are part of the finding, not fine print. If the baseline is concentrated in one campaign, or built from few campaigns, or the install counts lean on view-through attribution, say so where it changes how much weight the comparison carries.
- Where the comparison covers only the days this campaign ran, that is a like-for-like read. Where it covers the full window, say that auction conditions differ across it.
- This tool is read-only. Frame suggestions as talking points, not as changes you are making.
- Be direct and specific. No preamble, no restating the question, no filler like "based on the data provided".

Format: short paragraphs, or a short paragraph plus tight bullets. Plain text with simple markdown. Under 250 words unless asked otherwise.`;

export function buildBenchmarkPrompt(options: {
  campaignName: string;
  benchmark: Benchmark;
  currency: string | null;
  question: string | null;
}): ChatMessage[] {
  const { campaignName, benchmark, currency, question } = options;

  const show = (value: number, format: Benchmark["metrics"][number]["format"]) =>
    format === "currency" ? formatUnitCost(value, currency) : formatPercent(value);

  const lines = [
    `Campaign: ${campaignName}`,
    `Objective: ${benchmark.objective ? titleCase(benchmark.objective) : "unknown"}`,
    benchmark.basis === "concurrent"
      ? `Baseline: ${benchmark.cohort.campaigns} of this advertiser's other campaigns on the same objective, measured over exactly the ${benchmark.campaignDays} days this campaign delivered. This is a like-for-like comparison.`
      : benchmark.lookback
        ? `Baseline: ${benchmark.cohort.campaigns} of this advertiser's other campaigns on the same objective, reaching back to ${benchmark.lookback.fromDate} because the last ${benchmark.windowDays} days held too few. ${benchmark.lookback.campaigns} of them ran before that window, so this is the brand's track record over the past year rather than its current rate.`
        : `Baseline: ${benchmark.cohort.campaigns} of this advertiser's other campaigns on the same objective across ${benchmark.windowDays} days, which spans different auction conditions than this campaign ran in.`,
    `Baseline spend: ${formatCurrency(benchmark.cohort.spend, currency)}`,
    "",
    "Metrics, comparison already computed:",
  ];

  for (const metric of benchmark.metrics) {
    const verdict =
      metric.delta == null
        ? "no baseline to compare against"
        : `${metric.delta > 0 ? "+" : ""}${Math.round(metric.delta * 100)}% versus the brand's norm — ${
            metric.delta < 0 === metric.lowerIsBetter ? "BETTER" : "WORSE"
          }`;
    /**
     * The band has to be given alongside the weighted figure, or the model explains a delta the rep
     * cannot see the other half of. They are different statistics, and the sales team quote the
     * range — so it belongs in the explanation, not just in the table above it.
     */
    const range = metric.band
      ? `; across the ${metric.band.sample} individual campaigns the usual range is ${show(
          metric.band.low,
          metric.format,
        )} to ${show(metric.band.high, metric.format)}, median ${show(metric.band.mid, metric.format)}, and this campaign is ${
          metric.position === "within" ? "inside that range" : `${metric.position} it`
        }`
      : "";

    lines.push(
      `- ${metric.label}${metric.primary ? " [OBJECTIVE KPI]" : ""}: this campaign ${show(
        metric.campaign,
        metric.format,
      )}, brand normally ${show(metric.baseline, metric.format)} (${verdict})${range}`,
    );
  }

  if (benchmark.volume) {
    lines.push(
      "",
      "Volume for context only, not to be judged against the baseline:",
      `- Spend ${formatCurrency(benchmark.volume.spend, currency)}, ${formatNumber(
        benchmark.volume.impressions,
      )} impressions, ${formatNumber(benchmark.volume.clicks)} clicks${
        benchmark.volume.installs > 0
          ? `, ${formatNumber(benchmark.volume.installs)} installs`
          : ""
      }`,
      `- This campaign is ${formatPercent(
        benchmark.volume.spendShare,
        0,
      )} of what the brand spent on this objective`,
    );
  }

  if (benchmark.notes.length > 0) {
    lines.push("", "Caveats that change how much weight this comparison carries:");
    for (const note of benchmark.notes) lines.push(`- ${note}`);
  }

  const task = question
    ? `Answer this question about the comparison above: ${question}`
    : [
        "Explain how this campaign compares to the brand's own history. Cover:",
        "- the verdict on the objective KPI first, and whether the other metrics agree with it",
        "- what the disagreement between metrics means, if they disagree",
        "- how much weight the comparison deserves given the caveats",
        "- two talking points for the advertiser conversation",
      ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${lines.join("\n")}\n\n${task}` },
  ];
}
