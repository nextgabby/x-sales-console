import { adsRequestAll, chunkEntityIds } from "./ads-client";
import type { XCredentials } from "../store";
import type { Actor } from "../auth/actor";

/**
 * What a campaign is set to target, as opposed to who it actually reached.
 *
 * `lib/x/audience.ts` answers the second question from delivery data; this answers the first from
 * the advertiser's own settings, and the two disagreeing is usually the interesting part. Targeting
 * lives on the line item, so a campaign's targeting is the union of its line items' — which means a
 * value can be on some and not others, and saying so matters: "United States" on one of four line
 * items is a different campaign from one targeting it throughout.
 */
export type TargetingValue = {
  label: string;
  /**
   * The line items carrying this criterion, not merely how many.
   *
   * The panel only needs the count, but the Grok prompt inverts this to describe each line item's
   * own targeting beside its own performance — which is where the useful comparison lives, a narrow
   * line item beating a broad one. Carrying the ids costs a few characters and saves a second,
   * parallel copy of the same data on the payload.
   */
  lineItemIds: string[];
  /** False when only some line items carry it, so the panel can say so. */
  everywhere: boolean;
  /**
   * A custom audience whose source list has since been deleted. The campaign still names it, so it
   * is shown rather than dropped — a retargeting campaign aimed at a list that no longer exists
   * looks fully configured from every other angle.
   */
  missing?: boolean;
};

export type TargetingGroup = {
  /** Raw `targeting_type`, kept so the UI never has to reverse a label back to an API value. */
  type: string;
  label: string;
  included: TargetingValue[];
  excluded: TargetingValue[];
};

/** A deterministic observation, in the same spirit as `buildInsights`: arithmetic, never a model. */
export type TargetingSignal = {
  title: string;
  detail: string;
};

export type TargetingSummary = {
  /** `none` is a campaign whose line items carry no criteria at all, which is not an error. */
  status: "ok" | "none" | "unavailable";
  reason?: string;
  groups: TargetingGroup[];
  lineItems: number;
  /** Line items with no criteria of their own, so their delivery is unconstrained. */
  untargetedLineItems: number;
  signals: TargetingSignal[];
};

type CriterionResponse = {
  id: string;
  line_item_id?: string | null;
  name?: string | null;
  targeting_type?: string | null;
  targeting_value?: string | number | null;
  operator_type?: string | null;
};

type CustomAudienceResponse = {
  id: string;
  name?: string | null;
  deleted?: boolean;
};

/**
 * Display order, loosely how a media plan is read: who and where first, then what they are
 * interested in, then the accounts and lists the buy is built from. Types absent here still render,
 * after these, under a humanised version of their API name — the Ads API adds targeting types
 * faster than this list can track, and an unknown one is better shown than silently dropped.
 */
const TYPE_LABELS: Array<[type: string, label: string]> = [
  ["LOCATION", "Locations"],
  ["AGE", "Age"],
  ["GENDER", "Gender"],
  ["LANGUAGE", "Languages"],
  ["PLATFORM", "Platforms"],
  ["DEVICE", "Devices"],
  ["OS_VERSION", "OS versions"],
  ["WIFI_ONLY", "Connection"],
  ["NETWORK_OPERATOR", "Carriers"],
  ["INTEREST", "Interests"],
  ["CONVERSATION", "Conversation topics"],
  ["EVENT", "Events"],
  ["TV_SHOW", "TV shows"],
  ["BROAD_KEYWORD", "Keywords, broad"],
  ["PHRASE_KEYWORD", "Keywords, phrase"],
  ["EXACT_KEYWORD", "Keywords, exact"],
  ["UNORDERED_KEYWORD", "Keywords, unordered"],
  ["APP_STORE_CATEGORY", "App store categories"],
  ["INSTALLED_APP_STORE_CATEGORY", "Installed app categories"],
  ["IAB_CATEGORY", "Content categories"],
  ["CONTENT_PUBLISHER_USER", "Publishers"],
  ["FOLLOWERS_OF_USER", "Followers of"],
  ["SIMILAR_TO_FOLLOWERS_OF_USER", "Similar to followers of"],
  ["CUSTOM_AUDIENCE", "Custom audiences"],
  ["ENGAGEMENT_TYPE", "Engagement retargeting"],
  ["USER_ENGAGEMENT", "User engagement retargeting"],
  ["CAMPAIGN_ENGAGEMENT", "Campaign engagement retargeting"],
];

const LABEL_BY_TYPE = new Map(TYPE_LABELS);
const ORDER_BY_TYPE = new Map(TYPE_LABELS.map(([type], index) => [type, index]));

/** Types whose `name` is a handle rather than a phrase, so it reads as one. */
const HANDLE_TYPES = new Set(["FOLLOWERS_OF_USER", "SIMILAR_TO_FOLLOWERS_OF_USER"]);

function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `AGE_OVER_21` and `AGE_25_TO_49` are the two shapes X uses. */
function ageLabel(raw: string): string {
  const over = /^AGE_OVER_(\d+)$/.exec(raw);
  if (over) return `${over[1]} and over`;
  const between = /^AGE_(\d+)_TO_(\d+)$/.exec(raw);
  if (between) return `${between[1]}\u2013${between[2]}`;
  return humanise(raw);
}

function valueLabel(
  criterion: CriterionResponse,
  audienceNames: Map<string, CustomAudienceResponse>,
): { label: string; missing?: boolean } | null {
  const type = criterion.targeting_type ?? "";
  const name = criterion.name?.trim() || null;
  const raw = criterion.targeting_value != null ? String(criterion.targeting_value) : null;

  if (type === "CUSTOM_AUDIENCE") {
    /**
     * Every custom audience criterion comes back named "Custom audience targeting", so the name is
     * resolved from the audience itself. Falling back to the id rather than that placeholder: an id
     * is at least something a rep can paste into Ads Manager.
     */
    const audience = raw ? audienceNames.get(raw) : undefined;
    const label = audience?.name?.trim() || raw || "Unnamed audience";
    return audience?.deleted ? { label, missing: true } : { label };
  }

  if (type === "AGE" && name) return { label: ageLabel(name) };

  /**
   * Two retargeting types carry their information in `targeting_value` and leave `name` as an enum
   * echoing the type: `ENGAGEMENT_TYPE` is named `RETARGETING_ENGAGEMENT_TYPE` with a value of
   * `IMPRESSION`, and `USER_ENGAGEMENT` is named `USER_ENGAGER_RETARGETING` with an account id for
   * a value. Both verified on a live campaign. Taking the name would print the group's own label
   * back at the reader twice over, which is how this read before the live check.
   */
  if (type === "ENGAGEMENT_TYPE") return raw ? { label: humanise(raw) } : null;
  if (type === "USER_ENGAGEMENT") return raw ? { label: `Account ${raw}` } : null;

  if (!name) return raw ? { label: raw } : null;
  if (HANDLE_TYPES.has(type)) return { label: `@${name.replace(/^@/, "")}` };
  // An all-caps enum leaking through as a name reads as shouting in a list of place names.
  return { label: /^[A-Z0-9_]+$/.test(name) ? humanise(name) : name };
}

export async function buildTargeting(options: {
  credentials: XCredentials;
  accountId: string;
  /** Every line item on the campaign, including retired ones the caller chose to show. */
  lineItemIds: string[];
  asUser: string | null;
  actor: Actor;
}): Promise<TargetingSummary> {
  const { credentials, accountId, lineItemIds, asUser, actor } = options;
  const audit = { actor, accountId };
  const empty = { groups: [], lineItems: lineItemIds.length, untargetedLineItems: 0, signals: [] };

  if (lineItemIds.length === 0) {
    return { ...empty, status: "none" };
  }

  let criteria: CriterionResponse[];
  try {
    /**
     * One request per 200 line items, which is a whole campaign in every case seen so far. `count`
     * is pushed to the documented maximum because the default of 200 would page a campaign with a
     * dozen line items for no reason. Deleted criteria are left out: this panel answers what the
     * campaign targets now, and the API omits them unless asked.
     */
    criteria = (
      await Promise.all(
        chunkEntityIds(lineItemIds, 200).map((chunk) =>
          adsRequestAll<CriterionResponse>({
            path: `/accounts/${accountId}/targeting_criteria`,
            credentials,
            asUser,
            audit,
            query: { line_item_ids: chunk.join(","), count: 1000 },
          }),
        ),
      )
    ).flat();
  } catch (error) {
    /**
     * Degraded rather than thrown. Targeting is one panel in a drawer that is mostly about
     * performance, and losing the whole drawer because this one call failed is the worse outcome.
     */
    return {
      ...empty,
      status: "unavailable",
      reason: `Targeting could not be loaded: ${(error as Error).message}`,
    };
  }

  const audienceIds = [
    ...new Set(
      criteria
        .filter((row) => row.targeting_type === "CUSTOM_AUDIENCE" && row.targeting_value != null)
        .map((row) => String(row.targeting_value)),
    ),
  ];

  const audienceNames = new Map<string, CustomAudienceResponse>();
  if (audienceIds.length > 0) {
    try {
      /**
       * Scoped by id rather than listing the account's audiences: Call of Duty has over 200 and the
       * ones a campaign uses were not on the first page. `with_deleted` is on because a campaign
       * can target a list that has since been removed, and that is worth saying out loud rather
       * than rendering as an unresolved id.
       */
      const audiences = (
        await Promise.all(
          chunkEntityIds(audienceIds, 200).map((chunk) =>
            adsRequestAll<CustomAudienceResponse>({
              path: `/accounts/${accountId}/custom_audiences`,
              credentials,
              asUser,
              audit,
              query: { custom_audience_ids: chunk.join(","), with_deleted: true, count: 1000 },
            }),
          ),
        )
      ).flat();
      for (const audience of audiences) audienceNames.set(audience.id, audience);
    } catch {
      // Names are a nicety; the ids still render, and the criteria above are the real answer.
    }
  }

  const targeted = new Set(
    criteria.map((row) => row.line_item_id).filter((id): id is string => Boolean(id)),
  );

  /** type -> negated -> label -> line items carrying it. */
  const tally = new Map<string, Map<boolean, Map<string, Set<string>>>>();
  const missingLabels = new Set<string>();

  for (const criterion of criteria) {
    const type = criterion.targeting_type?.trim();
    if (!type) continue;
    const resolved = valueLabel(criterion, audienceNames);
    const label = resolved?.label ?? LABEL_BY_TYPE.get(type) ?? humanise(type);
    if (resolved?.missing) missingLabels.add(label);

    const negated = criterion.operator_type === "NE";
    const byNegation = tally.get(type) ?? new Map<boolean, Map<string, Set<string>>>();
    const byLabel = byNegation.get(negated) ?? new Map<string, Set<string>>();
    const carriers = byLabel.get(label) ?? new Set<string>();
    if (criterion.line_item_id) carriers.add(criterion.line_item_id);
    byLabel.set(label, carriers);
    byNegation.set(negated, byLabel);
    tally.set(type, byNegation);
  }

  const totalLineItems = lineItemIds.length;
  const toValues = (byLabel: Map<string, Set<string>> | undefined): TargetingValue[] =>
    [...(byLabel?.entries() ?? [])]
      .map(([label, carriers]) => ({
        label,
        lineItemIds: [...carriers],
        everywhere: carriers.size >= totalLineItems,
        ...(missingLabels.has(label) ? { missing: true } : {}),
      }))
      .sort(
        (a, b) => b.lineItemIds.length - a.lineItemIds.length || a.label.localeCompare(b.label),
      );

  const groups: TargetingGroup[] = [...tally.entries()]
    .map(([type, byNegation]) => ({
      type,
      label: LABEL_BY_TYPE.get(type) ?? humanise(type),
      included: toValues(byNegation.get(false)),
      excluded: toValues(byNegation.get(true)),
    }))
    .sort(
      (a, b) =>
        (ORDER_BY_TYPE.get(a.type) ?? TYPE_LABELS.length) -
          (ORDER_BY_TYPE.get(b.type) ?? TYPE_LABELS.length) || a.label.localeCompare(b.label),
    );

  const untargetedLineItems = totalLineItems - targeted.size;

  return {
    status: groups.length === 0 ? "none" : "ok",
    groups,
    lineItems: totalLineItems,
    untargetedLineItems,
    signals: buildSignals({ groups, totalLineItems, untargetedLineItems }),
  };
}

/**
 * Observations that follow from the targeting alone.
 *
 * Deliberately narrow. Every one of these is a fact about the settings, not advice about them —
 * whether an exclusion is a mistake or a licensing requirement is not knowable from here, so the
 * text names what is set and stops. The Grok panel is where advice belongs, and it is handed these
 * same facts along with the instruction not to second-guess exclusions.
 */
/**
 * Names a few things and counts the rest. One live campaign targeted nine deleted audiences, and
 * naming all nine turned a one-line observation into a paragraph of near-identical list names.
 */
function naming(labels: string[], limit = 3): string {
  if (labels.length <= limit) return labels.join(", ");
  return `${labels.slice(0, limit).join(", ")} and ${labels.length - limit} more`;
}

function buildSignals(input: {
  groups: TargetingGroup[];
  totalLineItems: number;
  untargetedLineItems: number;
}): TargetingSignal[] {
  const { groups, totalLineItems, untargetedLineItems } = input;
  const signals: TargetingSignal[] = [];

  if (untargetedLineItems > 0) {
    signals.push({
      title:
        untargetedLineItems === totalLineItems
          ? "No targeting set"
          : `${untargetedLineItems} of ${totalLineItems} line items untargeted`,
      detail:
        untargetedLineItems === totalLineItems
          ? "No line item on this campaign carries any targeting criteria, so delivery is unconstrained."
          : "Those line items carry no criteria of their own, so their delivery is unconstrained.",
    });
  }

  const excluded = groups.filter((group) => group.excluded.length > 0);
  if (excluded.length > 0) {
    const total = excluded.reduce((sum, group) => sum + group.excluded.length, 0);
    signals.push({
      title: `${total} exclusion${total === 1 ? "" : "s"}`,
      detail:
        `${excluded.map((group) => `${group.label.toLowerCase()} (${group.excluded.length})`).join(", ")}. ` +
        "Exclusions are usually deliberate — regulatory, brand safety or a list already covered elsewhere.",
    });
  }

  const missing = groups
    .flatMap((group) => [...group.included, ...group.excluded])
    .filter((value) => value.missing);
  if (missing.length > 0) {
    signals.push({
      title: `${missing.length} audience${missing.length === 1 ? "" : "s"} no longer exist${missing.length === 1 ? "s" : ""}`,
      detail:
        `${naming(missing.map((value) => value.label))} — the campaign still targets ${missing.length === 1 ? "it" : "them"}, ` +
        "but the list has been deleted, so it contributes nothing to reach.",
    });
  }

  /**
   * The same handle targeted both ways. Not wrong — the follower set and its lookalikes are
   * different people — but worth naming, because reps read the two lines as one audience.
   */
  const followers = new Set(
    groups.find((group) => group.type === "FOLLOWERS_OF_USER")?.included.map((v) => v.label) ?? [],
  );
  const overlap = (
    groups.find((group) => group.type === "SIMILAR_TO_FOLLOWERS_OF_USER")?.included ?? []
  ).filter((value) => followers.has(value.label));
  if (overlap.length > 0) {
    signals.push({
      title: "Followers and lookalikes of the same accounts",
      detail:
        `${overlap.map((value) => value.label).join(", ")} ${overlap.length === 1 ? "is" : "are"} targeted both ` +
        "directly and as a lookalike, which are different people — the reach is wider than the two lines suggest.",
    });
  }

  return signals;
}
