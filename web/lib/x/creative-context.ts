import { formatCurrency, formatNumber } from "../format";
import type { ChatMessage } from "../grok";
import { isRankable, MIN_CLICKS_TO_RANK, MIN_IMPRESSIONS_TO_RANK } from "./creatives";
import type {
  CampaignDetailPayload,
  PromotedPostRow,
} from "@/app/accounts/[accountId]/types";
import { METRICS, type MetricSpec } from "@/app/accounts/[accountId]/metrics";

/**
 * Creative-level context for Grok. Same principle as the compare prompt — pre-aggregated, display
 * formatted figures rather than raw payloads — with two additions that exist because of what the
 * live data actually looks like.
 *
 * Rankings are computed here rather than left to the model. "Rank these by CTR" is the question reps
 * ask first, and sorting a dozen percentages is exactly the arithmetic that produces a confidently
 * wrong answer, so each creative arrives already carrying its position.
 *
 * Copy attributes are measured here too. Asking why one creative wins invites the model to eyeball
 * the text and guess at length or tone, so character counts, link and hashtag counts and similar are
 * counted in code and handed over as facts.
 */

const SYSTEM_PROMPT = `You are an advertising analyst helping an X (Twitter) sales representative understand which ad creatives in one campaign are working, and why.

You will be given real per-creative performance data, already aggregated, along with measured attributes of each creative's copy.

Rules you must follow:
- Use ONLY the numbers provided. Never estimate, extrapolate, or invent a figure. If something is not in the data, say it is not available.
- Every figure is already formatted for display, including currency symbols and percent signs. Quote them exactly as written and never rescale or reformat them.
- Do not compute new figures by combining the ones given; the values are rounded for display.
- Each creative carries pre-computed rank positions. Use them as given. Do not re-derive a ranking by comparing the numbers yourself, and do not rank creatives marked NOT RANKABLE — they have too little delivery for a rate to mean anything, so they can be described but never called best or worst.
- Copy attributes (character counts, links, hashtags, emoji, and so on) are measured facts you may cite. The causal claim is yours and must be supported: only attribute a performance difference to copy when the creatives being compared actually differ in that respect, and say it is a pattern worth testing rather than a proven cause.
- Where creatives are marked as sharing identical copy, the difference between them cannot be the copy. Attribute it to placement, targeting, bid or the line item they ran in.
- Creative format (video, photo) is only listed when the API exposed it. Where it is absent, do not assume what the creative looks like.
- Rates computed over few clicks move easily. With a small number of rankable creatives, say the read is directional rather than conclusive.
- Do not describe impressions as reach or as people; they are delivery counts.
- This tool is read-only. Frame suggestions as talking points or things to test, not as changes you are making.
- Be direct and specific. No preamble, no restating the question, no filler like "based on the data provided".

Format: short paragraphs, or a short paragraph plus tight bullets. When ranking, use a numbered list. Plain text with simple markdown. Under 300 words unless asked otherwise.`;

/**
 * How many creatives are described in the prompt. Campaigns with 187 creatives exist, and the long
 * tail is almost entirely creatives with too little delivery to rank; sending all of them would
 * crowd out the ones the rep can act on.
 */
const PROMPT_LIMIT = 20;

/** Metrics worth a rank position. Spend and raw counts are context, not a verdict. */
const RANKED_KEYS = new Set([
  "ctr",
  "engagementRate",
  "cpm",
  "cpe",
  "cpc",
  "viewRate",
  "cpv",
]);

type Ranked = { rank: number; of: number };

/**
 * Rank among rankable creatives only, best first. Zero-cost entries are excluded from
 * lower-is-better metrics for the same reason `bestIndex` excludes them: never charged is not
 * cheapest.
 */
function rankBy(posts: PromotedPostRow[], spec: MetricSpec): Map<string, Ranked> {
  const usable = posts.filter((post) => {
    const value = spec.value(post.totals);
    return Number.isFinite(value) && value > 0;
  });

  const sorted = [...usable].sort((a, b) =>
    spec.direction === "lower"
      ? spec.value(a.totals) - spec.value(b.totals)
      : spec.value(b.totals) - spec.value(a.totals),
  );

  return new Map(
    sorted.map((post, index) => [post.id, { rank: index + 1, of: sorted.length }]),
  );
}

/** Words and characters ignoring URLs, so a t.co link does not read as 23 characters of copy. */
function copyShape(text: string): string {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, " ").trim();
  const words = withoutUrls.split(/\s+/).filter(Boolean);

  const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
  const links = count(/https?:\/\/\S+/g);
  const hashtags = count(/#\w+/g);
  const mentions = count(/@\w+/g);
  const emoji = count(/\p{Extended_Pictographic}/gu);
  const capsWords = words.filter(
    (word) => word.length > 2 && word === word.toUpperCase() && /[A-Z]/.test(word),
  ).length;

  const lineCount = withoutUrls.split("\n").filter((line) => line.trim()).length;

  const parts = [`${withoutUrls.length} characters`, `${words.length} words`];
  if (lineCount > 1) parts.push(`${lineCount} lines`);
  if (links) parts.push(`${links} link${links > 1 ? "s" : ""}`);
  else parts.push("no link");
  if (hashtags) parts.push(`${hashtags} hashtag${hashtags > 1 ? "s" : ""}`);
  if (mentions) parts.push(`${mentions} mention${mentions > 1 ? "s" : ""}`);
  if (emoji) parts.push(`${emoji} emoji`);
  if (capsWords) parts.push(`${capsWords} all-caps word${capsWords > 1 ? "s" : ""}`);
  if (/\?/.test(withoutUrls)) parts.push("asks a question");
  if (/!/.test(withoutUrls)) parts.push("uses an exclamation");
  if (/\d/.test(withoutUrls)) parts.push("contains a number");

  return parts.join(", ");
}

/**
 * Chooses which creatives to describe. Every rankable one comes first, since those are the only
 * ones a verdict can rest on, then the biggest remaining spenders fill the rest of the budget.
 */
function selectForPrompt(posts: PromotedPostRow[]): PromotedPostRow[] {
  const delivered = posts.filter((post) => post.totals.impressions > 0);
  const rankable = delivered.filter(isRankable);
  const rest = delivered.filter((post) => !isRankable(post));

  return [...rankable, ...rest].slice(0, PROMPT_LIMIT);
}

function creativeBlock(options: {
  post: PromotedPostRow;
  index: number;
  currency: string | null;
  hasVideo: boolean;
  ranks: Map<string, Map<string, Ranked>>;
  duplicateOf: string | null;
}): string {
  const { post, index, currency, hasVideo, ranks, duplicateOf } = options;
  const rankable = isRankable(post);

  const lines = [
    `${index}. creative ${post.id}${rankable ? "" : " [NOT RANKABLE — too little delivery to judge its rates]"}`,
  ];

  if (post.lineItemName) lines.push(`   ran in line item: ${post.lineItemName}`);
  if (post.approvalStatus && post.approvalStatus !== "ACCEPTED") {
    lines.push(`   approval: ${post.approvalStatus} — this can explain weak or zero delivery`);
  }
  if (post.mediaType) lines.push(`   format: ${post.mediaType}`);

  if (post.text) {
    lines.push(`   copy: ${JSON.stringify(post.text)}`);
    lines.push(`   copy shape: ${copyShape(post.text)}`);
  } else {
    lines.push("   copy: not available for this creative");
  }
  if (duplicateOf) {
    lines.push(
      `   IDENTICAL COPY to creative ${duplicateOf} — any performance difference is not the copy`,
    );
  }

  for (const spec of METRICS) {
    if (spec.video && !hasVideo) continue;
    const value = spec.format(spec.value(post.totals), currency);
    const position = rankable ? ranks.get(spec.key)?.get(post.id) : undefined;
    lines.push(
      position
        ? `   ${spec.label}: ${value} (rank ${position.rank} of ${position.of})`
        : `   ${spec.label}: ${value}`,
    );
  }

  return lines.join("\n");
}

export function buildCreativePrompt(options: {
  detail: CampaignDetailPayload;
  question: string | null;
}): ChatMessage[] {
  const { detail, question } = options;
  const { campaign, currency, range } = detail;
  const posts = detail.promotedPosts;

  const delivered = posts.filter((post) => post.totals.impressions > 0);
  const rankable = delivered.filter(isRankable);
  const selected = selectForPrompt(posts);
  const hasVideo = detail.totals.videoViews > 0;

  const ranks = new Map<string, Map<string, Ranked>>();
  for (const spec of METRICS) {
    if (!RANKED_KEYS.has(spec.key)) continue;
    if (spec.video && !hasVideo) continue;
    ranks.set(spec.key, rankBy(rankable, spec));
  }

  /**
   * Identical copy promoted through different line items is common — one campaign ran the same post
   * twice with a 0.27% and a 0.64% CTR — and without flagging it the model reaches for a copy
   * explanation that cannot exist.
   */
  const firstByCopy = new Map<string, string>();
  const duplicateOf = new Map<string, string>();
  for (const post of selected) {
    if (!post.text) continue;
    const key = post.text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
    const first = firstByCopy.get(key);
    if (first) duplicateOf.set(post.id, first);
    else firstByCopy.set(key, post.id);
  }

  const header = [
    `Campaign: ${campaign.name}`,
    `Objective: ${campaign.objective ?? "unknown"}`,
    `Status: ${campaign.effectiveStatus ?? campaign.entityStatus ?? "unknown"}`,
    `Currency: ${currency ?? "USD"}`,
    `Window: ${range.dates[0]} to ${range.dates[range.dates.length - 1]} (${range.days} days)`,
    `Campaign spend in this window: ${formatCurrency(detail.totals.spend, currency)}`,
    `Creatives: ${posts.length} in the campaign, ${delivered.length} delivered impressions, ${rankable.length} have enough delivery to rank.`,
    `Rankable means at least ${formatNumber(MIN_IMPRESSIONS_TO_RANK)} impressions and ${formatNumber(
      MIN_CLICKS_TO_RANK,
    )} clicks.`,
    selected.length < delivered.length
      ? `Only the ${selected.length} most relevant are listed below; ${delivered.length - selected.length} lower-spending creatives are omitted.`
      : null,
    detail.warnings.length > 0 ? `Data caveats: ${detail.warnings.join(" ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const metricNotes = [
    "Metric definitions: CTR = clicks / impressions. Engagement rate = engagements / impressions.",
    "CPM = cost per 1,000 impressions. CPE = cost per engagement. CPC = cost per click. CPV = cost per video view.",
    "View rate = video views / impressions. Completions = views that reached 100%.",
    "For CPM, CPE, CPC and CPV, lower is better. Spend itself is neither good nor bad.",
    "Rank 1 is always the best on that metric, whichever direction is better.",
  ].join(" ");

  const body = [
    header,
    "",
    `Creatives (${selected.length}):`,
    selected
      .map((post, index) =>
        creativeBlock({
          post,
          index: index + 1,
          currency,
          hasVideo,
          ranks,
          duplicateOf: duplicateOf.get(post.id) ?? null,
        }),
      )
      .join("\n\n"),
    "",
    metricNotes,
  ].join("\n");

  const task = question
    ? `Answer this question about the creatives above: ${question}`
    : [
        "Assess these creatives. Cover:",
        "- which creative is performing best, on which metrics, using the ranks given",
        "- what the strongest and weakest creatives differ in, including anything in the copy that looks like a pattern worth testing",
        "- which creatives are not delivering enough to judge yet",
        "- two or three concrete things to test next",
      ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${body}\n\n---\n\n${task}` },
  ];
}
