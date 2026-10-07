import type { ChatMessage } from "../grok";

/**
 * Canned Grok answers for the demo.
 *
 * Live AI is off by default because the demo sits behind an open URL and every question would be
 * billed to whoever's key the deployment holds — one shared link is all it takes for that to become
 * someone's problem. Set `DEMO_AI=live` to let the real calls through when showing the feature to a
 * room; otherwise these stand in, so the panel still demonstrates its shape, length and tone.
 *
 * Each answer opens by saying it is a sample. The demo banner says the same thing, but the summary
 * is the part people screenshot, and a figure in a screenshot has to carry its own disclaimer.
 */

type Feature = "compare" | "benchmark" | "creative" | "targeting";

/**
 * Which panel asked. Keyed off wording unique to each system prompt in `lib/x/*-context.ts`, so a
 * prompt can be reworded freely as long as these phrases survive — and a miss falls back to the
 * generic answer rather than putting creative advice under a benchmark heading.
 */
function featureOf(messages: ChatMessage[]): Feature | null {
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  if (system.includes("own recent history")) return "benchmark";
  if (system.includes("ad creatives")) return "creative";
  if (system.includes("review the targeting")) return "targeting";
  if (system.includes("prepare for a conversation")) return "compare";
  return null;
}

/**
 * True when the rep typed their own question rather than taking the default summary. All three
 * prompt builders phrase that instruction as "Answer this question about the ... above:".
 */
function hasQuestion(messages: ChatMessage[]): boolean {
  const user = messages.findLast((message) => message.role === "user")?.content ?? "";
  return /Answer this question about/.test(user);
}

const SAMPLE = "**Sample response.** Live AI is switched off in this demo, so this text is fixed.\n\n";

const ANSWERS: Record<Feature, string> = {
  compare: `${SAMPLE}Across the campaigns you selected, the spread in cost per result is wider than the spread in delivery, which means the difference is coming from auction price rather than from budget.

- **Retargeting — Lapsed 30d** is the most efficient on the objective, at roughly a third of the account's blended cost per install, but it is also the smallest: at its current audience size, raising its budget will push its cost up before it adds meaningful volume.
- **Interest Targeting — Fitness** is the outlier on the other side. It is paying a premium per impression without a matching lift in install rate, so the audience is expensive rather than high-intent.
- **Always-On Installs — iOS Hybrid** carries most of the spend, which is why the account's blended figures track it closely. Any account-level conclusion is really a conclusion about this campaign.

The conversation to have with the advertiser is about the middle of the book, not the extremes: three campaigns are within a few percent of each other on cost per install, and consolidating them would buy simpler reporting rather than better performance.`,

  benchmark: `${SAMPLE}This campaign is running slightly cheaper per install than the advertiser's own recent history on the same objective, and comfortably inside the range their individual campaigns usually land in.

Two things are worth saying out loud in the call. The baseline is weighted by spend, so it mostly describes the advertiser's largest campaign — a campaign priced like the typical one, rather than like the money, will look different against it. And the install rate here is sitting near the top of the range rather than the middle, which is the more durable finding: cost per install can move with the auction from week to week, but a rate that holds above the band usually reflects the audience or the creative.

What this does not tell you is whether the figure is good for the category. The range is built from this advertiser's own campaigns, so it answers "better than before", not "better than their competitors".`,

  creative: `${SAMPLE}The headline creative is carrying this campaign. It takes a little under two thirds of the impressions and a clearly higher share of the clicks, so its click-through rate is well ahead of the alternate cut rather than simply being shown more.

The pattern across the posts points at length. The shorter copy is winning on click-through at similar delivery, and the longer variant explaining the offer in detail is the weakest of the set — the detail is doing work that the landing page could do instead. The broad-reach post sits between the two, which is consistent with a targeting difference rather than a creative one.

The cheap test is to cut the long variant and put its budget behind the headline creative for a week. If the campaign's blended click-through rate rises by roughly what the arithmetic predicts, length was the cause; if it does not, the difference was audience overlap and the creative conclusion was wrong.`,

  targeting: `${SAMPLE}The campaign is built as a narrow core and a broad companion: the core line item carries the audience and interest layers, while the broad one runs on geography, age and language alone. Both are limited to adults in one country, and the exclusions on the campaign stay as they are.

- One of the retargeting lists has been deleted, so it is contributing nothing while still appearing in the setup. Worth confirming with the advertiser whether it was meant to be replaced or dropped.
- The core and broad line items are not comparable on price, because they are not buying the same audience. If the broad line item is cheaper, that is the auction rather than a better audience.
- The interest layer sits on the core line item only. Before widening it, check whether the core is budget-constrained — adding audience to a line item that is already capped moves cost without adding volume.

None of this is a change to make on the call. It is the shape of the buy, and the question to put to the advertiser is which of the two line items they actually want the money in.`,
};

const GENERIC = `${SAMPLE}The figures in this demo are generated, so there is no real pattern here to explain — a live deployment would answer this against the advertiser's own data, citing the specific campaigns and dates behind each claim.

What the real answer looks like: a direct response to the question in the first sentence, the two or three numbers it rests on, and an explicit note when the data cannot support the conclusion being asked for.`;

/** Streams the canned answer in small chunks, so the panel's streaming behaviour is visible. */
export function demoChatStream(messages: ChatMessage[]): ReadableStream<Uint8Array> {
  const feature = featureOf(messages);
  // A typed question gets the generic answer: pretending a fixed summary addresses it would be the
  // one thing a demo must not do, which is appear to answer something it never read.
  const answer = feature && !hasQuestion(messages) ? ANSWERS[feature] : GENERIC;

  const encoder = new TextEncoder();
  const words = answer.split(/(\s+)/);
  let index = 0;

  return new ReadableStream({
    async pull(controller) {
      if (index >= words.length) {
        controller.close();
        return;
      }
      const chunk = words.slice(index, index + 6).join("");
      index += 6;
      await new Promise((resolve) => setTimeout(resolve, 18));
      controller.enqueue(encoder.encode(chunk));
    },
  });
}
