import {
  adsRequest,
  adsRequestAll,
  chunkEntityIds,
} from "./ads-client";
import { accountCurrency, type Campaign, type FundingInstrument } from "./accounts";
import {
  chartSeries,
  combineSeries,
  dailySpend,
  fetchDailyStats,
  metricGroupsFor,
  totalsFrom,
  type MetricSeries,
} from "./stats";
import {
  buildPreviousRange,
  buildRange,
  buildRangeBetween,
  dayDiff,
  localDate,
  microsToCurrency,
  provisionalDayCount,
} from "./time";
import {
  computePacing,
  flightsFromLineItems,
  type CampaignFlight,
  type LineItemBudget,
} from "./pacing";
import { readCampaignLabels, type CampaignLabelKind, type XCredentials } from "../store";
import type { CampaignRow, DashboardPayload } from "@/app/accounts/[accountId]/types";
import type { Actor } from "../auth/actor";

export const ALLOWED_DAYS = [7, 14, 30, 90];

export function normalizeDays(value: unknown): number {
  const days = Number(value ?? 7);
  return ALLOWED_DAYS.includes(days) ? days : 7;
}

type AdsAccountDetail = {
  id: string;
  name: string;
  timezone: string;
  approval_status?: string;
  business_name?: string | null;
};

type ActiveEntity = { entity_id: string };
type LineItem = LineItemBudget & { id: string; objective?: string | null };

/**
 * How far back flight-to-date spend will be fetched. A flight that started earlier than this
 * cannot be measured against its budget without an unreasonable number of requests, so those
 * campaigns fall back to the delivery-rate basis instead.
 */
const MAX_FLIGHT_LOOKBACK_DAYS = 92;

export class AccountNotFoundError extends Error {}

/**
 * A takeover has no name in the API, and "Takeover p7m8v" tells a rep nothing. These run as
 * single-day slots, so the date they delivered on is the useful identifier.
 */
function takeoverName(
  spendSeries: number[],
  impressionSeries: number[],
  dates: string[],
): string {
  // Some takeover components are billed at nothing, so delivery is the fallback signal for "when".
  const signal = spendSeries.some((value) => value > 0) ? spendSeries : impressionSeries;
  const active = signal
    .map((value, index) => (value > 0 ? index : -1))
    .filter((index) => index >= 0);
  if (active.length === 0) return "Takeover";

  const first = dates[active[0]!];
  const last = dates[active[active.length - 1]!];
  const label = (date: string | undefined) =>
    date
      ? new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        })
      : "";

  return first === last ? `Takeover · ${label(first)}` : `Takeover · ${label(first)}–${label(last)}`;
}

/**
 * Assembles everything the dashboard shows for one account and range.
 *
 * Lives outside the route handler so the AI summary can be built from the same
 * server-fetched numbers rather than trusting figures posted back from the browser.
 */
export async function buildDashboard(options: {
  credentials: XCredentials;
  accountId: string;
  asUser: string | null;
  days: number;
  actor: Actor;
  /** Opt in to takeover buys, which Ads Manager also hides unless asked for. */
  includeTakeovers?: boolean;
  /**
   * Attaches the full per-campaign daily series for server-side consumers. The benchmark needs
   * day-level conversion figures to restrict a cohort to one campaign's flight, and they are far
   * too large to ship to the browser for an account with a hundred campaigns.
   */
  includeRawSeries?: boolean;
  /**
   * Skips the previous-period fetch and the flight-spend backfill. Both exist only for the
   * dashboard's period-over-period deltas and pacing verdicts, and the benchmark reads neither —
   * dropping them halves the requests for a 90-day build, which took 25 seconds on a large
   * account. `previousTotals` and every pacing verdict are meaningless once this is set, so only a
   * caller that ignores them may pass it.
   */
  skipComparisons?: boolean;
}): Promise<DashboardPayload & { rawSeries?: Record<string, MetricSeries> }> {
  const {
    credentials,
    accountId,
    asUser,
    days,
    actor,
    includeTakeovers = false,
    includeRawSeries = false,
    skipComparisons = false,
  } = options;
  const audit = { actor, accountId };
  const warnings: string[] = [];

  const detail = await adsRequest<{ data?: AdsAccountDetail }>({
    path: `/accounts/${accountId}`,
    credentials,
    asUser,
    audit,
  });
  const account = detail.data;
  if (!account) throw new AccountNotFoundError("Account returned no data.");

  const range = buildRange(days, account.timezone);
  const previousRange = buildPreviousRange(days, account.timezone);

  /**
   * `active_entities` is the authority on what actually spent, and it can name campaigns the
   * campaigns endpoint no longer returns at all. Driving stats from the campaign list instead
   * silently drops that spend from the account total, so the list is only used for metadata
   * and every active ID gets queried.
   */
  const [campaigns, fundingInstruments, activeIds, previousActiveIds, labels] = await Promise.all([
    adsRequestAll<Campaign>({
      path: `/accounts/${accountId}/campaigns`,
      credentials,
      asUser,
      audit,
      // Deleted campaigns keep their spend, so their names are worth having.
      query: { with_deleted: true },
    }),
    adsRequestAll<FundingInstrument>({
      path: `/accounts/${accountId}/funding_instruments`,
      credentials,
      asUser,
      audit,
    }).catch(() => {
      warnings.push("Funding details unavailable.");
      return [] as FundingInstrument[];
    }),
    adsRequest<{ data?: ActiveEntity[] }>({
      path: `/stats/accounts/${accountId}/active_entities`,
      credentials,
      asUser,
      audit,
      query: {
        entity: "CAMPAIGN",
        start_time: range.windows[0]!.startTime,
        end_time: range.windows[range.windows.length - 1]!.endTime,
      },
    })
      .then((active) => new Set((active.data ?? []).map((entry) => entry.entity_id)))
      .catch(() => null),
    /**
     * The prior window needs its own active-entity list. Reusing the current window's would ask
     * for stats only on campaigns that spent *now*, so a flight that ended just before the window
     * — the most common case there is — would contribute nothing to the baseline and every delta
     * would read as growth that never happened.
     */
    skipComparisons
      ? Promise.resolve(null)
      : adsRequest<{ data?: ActiveEntity[] }>({
          path: `/stats/accounts/${accountId}/active_entities`,
          credentials,
          asUser,
          audit,
          query: {
            entity: "CAMPAIGN",
            start_time: previousRange.windows[0]!.startTime,
            end_time: previousRange.windows[previousRange.windows.length - 1]!.endTime,
          },
        })
          .then((active) => new Set((active.data ?? []).map((entry) => entry.entity_id)))
          .catch(() => null),
    /**
     * How the team has labelled this advertiser's campaigns. A local read or one small query, run
     * alongside the API calls rather than after them, and failing soft: an unreachable label store
     * should cost a trend buy its exemption, not cost the rep their dashboard.
     */
    readCampaignLabels(accountId).catch(() => {
      warnings.push("Campaign labels could not be read, so pacing may flag intermittent buys.");
      return new Map<string, CampaignLabelKind>();
    }),
  ]);

  if (!activeIds) {
    warnings.push("Could not determine which campaigns were active; showing all.");
  }
  const statsIds = activeIds ? [...activeIds] : campaigns.map((campaign) => campaign.id);
  const spentInWindow = activeIds ?? new Set(statsIds);

  // Falls back to the current window's list, which is the old behaviour: an understated baseline
  // beats no baseline, and the dashboard already warns when active entities could not be resolved.
  const previousStatsIds = previousActiveIds ? [...previousActiveIds] : statsIds;

  /**
   * Takeover buys: entities that spent but that `GET /campaigns` will not describe even with
   * `with_deleted`. That absence is the same thing Ads Manager keys off when it hides them, so
   * this classification needs no heuristic about dates or volume.
   *
   * They are excluded by default because blending a flat day rate into auction rates makes both
   * unreadable. On a real account they ran as 24-hour slots handing off to one another at ~23M
   * impressions a day, with component CPMs from $0.00 to $37.99 against $3.62–$8.47 for the same
   * advertiser's auction campaigns; including them moved the account CPM from $6.50 to $9.15.
   */
  const describedIds = new Set(campaigns.map((campaign) => campaign.id));
  const takeoverIds = statsIds.filter((id) => !describedIds.has(id));
  const chartedIds = includeTakeovers
    ? statsIds
    : statsIds.filter((id) => describedIds.has(id));
  // The baseline has to apply the same takeover rule, or the comparison changes what it measures.
  const previousChartedIds = includeTakeovers
    ? previousStatsIds
    : previousStatsIds.filter((id) => describedIds.has(id));

  /**
   * Objectives live on line items and decide which metric groups are worth requesting.
   * Scoping the lookup to the campaigns being charted matters: large accounts hold thousands
   * of line items, and paging all of them added ~20s to the response.
   */
  /**
   * Pacing has to include campaigns that are live but spent nothing in the window — a campaign
   * that has gone dark mid-flight is the single most useful thing to flag — so the line item
   * lookup covers active campaigns as well as those that spent.
   */
  const lineItemIds = [
    ...new Set([
      ...statsIds,
      // Prior-window spenders too, so their objectives decide the metric groups the baseline needs.
      ...previousStatsIds,
      ...campaigns
        .filter((campaign) => !campaign.deleted && campaign.entity_status === "ACTIVE")
        .map((campaign) => campaign.id),
    ]),
  ];

  const objectiveByCampaign = new Map<string, string | null>();
  const lineItemSets: LineItem[][] = [];
  let failedLineItemChunks = 0;
  await Promise.all(
    chunkEntityIds(lineItemIds).map(async (chunk) => {
      const items = await adsRequestAll<LineItem>({
        path: `/accounts/${accountId}/line_items`,
        credentials,
        asUser,
        audit,
        query: { campaign_ids: chunk.join(","), with_deleted: true },
      }).catch(() => {
        failedLineItemChunks += 1;
        return [] as LineItem[];
      });

      lineItemSets.push(items);
      for (const item of items) {
        if (item.campaign_id && item.objective && !objectiveByCampaign.has(item.campaign_id)) {
          objectiveByCampaign.set(item.campaign_id, item.objective);
        }
      }
    }),
  );

  /**
   * Budgets, flight dates and objectives all come from the line items above; every campaign-level
   * budget field the API returns is null. So a dropped chunk does not just lose rows — it strips the
   * flight from up to 20 campaigns, which drops them out of the pacing rollup and understates
   * "Committed", "Projected to spend" and "Budget at risk" with nothing on screen to say so. That
   * last one is the dangerous direction: the shortfall disappears and the panel turns reassuring.
   */
  if (failedLineItemChunks > 0) {
    warnings.push(
      `Budget details for some campaigns could not be loaded, so the pacing totals below are ` +
        `understated and campaigns may be missing from them. Refresh to try again.`,
    );
  }

  const flights = flightsFromLineItems(lineItemSets.flat());

  const metricGroups = metricGroupsFor(
    [...new Set([...statsIds, ...previousStatsIds])].map(
      (id) => objectiveByCampaign.get(id) ?? null,
    ),
  );

  const [current, previous] = await Promise.all([
    fetchDailyStats({
      credentials,
      accountId,
      asUser,
      entity: "CAMPAIGN",
      entityIds: statsIds,
      range,
      metricGroups,
      actor,
    }),
    skipComparisons
      ? Promise.resolve({
          series: {} as Record<string, MetricSeries>,
          failedRequests: 0,
          totalRequests: 0,
          rateLimited: false,
        })
      : fetchDailyStats({
          credentials,
          accountId,
          asUser,
          entity: "CAMPAIGN",
          entityIds: previousStatsIds,
          range: previousRange,
          metricGroups,
          actor,
        }),
  ]);

  /**
   * A dropped stats request leaves those days at zero, which understates spend without
   * erroring. Saying so matters more than showing a tidy number: a rep quoting an
   * understated figure to an advertiser is the worst outcome this tool can produce.
   */
  const failed = current.failedRequests + previous.failedRequests;
  const partial = failed > 0;
  if (partial) {
    const total = current.totalRequests + previous.totalRequests;
    warnings.push(
      current.rateLimited || previous.rateLimited
        ? `The X Ads API is rate limiting this token, so ${failed} of ${total} stats requests were ` +
            `skipped and these totals are understated. Wait a minute and refresh.`
        : `${failed} of ${total} stats requests failed, so these totals are understated. ` +
            `Refresh to try again.`,
    );
  }

  const currentSeries = current.series;

  /**
   * Flight-to-date spend, which is what pacing must be measured against. The dashboard's window
   * is unrelated to the flight, so when it does not reach back to the flight start the days in
   * between are fetched separately. When it does reach back, this costs nothing extra.
   */
  const lastCompleteDay = localDate(1, account.timezone);
  const lookbackFloor = localDate(MAX_FLIGHT_LOOKBACK_DAYS, account.timezone);

  /**
   * Which flights are worth buying spend history for.
   *
   * This backfill is by far the most expensive thing the dashboard does, and synchronous analytics
   * is capped at 250 requests per 15 minutes across the whole category — not per account. Asking
   * for every budgeted flight meant 92 days of daily spend for 73 campaigns on one account, 56
   * requests, of which 55 described flights that had already closed, the oldest in 2020. Two
   * dashboard loads exhausted the window and the third came back rate limited.
   *
   * An open flight is the case pacing exists for. A flight that closed inside the window still
   * earns its history, because its row is on screen and the share of budget it finished on is the
   * only thing that row has to say.
   */
  const measurable = skipComparisons
    ? []
    : [...flights.entries()].filter(([id, flight]) => {
        if (flight.totalBudget == null || !flight.startTime || !flight.endTime) return false;
        if (flight.endTime.slice(0, 10) > lastCompleteDay) return true;
        return spentInWindow.has(id);
      });
  const earliestStart = measurable.reduce<string | null>((earliest, [, flight]) => {
    const start = flight.startTime!.slice(0, 10);
    return !earliest || start < earliest ? start : earliest;
  }, null);

  const flightSpendByCampaign = new Map<string, number[]>();
  let flightDates: string[] = [];

  if (earliestStart) {
    const coverageStart = earliestStart < lookbackFloor ? lookbackFloor : earliestStart;

    if (range.dates[0] && range.dates[0] <= coverageStart) {
      // The selected window already spans every flight, so reuse it.
      flightDates = range.dates;
      for (const [id, series] of Object.entries(currentSeries)) {
        flightSpendByCampaign.set(id, dailySpend(series));
      }
    } else if (dayDiff(coverageStart, lastCompleteDay) >= 0) {
      const flightRange = buildRangeBetween(coverageStart, lastCompleteDay, account.timezone);
      const flightStats = await fetchDailyStats({
        credentials,
        accountId,
        asUser,
        entity: "CAMPAIGN",
        entityIds: measurable.map(([id]) => id),
        range: flightRange,
        // Only spend matters here; the engagement metrics are already on the dashboard.
        metricGroups: "BILLING",
        actor,
      });

      if (flightStats.failedRequests > 0) {
        warnings.push("Budget pacing is unavailable for some campaigns; spend history did not load.");
      } else {
        flightDates = flightRange.dates;
        for (const [id, series] of Object.entries(flightStats.series)) {
          flightSpendByCampaign.set(id, dailySpend(series));
        }
      }
    }
  }

  /** Flight-to-date spend, or null when the fetched history does not cover the whole flight. */
  const flightSpendFor = (id: string, flight: CampaignFlight): number | null => {
    const from = flight.startTime?.slice(0, 10);
    const end = flight.endTime?.slice(0, 10);
    if (!from || !end || flightDates.length === 0) return null;
    // A window starting after the flight did would understate spend and read as underpacing.
    if (from < flightDates[0]!) return null;

    const series = flightSpendByCampaign.get(id);
    if (!series) return 0;

    const until = end < lastCompleteDay ? end : lastCompleteDay;
    return flightDates.reduce(
      (total, date, index) => (date >= from && date <= until ? total + (series[index] ?? 0) : total),
      0,
    );
  };

  /**
   * With stats missing, zero spend is indistinguishable from spend we failed to fetch, and every
   * verdict built on it would be a false alarm — "this campaign stopped delivering" when the API
   * merely rate-limited us is the fastest way to lose a rep's trust. No verdict is offered at all.
   */
  const pacingFor = (id: string, spendSeries: number[], entityStatus: string | null) => {
    const flight = flights.get(id) ?? null;
    const label = labels.get(id) ?? null;
    if (partial) {
      return computePacing({
        flight: null,
        flightSpend: null,
        recentDailySpend: [],
        lastCompleteDay,
        entityStatus,
        label,
      });
    }
    return computePacing({
      flight,
      flightSpend: flight ? flightSpendFor(id, flight) : null,
      recentDailySpend: spendSeries,
      lastCompleteDay,
      entityStatus,
      label,
    });
  };

  // Account totals are summed from the campaigns being shown, so they always reconcile with the
  // table rather than quietly including spend the rep cannot see.
  const seriesFor = (source: Record<string, MetricSeries>, ids: string[]) =>
    ids.map((id) => source[id]).filter((series): series is MetricSeries => Boolean(series));

  const accountSeries = combineSeries(
    seriesFor(currentSeries, chartedIds),
    range.dates.length,
  );
  const previousSeries = combineSeries(
    seriesFor(previous.series, previousChartedIds),
    previousRange.dates.length,
  );
  const takeoverTotals = totalsFrom(
    combineSeries(seriesFor(currentSeries, takeoverIds), range.dates.length),
  );

  const emptySpend = () => new Array<number>(range.dates.length).fill(0);
  const zeroTotals = totalsFrom(combineSeries([], range.dates.length));

  const rows: CampaignRow[] = campaigns
    // Deleted campaigns are only worth a row when they spent inside the window.
    .filter((campaign) => !campaign.deleted || spentInWindow.has(campaign.id))
    .map((campaign) => {
      const series = currentSeries[campaign.id];
      const totals = series ? totalsFrom(series) : zeroTotals;
      const spendSeries = series ? dailySpend(series) : emptySpend();
      const flight = flights.get(campaign.id);
      return {
        id: campaign.id,
        name: campaign.name,
        entityStatus: campaign.entity_status ?? null,
        effectiveStatus: campaign.effective_status ?? null,
        servable: Boolean(campaign.servable),
        objective: objectiveByCampaign.get(campaign.id) ?? null,
        // Campaign budget fields are always null; the real numbers come from the line items.
        dailyBudget: flight?.dailyBudget ?? null,
        totalBudget: flight?.totalBudget ?? null,
        fundingInstrumentId: campaign.funding_instrument_id ?? null,
        startTime: flight?.startTime ?? campaign.start_time ?? null,
        endTime: flight?.endTime ?? campaign.end_time ?? null,
        pacing: pacingFor(campaign.id, spendSeries, campaign.entity_status ?? null),
        totals,
        spendSeries,
        series: series ? chartSeries(series) : undefined,
        // With stats missing, zero impressions means "unknown", not "never delivered", and hiding
        // the row behind "no activity" would state something the data cannot support.
        dormant: !partial && (!series || totals.impressions === 0),
        retired: Boolean(campaign.deleted),
        takeover: false,
      };
    });

  for (const id of includeTakeovers ? takeoverIds : []) {
    const series = currentSeries[id];
    const spend = series ? dailySpend(series) : emptySpend();
    const charted = series ? chartSeries(series) : undefined;
    rows.push({
      id,
      // Dated, because a takeover is a day rather than an ongoing campaign, and the API gives no name.
      name: takeoverName(spend, charted?.impressions ?? emptySpend(), range.dates),
      entityStatus: null,
      effectiveStatus: null,
      servable: false,
      objective: null,
      dailyBudget: null,
      totalBudget: null,
      fundingInstrumentId: null,
      startTime: null,
      endTime: null,
      // A takeover carries no budget or flight, so there is no pace to be behind.
      pacing: pacingFor(id, spend, null),
      totals: series ? totalsFrom(series) : zeroTotals,
      spendSeries: spend,
      series: charted,
      dormant: false,
      retired: false,
      takeover: true,
    });
  }

  // Two components of the same day buy produce the same date label, and identical names in a table
  // the rep cannot click into leave no way to tell the rows apart.
  const nameCounts = new Map<string, number>();
  for (const row of rows) nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
  for (const row of rows) {
    if (row.takeover && (nameCounts.get(row.name) ?? 0) > 1) row.name = `${row.name} · ${row.id}`;
  }

  rows.sort((a, b) => b.totals.spend - a.totals.spend);

  /**
   * Budget at risk is the headline pacing number: money the advertiser committed that is
   * projected to go unspent if the current run rate holds. It is the reason to make a call today
   * rather than at the end of the flight, when nothing can be done about it.
   */
  /**
   * Open flights only. A closed one has nothing projected and nothing at risk, so folding its
   * committed total in would inflate "Committed" with money that is already settled and quietly
   * shrink the share of the account that "Budget at risk" appears to cover.
   */
  const paced = rows.filter(
    (row) => row.pacing.basis === "flight" && row.pacing.status !== "ended",
  );
  const atRisk = paced.filter(
    (row) => row.pacing.status === "underpacing" && (row.pacing.projectedShortfall ?? 0) > 0,
  );
  const dark = rows.filter((row) => row.pacing.status === "dark");
  const idle = rows.filter((row) => row.pacing.status === "idle");
  const pacingSummary = {
    trackedCampaigns: paced.length,
    committedBudget: paced.reduce((total, row) => total + (row.pacing.totalBudget ?? 0), 0),
    projectedSpend: paced.reduce((total, row) => total + (row.pacing.projectedSpend ?? 0), 0),
    budgetAtRisk: atRisk.reduce((total, row) => total + (row.pacing.projectedShortfall ?? 0), 0),
    underpacing: atRisk.length,
    overpacing: paced.filter((row) => row.pacing.status === "overpacing").length,
    dark: dark.length,
    /** Daily budget behind campaigns that were delivering and stopped. */
    darkDailyBudget: dark.reduce((total, row) => total + (row.pacing.dailyBudget ?? 0), 0),
    idle: idle.length,
    idleDailyBudget: idle.reduce((total, row) => total + (row.pacing.dailyBudget ?? 0), 0),
  };

  return {
    account: {
      id: account.id,
      name: account.name,
      businessName: account.business_name ?? null,
      timezone: account.timezone,
      approvalStatus: account.approval_status ?? null,
      asUser,
      currency: accountCurrency(fundingInstruments),
    },
    range: {
      days,
      dates: range.dates,
      provisionalDays: provisionalDayCount(range.dates, account.timezone),
    },
    totals: totalsFrom(accountSeries),
    previousTotals: totalsFrom(previousSeries),
    spendSeries: dailySpend(accountSeries),
    series: accountSeries,
    campaigns: rows,
    pacing: pacingSummary,
    // Reported even when hidden, so the rep can see there is spend here and ask for it.
    takeovers: {
      count: takeoverIds.length,
      spend: takeoverTotals.spend,
      impressions: takeoverTotals.impressions,
      included: includeTakeovers,
    },
    partial,
    fundingInstruments: fundingInstruments.map((instrument) => ({
      id: instrument.id,
      description: instrument.description ?? null,
      currency: instrument.currency ?? null,
      creditLimit:
        instrument.credit_limit_local_micro != null
          ? microsToCurrency(instrument.credit_limit_local_micro)
          : null,
      fundedAmount:
        instrument.funded_amount_local_micro != null
          ? microsToCurrency(instrument.funded_amount_local_micro)
          : null,
      ableToFund: Boolean(instrument.able_to_fund),
    })),
    warnings,
    ...(includeRawSeries ? { rawSeries: currentSeries } : {}),
  };
}
