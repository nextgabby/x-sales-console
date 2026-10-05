import type { Campaign } from "./accounts";
import { adsRequest, adsRequestAll, chunkEntityIds } from "./ads-client";
import { fetchEntityTotals, MAX_ASYNC_DAYS, StatsJobError } from "./async-stats";
import { addSeries, emptySeries, metricGroupsFor, totalSeriesFrom, type MetricSeries } from "./stats";
import { buildRangeBetween, localDate } from "./time";
import type { XCredentials } from "../store";
import type { Actor } from "../auth/actor";

/**
 * History older than the dashboard's 90-day window, fetched only when the recent window has too
 * little to compare against.
 *
 * The gap this fills is a real one: an advertiser who last ran a video-view campaign five months ago
 * has no 90-day cohort for the video-view campaign running today, and the panel's only honest answer
 * was to refuse. Sales were filling that gap from a shared spreadsheet they maintained by hand, and
 * at least one vertical was reading benchmarks off last year's deck because the spreadsheet stopped
 * being kept up. The data is live in the API the whole time — the "90 days" in the docs is the
 * longest span a single request may cover, not how far back the figures exist. Spend was confirmed
 * at 95, 120, 150 and 365 days back on a live account.
 *
 * What makes this affordable is being targeted. Widening the dashboard's own window to a year would
 * mean 52 synchronous windows for every batch of 20 campaigns, which on a hundred-campaign account
 * is enough requests to exhaust the 250-per-15-minutes limit and leave the rep with a partial build.
 * This asks `active_entities` which campaigns spent in the older period, narrows to the handful on
 * the objective in question, and fetches only those — as asynchronous jobs, which cover 90 days
 * each instead of 7.
 */

/** How far back to look in total, including the days the dashboard already covers. */
export const MAX_LOOKBACK_DAYS = 365;

/** `active_entities` takes at most 90 days per request, the same as an unsegmented job. */
const MAX_ACTIVE_ENTITIES_DAYS = 90;

type ActiveEntity = { entity_id: string };
type LineItem = { campaign_id?: string | null; objective?: string | null };

export type ExtendedCampaign = {
  id: string;
  name: string;
  retired: boolean;
  /** Totals for the whole older period as a single column, not a daily series. */
  series: MetricSeries;
};

export type ExtendedHistory = {
  campaigns: ExtendedCampaign[];
  /** Oldest and newest account-local dates searched, for labelling the baseline's age. */
  fromDate: string;
  toDate: string;
  /** Set when nothing was found, so the panel can say the older period was searched and was empty. */
  reason: string | null;
};

/**
 * Contiguous windows covering `fromDate`..`toDate`, none longer than `maxDays`.
 *
 * Exported for testing. An over-long or non-contiguous window here does not fail: the API accepts
 * the request and returns a different period from the one intended, so this is checked directly.
 */
export function spanWindows(
  fromDate: string,
  toDate: string,
  timeZone: string,
  maxDays: number,
): Array<{ startTime: string; endTime: string }> {
  /**
   * `buildRangeBetween` splits into 7-day synchronous windows, which is the wrong size here but the
   * right timezone arithmetic — midnight has to be account-local, and getting it wrong does not
   * error, it silently shifts the whole reporting period. So its windows are regrouped rather than
   * recomputed: the start of a group's first window and the end of its last are already correct
   * instants, and a group of twelve is 84 days, inside every limit that applies.
   */
  const range = buildRangeBetween(fromDate, toDate, timeZone);
  const perGroup = Math.floor(maxDays / 7);
  const windows: Array<{ startTime: string; endTime: string }> = [];

  for (let index = 0; index < range.windows.length; index += perGroup) {
    const group = range.windows.slice(index, index + perGroup);
    windows.push({
      startTime: group[0]!.startTime,
      endTime: group[group.length - 1]!.endTime,
    });
  }

  return windows;
}

export async function fetchExtendedHistory(options: {
  credentials: XCredentials;
  accountId: string;
  asUser: string | null;
  actor: Actor;
  timeZone: string;
  /** Only campaigns on this objective are worth fetching; it is what the cohort is defined by. */
  objective: string;
  /** Days the dashboard already covered, which this picks up from. */
  coveredDays: number;
  lookbackDays?: number;
  /** Campaigns already in the recent build, excluded so no campaign is counted twice. */
  excludeIds: Set<string>;
}): Promise<ExtendedHistory> {
  const {
    credentials,
    accountId,
    asUser,
    actor,
    timeZone,
    objective,
    coveredDays,
    lookbackDays = MAX_LOOKBACK_DAYS,
    excludeIds,
  } = options;

  const audit = { actor, accountId };
  const fromDate = localDate(lookbackDays, timeZone);
  // The dashboard's window starts at `coveredDays` back, so the older period ends the day before.
  const toDate = localDate(coveredDays + 1, timeZone);
  const empty = (reason: string): ExtendedHistory => ({
    campaigns: [],
    fromDate,
    toDate,
    reason,
  });

  if (fromDate >= toDate) return empty("There is no older period to search.");

  const activeWindows = spanWindows(fromDate, toDate, timeZone, MAX_ACTIVE_ENTITIES_DAYS);

  const spentIds = new Set<string>();
  const activeResults = await Promise.all(
    activeWindows.map((window) =>
      adsRequest<{ data?: ActiveEntity[] }>({
        path: `/stats/accounts/${accountId}/active_entities`,
        credentials,
        asUser,
        audit,
        query: { entity: "CAMPAIGN", start_time: window.startTime, end_time: window.endTime },
      })
        .then((response) => response.data ?? [])
        .catch(() => null),
    ),
  );

  /**
   * A dropped window means campaigns that spent in those months are invisible here. Returning a
   * cohort assembled from what did arrive would quietly present a benchmark built on part of the
   * period as though it covered all of it, so the whole lookback is abandoned instead.
   */
  if (activeResults.some((result) => result === null)) {
    return empty("Older history could not be loaded in full, so it was left out.");
  }
  for (const entries of activeResults) {
    for (const entry of entries ?? []) spentIds.add(entry.entity_id);
  }

  /**
   * The full campaign list, refetched rather than taken from the dashboard, because the dashboard's
   * rows are only the campaigns that spent in the last 90 days — the ones this is looking for are by
   * definition not among them. Deleted campaigns are included: they were real spend against the same
   * objective, and dropping them would quietly shrink the history of any brand that tidies up.
   *
   * Membership here is also the takeover test. An entity that spent but that this endpoint will not
   * describe even with `with_deleted` is a flat-rate day buy, and a negotiated price is not a
   * baseline for anything that ran at auction.
   */
  const described = new Map<string, Campaign>();
  for (const entry of await adsRequestAll<Campaign>({
    path: `/accounts/${accountId}/campaigns`,
    credentials,
    asUser,
    audit,
    query: { with_deleted: true },
  })) {
    described.set(entry.id, entry);
  }

  const candidates = [...spentIds].filter((id) => !excludeIds.has(id) && described.has(id));
  if (candidates.length === 0) {
    return empty("No further campaigns spent in the older period.");
  }

  /**
   * Objectives live on line items, never on the campaign, so this lookup is the only way to tell
   * which of the candidates are comparable. Scoped to the candidates because a large account holds
   * thousands of line items and paging all of them is slower than the stats fetch it precedes.
   */
  const objectiveOf = new Map<string, string>();
  const lineItemResults = await Promise.all(
    chunkEntityIds(candidates).map((chunk) =>
      adsRequestAll<LineItem>({
        path: `/accounts/${accountId}/line_items`,
        credentials,
        asUser,
        audit,
        query: { campaign_ids: chunk.join(","), with_deleted: true },
      }).catch(() => null),
    ),
  );

  if (lineItemResults.some((result) => result === null)) {
    return empty("Objectives for the older campaigns could not be loaded, so they were left out.");
  }
  for (const items of lineItemResults) {
    for (const item of items ?? []) {
      if (item.campaign_id && item.objective && !objectiveOf.has(item.campaign_id)) {
        objectiveOf.set(item.campaign_id, item.objective);
      }
    }
  }

  const matching = candidates.filter((id) => objectiveOf.get(id) === objective);
  if (matching.length === 0) {
    return empty("No older campaign ran on this objective either.");
  }

  // Only this objective's metrics are needed, so a video cohort does not pay for conversion columns.
  const metricGroups = metricGroupsFor([objective]);

  const statsWindows = spanWindows(fromDate, toDate, timeZone, MAX_ASYNC_DAYS);
  const accumulated = new Map<string, MetricSeries>();

  /**
   * Windows run in sequence rather than together. The job cap is per advertiser account, so a rep
   * firing five jobs per drawer is five against a limit shared with whatever else is syncing that
   * account — and each job is polled, so the wall-clock saving from overlapping them is small
   * against the risk of being the reason somebody else's sync is rejected.
   */
  for (const window of statsWindows) {
    for (const chunk of chunkEntityIds(matching)) {
      let totals: Map<string, Record<string, unknown>>;
      try {
        totals = await fetchEntityTotals({
          credentials,
          accountId,
          asUser,
          actor,
          entity: "CAMPAIGN",
          entityIds: chunk,
          startTime: window.startTime,
          endTime: window.endTime,
          metricGroups,
        });
      } catch (error) {
        /**
         * Same reasoning as a dropped active-entities window, and it matters more here: a missing
         * stats window understates whichever campaigns ran in it, which does not look like missing
         * data on screen. It looks like those campaigns were cheap.
         */
        if (error instanceof StatsJobError) {
          return empty("Older history was still being prepared by the X Ads API, so it was left out.");
        }
        throw error;
      }

      for (const [id, metrics] of totals) {
        const series = accumulated.get(id) ?? emptySeries(1);
        // Added rather than assigned: a campaign that ran across two windows reports in both.
        addSeries(series, totalSeriesFrom(metrics));
        accumulated.set(id, series);
      }
    }
  }

  const campaigns: ExtendedCampaign[] = [];
  for (const [id, series] of accumulated) {
    const entry = described.get(id);
    if (!entry) continue;
    campaigns.push({ id, name: entry.name, retired: Boolean(entry.deleted), series });
  }

  if (campaigns.length === 0) {
    return empty("Older campaigns on this objective reported no delivery.");
  }

  return { campaigns, fromDate, toDate, reason: null };
}
