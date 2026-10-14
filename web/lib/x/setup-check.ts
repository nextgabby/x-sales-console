/**
 * The campaign against the internal setup playbooks: the Q3 2026 Campaign Success Checklist and
 * Beautiful Ads. Better Results.
 *
 * The whole point is that these are *computed*, not inferred by a model. Handing Grok a PDF and a
 * campaign and asking "does this follow the playbook" invites it to guess at settings it was never
 * given and to launder the guess as a finding. So every line below is evaluated here against a
 * field the Ads API actually returned, and the Grok panel is handed the verdicts to explain and
 * prioritise — the same division of labour as the benchmark and pacing panels.
 *
 * Three things this deliberately does not do.
 *
 * **It does not scold a regulated advertiser.** The checklist says "all ages, both genders, whole
 * countries only" because broad targeting is how X's delivery learns. But a live betting account in
 * this very book restricts to 21+ and excludes Nevada and Arizona, and that is gambling law, not a
 * mistake. Narrowing like that is reported as `review`, never `fail`: off-playbook, plausibly on
 * purpose, worth a sentence in the next conversation. Only settings with no legitimate reading —
 * accelerated pacing, optimized targeting switched off — are a `fail`.
 *
 * **It does not pretend to check what it cannot see.** Captions, the strength of a video hook,
 * whether a CTA is baked into the image, whether the production looks native: none of it is in the
 * API. Those lines are listed as unchecked rather than quietly counted as passes, because a rep
 * reading "28 of 28" would reasonably conclude the creative had been reviewed.
 *
 * **It does not resolve the two playbooks' disagreement by picking one.** They differ on copy
 * length — the checklist asks for ~40–60 characters, Beautiful Ads for under 100 — so the pass bar
 * is the looser, measured one and the tighter target is named in the detail. On video length they
 * contradict outright (under 15 seconds versus "view rates stay flat from 15 seconds to over a
 * minute"), which is moot here only because duration is not in the data; if it ever is, that needs
 * a human decision rather than a quiet choice in this file.
 */
import type { TargetingSummary } from "./targeting";
import { measureCopy } from "./copy-shape";

export type SetupStatus = "pass" | "fail" | "review" | "unchecked";

export type SetupSection =
  | "must-have"
  | "targeting"
  | "delivery"
  | "structure"
  | "creative"
  | "hygiene";

export type SetupFinding = {
  id: string;
  /** The playbook line, close to verbatim, so a rep can match it to the document they were sent. */
  rule: string;
  status: SetupStatus;
  /** What this campaign actually has. Always a fact, never advice. */
  detail: string;
  section: SetupSection;
  /** From the checklist's own MUST-HAVES block. */
  critical: boolean;
  /** Which playbook the line comes from, for a rep who wants to go and read it. */
  source: "checklist" | "beautiful-ads";
};

export type SetupCheck = {
  findings: SetupFinding[];
  counts: Record<SetupStatus, number>;
  /** Live line items the settings were read from. Zero means almost nothing is checkable. */
  lineItems: number;
  /** Creatives whose copy was measured. */
  creatives: number;
};

export const SECTION_LABEL: Record<SetupSection, string> = {
  "must-have": "Must-haves",
  targeting: "Targeting — broad for scale and learning",
  // Separate from targeting even though the checklist prints them together under one "breadth"
  // heading. Pacing and frequency caps are not targeting, and a rep scanning for who the campaign
  // reaches should not have to read past how fast it spends.
  delivery: "Delivery",
  structure: "Structure and bidding",
  creative: "Creative",
  hygiene: "Learning and launch hygiene",
};

/** Daily budget the checklist wants per unit of target CPA, for enough signal to learn. */
const BUDGET_TO_CPA_MULTIPLE = 20;

/** The checklist's ceiling on ad groups per campaign. */
const MAX_AD_GROUPS = 4;

/** Beautiful Ads' measured copy ceiling; the checklist's tighter target is `IDEAL_COPY_CHARS`. */
const MAX_COPY_CHARS = 100;
const IDEAL_COPY_CHARS = 60;

/** Days after launch the checklist asks for no changes at all, so delivery can calibrate. */
const LEARNING_DAYS = 5;

/** Objectives where a conversion pixel is the difference between optimising and guessing. */
const CONVERSION_OBJECTIVES = new Set([
  "WEBSITE_CONVERSIONS",
  "WEBSITE_CLICKS",
  "APP_INSTALLS",
  "APP_ENGAGEMENTS",
  "CATALOG_SALES",
]);

/** Objectives sold on attention rather than response, where the playbook wants prices left off. */
const AWARENESS_OBJECTIVES = new Set(["REACH", "AWARENESS", "VIDEO_VIEWS", "PREROLL_VIEWS"]);

/**
 * Targeting types that narrow who can be reached, each a checklist line of its own.
 *
 * `regulated` marks the two where narrowing is routinely a legal obligation rather than a choice —
 * an age gate on gambling or alcohol, a market the advertiser is not licensed in. Those say so, and
 * the rest simply ask whether the restriction was intended. Saying "language targeting is sometimes
 * a legal requirement" would be filler dressed up as a caveat.
 */
const NARROWING: Array<{
  id: string;
  rule: string;
  types: string[];
  regulated?: boolean;
}> = [
  { id: "all-ages", rule: "All ages — no age restrictions", types: ["AGE"], regulated: true },
  { id: "both-genders", rule: "Both genders", types: ["GENDER"] },
  { id: "no-language", rule: "No language targeting", types: ["LANGUAGE"] },
  {
    id: "all-platforms",
    rule: "All operating systems and platforms",
    types: ["PLATFORM", "OS_VERSION", "DEVICE", "WIFI_ONLY"],
  },
  { id: "no-carrier", rule: "No carrier targeting", types: ["NETWORK_OPERATOR"] },
];

/** Inclusion types the checklist wants held back at launch and used later as a lever. */
const LAUNCH_LEVERS = [
  "INTEREST",
  "FOLLOWERS_OF_USER",
  "SIMILAR_TO_FOLLOWERS_OF_USER",
  "BROAD_KEYWORD",
  "PHRASE_KEYWORD",
  "EXACT_KEYWORD",
  "UNORDERED_KEYWORD",
  "CONVERSATION",
  "TV_SHOW",
  "EVENT",
];

const KEYWORD_TYPES = ["BROAD_KEYWORD", "PHRASE_KEYWORD", "EXACT_KEYWORD", "UNORDERED_KEYWORD"];

/** The settings the checklist reads, as the Ads API returns them. */
export type SetupLineItem = {
  id: string;
  name: string | null;
  audienceExpansion: string | null;
  bidStrategy: string | null;
  payBy: string | null;
  placements: string[];
  standardDelivery: boolean | null;
  frequencyCap: number | null;
  targetCpa: number | null;
  webEventTag: string | null;
  dailyBudget: number | null;
  startTime: string | null;
  updatedAt: string | null;
};

export type SetupInput = {
  objective: string | null;
  campaignFrequencyCap: number | null;
  campaignDailyBudget: number | null;
  /** Live line items only: what a deleted ad group used to be set to is not this campaign's setup. */
  lineItems: SetupLineItem[];
  targeting: TargetingSummary;
  /** Creative copy, already filtered to the posts actually on this campaign. */
  copy: string[];
  /**
   * How many of the account's other campaigns share this objective, or null when unknown.
   *
   * Objective lives on the line item, not the campaign, so answering this from here would mean
   * fetching every line item on the account — the drawer's whole budget for one checklist line. The
   * dashboard already knows it, so it passes the number in. Null simply leaves the line unchecked.
   */
  objectiveSiblings: number | null;
  /** The account's timezone, so "starts at midnight" is read in the advertiser's own day. */
  timeZone: string;
};

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** "3 of 4 ad groups", collapsing to "both" or "all 4" when it is every one of them. */
function share(count: number, total: number): string {
  if (count !== total) return `${count} of ${total} ${plural(total, "ad group")}`;
  if (total === 1) return "the ad group";
  if (total === 2) return "both ad groups";
  return `all ${total} ad groups`;
}

/** For a `share()` that opens a sentence, since "every ad group" would start it in lower case. */
function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function buildSetupCheck(input: SetupInput): SetupCheck {
  const { lineItems, targeting, objective } = input;
  const findings: SetupFinding[] = [];
  const total = lineItems.length;

  const add = (
    finding: Omit<SetupFinding, "critical" | "source"> &
      Partial<Pick<SetupFinding, "critical" | "source">>,
  ) =>
    findings.push({
      critical: false,
      source: "checklist",
      ...finding,
    });

  /** Line items failing a predicate, so every rule can say which ad groups it means. */
  const failing = (predicate: (item: SetupLineItem) => boolean) => lineItems.filter(predicate);

  const groups = targeting.status === "ok" ? targeting.groups : [];
  const criteriaReadable = targeting.status === "ok" || targeting.status === "none";
  const included = (types: string[]) =>
    groups.filter((group) => types.includes(group.type)).flatMap((group) => group.included);
  const excluded = (types: string[]) =>
    groups.filter((group) => types.includes(group.type)).flatMap((group) => group.excluded);

  // ── Must-haves ─────────────────────────────────────────────────────────────────────────────────

  if (total === 0) {
    add({
      id: "no-line-items",
      rule: "Settings are read from the campaign's ad groups",
      status: "unchecked",
      detail:
        "This campaign has no live ad groups, so none of its delivery settings can be read. " +
        "Everything below comes from the targeting and creative instead.",
      section: "must-have",
      critical: true,
    });
  } else {
    /**
     * `EXPANDED` is the value that turns on what Ads Manager calls Optimized Targeting, and it is
     * off by default — so this is the one setting most likely to be wrong by omission rather than
     * by choice, which is why the checklist leads with it.
     */
    const notExpanded = failing((item) => item.audienceExpansion !== "EXPANDED");
    add({
      id: "optimize-targeting",
      rule: "Optimize Targeting is ON",
      status: notExpanded.length === 0 ? "pass" : "fail",
      detail:
        notExpanded.length === 0
          ? `On for ${share(total, total)}.`
          : `Off for ${share(notExpanded.length, total)} — ${[
              ...new Set(notExpanded.map((item) => item.audienceExpansion ?? "not set")),
            ].join(", ")}. It is off by default, so this is usually an omission rather than a decision.`,
      section: "must-have",
      critical: true,
    });

    const conversion = objective != null && CONVERSION_OBJECTIVES.has(objective);
    const tagged = lineItems.filter((item) => item.webEventTag);
    add({
      id: "pixel",
      rule: "Pixel and/or CAPI implemented",
      status: !conversion ? "unchecked" : tagged.length === total ? "pass" : "review",
      detail: !conversion
        ? `Only a pixel is visible to the API, as a web event tag on the ad group, and this is ${
            objective ? `a ${objective.toLowerCase().replace(/_/g, " ")} campaign` : "not a conversion campaign"
          }, so one is not expected. Server-side CAPI cannot be seen from here either way.`
        : tagged.length === total
          ? `A web event tag is attached to ${share(total, total)}. Whether CAPI is also sending events is not visible to the API.`
          : `No web event tag on ${share(total - tagged.length, total)}. CAPI is not visible to the API, so this may still be covered server-side — worth confirming rather than assuming.`,
      section: "must-have",
      critical: true,
    });

    /**
     * The checklist's rule is against the advertiser's *target* CPA, which only exists in the API
     * when the ad group bids on it. With no target there is no ratio to compute — the goal lives in
     * the media plan, not in the campaign — so this reports unchecked rather than guessing from the
     * CPA actually achieved, which is a different number with a different meaning.
     */
    const withTarget = lineItems.filter((item) => item.targetCpa && item.targetCpa > 0);
    const underfunded = withTarget.filter((item) => {
      const budget = item.dailyBudget ?? input.campaignDailyBudget;
      return budget != null && budget < item.targetCpa! * BUDGET_TO_CPA_MULTIPLE;
    });
    add({
      id: "budget-vs-cpa",
      rule: `Daily budget at least ${BUDGET_TO_CPA_MULTIPLE}× the target CPA`,
      status:
        withTarget.length === 0 ? "unchecked" : underfunded.length === 0 ? "pass" : "review",
      detail:
        withTarget.length === 0
          ? "No ad group bids to a target CPA, so the API does not hold a CPA goal to measure the budget against."
          : underfunded.length === 0
            ? `${cap(share(withTarget.length, total))} ${plural(withTarget.length, "bids", "bid")} to a target CPA, and ${plural(withTarget.length, "its", "their")} daily budget clears ${BUDGET_TO_CPA_MULTIPLE}× it.`
            : `${cap(share(underfunded.length, total))} ${plural(underfunded.length, "has", "have")} a daily budget under ${BUDGET_TO_CPA_MULTIPLE}× the target CPA, which is below the volume the checklist says delivery needs to learn and scale.`,
      section: "must-have",
      critical: true,
    });
  }

  // ── Targeting ──────────────────────────────────────────────────────────────────────────────────

  if (!criteriaReadable) {
    add({
      id: "targeting-unavailable",
      rule: "Targeting kept broad for scale and learning",
      status: "unchecked",
      detail: targeting.reason ?? "The campaign's targeting could not be read.",
      section: "targeting",
    });
  } else {
    for (const { id, rule, types, regulated } of NARROWING) {
      const values = [...included(types), ...excluded(types)];
      add({
        id,
        rule,
        status: values.length === 0 ? "pass" : "review",
        detail:
          values.length === 0
            ? "Unrestricted, so delivery can reach anyone the objective suits."
            : `Set: ${values
                .map((value) => value.label)
                .slice(0, 4)
                .join(", ")}${values.length > 4 ? ` and ${values.length - 4} more` : ""}. ` +
              (regulated
                ? "The playbook wants this left open, but it is a legal requirement in regulated categories — gambling, alcohol, finance — so confirm before raising it."
                : "The playbook wants this left open, so it narrows who delivery can learn from. Worth confirming it was intended."),
        section: "targeting",
      });
    }

    /**
     * A country include is what the checklist asks for; anything finer is the narrowing it warns
     * about. Exclusions count too: excluding two states is still state-level geography, and in a
     * regulated category it is usually the point.
     */
    const locations = [...included(["LOCATION"]), ...excluded(["LOCATION"])];
    const finer = locations.filter(
      (value) => value.locationType && value.locationType !== "COUNTRIES",
    );
    add({
      id: "countries-only",
      rule: "Whole countries only — no states or cities",
      status: finer.length === 0 ? "pass" : "review",
      detail:
        locations.length === 0
          ? "No location targeting at all, which is broader still."
          : finer.length === 0
            ? `Country level only: ${included(["LOCATION"]).map((v) => v.label).join(", ") || "excluded countries only"}.`
            : `Sub-country geography set: ${finer
                .map((value) => `${value.label} (${value.locationType?.toLowerCase()})`)
                .slice(0, 4)
                .join(", ")}${finer.length > 4 ? ` and ${finer.length - 4} more` : ""}. ` +
              "Often a licensing boundary rather than an optimisation choice.",
      section: "targeting",
    });

    const negativeKeywords = excluded(KEYWORD_TYPES);
    add({
      id: "no-keyword-exclusions",
      rule: "No keyword exclusions — brand safety is set at the advertiser level",
      status: negativeKeywords.length === 0 ? "pass" : "review",
      detail:
        negativeKeywords.length === 0
          ? "None, so brand safety is left to the account-level setting as the checklist intends."
          : `${negativeKeywords.length} keyword ${plural(negativeKeywords.length, "exclusion")} on the campaign. ` +
            "These duplicate the advertiser-level brand safety setting and narrow delivery further.",
      section: "targeting",
    });

    const levers = included(LAUNCH_LEVERS);
    add({
      id: "no-levers-at-launch",
      rule: "No interests, follower lookalikes or keyword inclusions at launch",
      status: levers.length === 0 ? "pass" : "review",
      detail:
        levers.length === 0
          ? "None, so delivery is free to find the audience before any of these are layered on."
          : `${levers.length} ${plural(levers.length, "inclusion")} narrowing delivery: ${levers
              .map((value) => value.label)
              .slice(0, 4)
              .join(", ")}${levers.length > 4 ? ` and ${levers.length - 4} more` : ""}. ` +
            "The checklist keeps these back as a later optimisation lever rather than a launch setting.",
      section: "targeting",
    });

    const negativeAudiences = excluded(["CUSTOM_AUDIENCE"]);
    add({
      id: "no-audience-exclusions",
      rule: "No custom audience exclusions",
      status: negativeAudiences.length === 0 ? "pass" : "review",
      detail:
        negativeAudiences.length === 0
          ? "None."
          : `${negativeAudiences.length} audience ${plural(negativeAudiences.length, "exclusion")}: ${negativeAudiences
              .map((value) => value.label)
              .slice(0, 3)
              .join(", ")}. Suppressing existing customers is a common and deliberate exception.`,
      section: "targeting",
    });
  }

  if (total > 0) {
    /**
     * `ALL_ON_TWITTER` is the one value that means every placement including ones added later. A
     * hand-picked list is the "Home Timeline only" narrowing the checklist calls out, even when the
     * list happens to be long.
     */
    const narrowPlacements = failing(
      (item) => !item.placements.includes("ALL_ON_TWITTER") && item.placements.length > 0,
    );
    const noPlacements = failing((item) => item.placements.length === 0);
    add({
      id: "all-placements",
      rule: "All placements — not just Home Timeline",
      status: narrowPlacements.length === 0 ? "pass" : "review",
      detail:
        narrowPlacements.length === 0
          ? noPlacements.length > 0
            ? "No placement restriction set."
            : `Set to all of X on ${share(total, total)}.`
          : `${cap(share(narrowPlacements.length, total))} ${plural(narrowPlacements.length, "names", "name")} placements individually: ${[
              ...new Set(narrowPlacements.flatMap((item) => item.placements)),
            ]
              .map((placement) => placement.replace(/^TWITTER_/, "").toLowerCase().replace(/_/g, " "))
              .join(", ")}. A hand-picked list cannot pick up placements X adds later.`,
      section: "delivery",
    });

    const accelerated = failing((item) => item.standardDelivery === false);
    add({
      id: "standard-pacing",
      rule: "Pacing = Standard",
      status: accelerated.length === 0 ? "pass" : "fail",
      detail:
        accelerated.length === 0
          ? `Standard on ${share(total, total)}.`
          : `Accelerated on ${share(accelerated.length, total)}, which spends the budget as fast as the auction allows rather than evenly across the flight.`,
      section: "delivery",
    });

    const capped = failing((item) => item.frequencyCap != null);
    const campaignCapped = input.campaignFrequencyCap != null;
    add({
      id: "no-frequency-caps",
      rule: "No frequency caps",
      status: capped.length === 0 && !campaignCapped ? "pass" : "review",
      detail:
        capped.length === 0 && !campaignCapped
          ? "None, so delivery is not holding back impressions it would otherwise win."
          : campaignCapped
            ? `A cap of ${input.campaignFrequencyCap} is set on the campaign.`
            : `A cap is set on ${share(capped.length, total)}.`,
      section: "delivery",
    });
  }

  // ── Structure and bidding ──────────────────────────────────────────────────────────────────────

  add({
    id: "one-campaign-per-objective",
    rule: "1 campaign per objective",
    status:
      input.objectiveSiblings == null
        ? "unchecked"
        : input.objectiveSiblings === 0
          ? "pass"
          : "review",
    detail:
      input.objectiveSiblings == null
        ? "Not checked."
        : input.objectiveSiblings === 0
          ? "The only campaign on this objective in the selected range."
          : `${input.objectiveSiblings} other ${plural(input.objectiveSiblings, "campaign")} on this objective delivered in the selected range. ` +
            "Splitting one objective across campaigns divides the signal each has to learn from.",
    section: "structure",
  });

  if (total > 0) {
    add({
      id: "max-ad-groups",
      rule: `Maximum ${MAX_AD_GROUPS} ad groups per campaign`,
      status: total <= MAX_AD_GROUPS ? "pass" : "review",
      detail:
        total <= MAX_AD_GROUPS
          ? `${total} live ${plural(total, "ad group")}.`
          : `${total} live ad groups, over the ${MAX_AD_GROUPS} the checklist allows. Each one divides the budget's learning signal.`,
      section: "structure",
    });

    const notImpressions = failing((item) => item.payBy != null && item.payBy !== "IMPRESSION");
    add({
      id: "bid-on-impressions",
      rule: "Bid on impressions — preferred billing mode",
      status: notImpressions.length === 0 ? "pass" : "review",
      detail:
        notImpressions.length === 0
          ? `Billing on impressions across ${share(total, total)}.`
          : `${cap(share(notImpressions.length, total))} ${plural(notImpressions.length, "bills", "bill")} by ${[
              ...new Set(notImpressions.map((item) => item.payBy!.toLowerCase())),
            ].join(", ")} instead.`,
      section: "structure",
    });

    const notAuto = failing((item) => item.bidStrategy != null && item.bidStrategy !== "AUTO");
    add({
      id: "autobid",
      rule: "Start on AutoBid",
      status: notAuto.length === 0 ? "pass" : "review",
      detail:
        notAuto.length === 0
          ? `AutoBid on ${share(total, total)}.`
          : `${cap(share(notAuto.length, total))} ${plural(notAuto.length, "uses", "use")} ${[
              ...new Set(notAuto.map((item) => (item.bidStrategy === "MAX" ? "a maximum bid" : "a target cost bid"))),
            ].join(" and ")}. A manual bid is a reasonable later move, but the checklist wants launch on AutoBid.`,
      section: "structure",
    });
  }

  // ── Creative ───────────────────────────────────────────────────────────────────────────────────

  const measures = input.copy.map((text) => measureCopy(text));
  if (measures.length === 0) {
    add({
      id: "no-copy",
      rule: "Creative copy checks",
      status: "unchecked",
      detail: "No creative text was available for this campaign, so none of the copy rules could be read.",
      section: "creative",
      source: "beautiful-ads",
    });
  } else {
    const n = measures.length;
    const creatives = (count: number) => `${count} of ${n} ${plural(n, "creative")}`;

    const tooLong = measures.filter((m) => m.characters > MAX_COPY_CHARS).length;
    const overIdeal = measures.filter(
      (m) => m.characters > IDEAL_COPY_CHARS && m.characters <= MAX_COPY_CHARS,
    ).length;
    add({
      id: "copy-length",
      rule: `Copy under ${MAX_COPY_CHARS} characters`,
      status: tooLong === 0 ? "pass" : "review",
      detail:
        tooLong === 0
          ? overIdeal === 0
            ? `All under ${IDEAL_COPY_CHARS} characters, which hits the checklist's tighter ${IDEAL_COPY_CHARS}-character target as well.`
            : `All under ${MAX_COPY_CHARS}. ${creatives(overIdeal)} ${plural(overIdeal, "runs", "run")} past the checklist's tighter ~40–60 character target.`
          : `${creatives(tooLong)} ${plural(tooLong, "runs", "run")} over ${MAX_COPY_CHARS} characters. Short copy measured 10% better CTR and 11% more cost-efficient clicks within the same account.`,
      section: "creative",
      source: "beautiful-ads",
    });

    const withHashtags = measures.filter((m) => m.hashtags > 0).length;
    add({
      id: "no-hashtags",
      rule: "No hashtags",
      status: withHashtags === 0 ? "pass" : "review",
      detail:
        withHashtags === 0
          ? "None."
          : `${creatives(withHashtags)} ${plural(withHashtags, "carries", "carry")} a hashtag.`,
      section: "creative",
    });

    const withEmoji = measures.filter((m) => m.emoji > 0).length;
    add({
      id: "no-emojis",
      rule: "No emojis in copy",
      status: withEmoji === 0 ? "pass" : "review",
      detail:
        withEmoji === 0
          ? "None."
          : `${creatives(withEmoji)} ${plural(withEmoji, "uses", "use")} an emoji.`,
      section: "creative",
      source: "beautiful-ads",
    });

    const shouting = measures.filter((m) => m.capsWords >= 2).length;
    add({
      id: "no-caps",
      rule: "Avoid overusing capitalization",
      status: shouting === 0 ? "pass" : "review",
      detail:
        shouting === 0
          ? "No creative leans on all-caps words."
          : `${creatives(shouting)} ${plural(shouting, "uses", "use")} two or more all-caps words.`,
      section: "creative",
    });

    const manyMentions = measures.filter((m) => m.mentions >= 2).length;
    add({
      id: "limit-mentions",
      rule: "Limit mentions",
      status: manyMentions === 0 ? "pass" : "review",
      detail:
        manyMentions === 0
          ? "At most one mention per creative."
          : `${creatives(manyMentions)} ${plural(manyMentions, "carries", "carry")} two or more mentions.`,
      section: "creative",
    });

    /**
     * The two playbooks only look like they disagree here. The checklist wants numbers and pricing
     * "when relevant"; Beautiful Ads wants prices off *awareness* creative. Relevance is the
     * objective, so the rule is only applied where the second one speaks.
     */
    if (objective != null && AWARENESS_OBJECTIVES.has(objective)) {
      const priced = measures.filter((m) => m.hasPrice).length;
      add({
        id: "no-prices-on-awareness",
        rule: "Keep prices and discounts off awareness creative",
        status: priced === 0 ? "pass" : "review",
        detail:
          priced === 0
            ? "No prices or discounts in the copy, which suits an awareness buy."
            : `${creatives(priced)} ${plural(priced, "names", "name")} a price or discount on an awareness objective.`,
        section: "creative",
        source: "beautiful-ads",
      });
    }
  }

  // ── Launch hygiene ─────────────────────────────────────────────────────────────────────────────

  if (total > 0) {
    /**
     * Midnight in the account's own timezone is what the checklist means, and `start_time` comes
     * back as UTC — so this is read from the account-local hour rather than the raw string. A
     * campaign starting at 13:00Z looks like the middle of the day until you notice the account is
     * in New York, where it is 09:00 and still not midnight.
     */
    const starts = lineItems.filter((item) => item.startTime);
    const offMidnight = starts.filter(
      (item) => localHour(item.startTime!, input.timeZone) !== 0,
    );
    add({
      id: "midnight-start",
      rule: "Campaign starts at midnight",
      status: starts.length === 0 ? "unchecked" : offMidnight.length === 0 ? "pass" : "review",
      detail:
        starts.length === 0
          ? "No start time is set on any ad group."
          : offMidnight.length === 0
            ? "Every ad group starts on the hour at midnight account time."
            : `${cap(share(offMidnight.length, total))} ${plural(offMidnight.length, "starts", "start")} at ${clockHours(offMidnight, input.timeZone)} account time, so the first day delivers against a partial budget.`,
      section: "hygiene",
    });

    /**
     * A real check, within limits. `updated_at` is only the *last* change, so this can tell that
     * the campaign was edited during its learning period but not how many times — and a change
     * after the window closed is ordinary optimisation, not a breach.
     */
    const launchEdited = lineItems.filter((item) => {
      if (!item.startTime || !item.updatedAt) return false;
      const start = new Date(item.startTime).getTime();
      const updated = new Date(item.updatedAt).getTime();
      return updated > start && updated - start < LEARNING_DAYS * 86_400_000;
    });
    add({
      id: "learning-period",
      rule: `${LEARNING_DAYS}-day learning period — no changes after launch`,
      status: launchEdited.length === 0 ? "pass" : "review",
      detail:
        launchEdited.length === 0
          ? `No ad group was edited within ${LEARNING_DAYS} days of its start.`
          : `${cap(share(launchEdited.length, total))} ${plural(launchEdited.length, "was", "were")} edited within ${LEARNING_DAYS} days of launch, which resets what delivery had learned. ` +
            "Only the most recent edit is visible, so this cannot say how many changes there were.",
      section: "hygiene",
    });
  }

  const counts: Record<SetupStatus, number> = { pass: 0, fail: 0, review: 0, unchecked: 0 };
  for (const finding of findings) counts[finding.status] += 1;

  return { findings, counts, lineItems: total, creatives: measures.length };
}

/**
 * The hour of an ISO instant in a named timezone, as a number from 0 to 23.
 *
 * `Intl` rather than arithmetic, because the offset depends on the date — a campaign that started
 * in August and an account in New York differ by four hours, not five.
 */
function localHour(iso: string, timeZone: string): number | null {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return null;
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).format(time);
  const parsed = Number(hour);
  // `hourCycle` h24 renders midnight as 24 in some ICU versions, so both spellings mean midnight.
  return Number.isNaN(parsed) ? null : parsed % 24;
}

/**
 * The distinct local start hours as "06:00", or "06:00 and 14:00" when ad groups disagree.
 *
 * Worth the few lines over a phrase like "mid-day": a flight starting at 05:00 loses a fifth of its
 * first day and one starting at 23:00 loses nearly all of it, and the rep deciding whether to care
 * needs the number. Neither is "mid-day".
 */
function clockHours(items: SetupLineItem[], timeZone: string): string {
  const hours = [
    ...new Set(
      items
        .map((item) => localHour(item.startTime!, timeZone))
        .filter((hour): hour is number => hour != null),
    ),
  ].sort((a, b) => a - b);
  const clock = hours.map((hour) => `${String(hour).padStart(2, "0")}:00`);
  if (clock.length <= 1) return clock[0] ?? "an unknown hour";
  return `${clock.slice(0, -1).join(", ")} and ${clock.at(-1)}`;
}

/**
 * Playbook lines that need something the Ads API does not expose, listed so a rep can see what was
 * *not* checked. Counting these as passes would turn a partial review into a clean bill of health,
 * and creative judgement is exactly where that matters most.
 */
export const UNCHECKABLE: Array<{ rule: string; why: string }> = [
  {
    rule: "Captions on all video ads",
    why: "The API does not report whether a video carries captions.",
  },
  {
    rule: "Videos: length and the strength of the first 3 seconds",
    why: "Video duration is not in the creative data, and the two playbooks disagree here anyway — the checklist asks for under 15 seconds, Beautiful Ads found view rates flat from 15 seconds to over a minute.",
  },
  {
    rule: "No baked-in CTAs, clean image, ~10 words or fewer on the image",
    why: "These are properties of the image, which would need the creative itself to be analysed rather than its performance.",
  },
  {
    rule: "Clear CTAs, benefit-focused copy, native production",
    why: "Judgements about the copy and the look, not measurements — the console measures what it can and leaves these to the rep.",
  },
  {
    rule: "Brand safety = Standard",
    why: "Set at the advertiser level and not returned per campaign.",
  },
  {
    rule: "Budget increases follow the calibration waiting periods",
    why: "Needs the history of every budget change; the API returns only when an ad group was last updated.",
  },
];
