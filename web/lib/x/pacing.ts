/**
 * Budget pacing: is a campaign going to spend what the advertiser committed, by the date they
 * committed to spend it?
 *
 * Two things about the Ads API shape this module. First, **budgets and flight dates live on the
 * line item, not the campaign** — every budget field on a campaign object came back null on every
 * account tested, so a campaign's budget is the sum of its line items'. Second, pacing has to be
 * measured against **flight-to-date spend**, never the dashboard's selected window. A 7-day window
 * against a 54-day flight's total budget reads as catastrophic underpacing on a campaign that is
 * perfectly on track.
 */
import { dayDiff, microsToCurrency } from "./time";

/** The line item fields pacing needs, as returned by `/line_items`. */
export type LineItemBudget = {
  campaign_id?: string;
  entity_status?: string | null;
  deleted?: boolean;
  daily_budget_amount_local_micro?: number | null;
  total_budget_amount_local_micro?: number | null;
  start_time?: string | null;
  end_time?: string | null;
};

export type CampaignFlight = {
  /** Sum of daily budgets across line items that are still delivering. */
  dailyBudget: number | null;
  /** Sum of total budgets, the number the advertiser actually committed. */
  totalBudget: number | null;
  startTime: string | null;
  endTime: string | null;
  lineItems: number;
};

export type PacingStatus =
  | "on-pace"
  | "underpacing"
  /** Spending fast enough to exhaust a committed total budget before the flight ends. */
  | "overpacing"
  /** Was delivering, then stopped. Live and funded but spending nothing now. */
  | "dark"
  /** Live and funded but never delivered in this window — abandoned setup, not a new problem. */
  | "idle"
  | "ended"
  | "scheduled"
  | "paused"
  | "no-budget"
  | "unknown";

/**
 * What to do about an underpacing campaign, and whether the daily budget is even the lever.
 *
 * The arithmetic is trivial — remaining budget over remaining days — and that is the trap. A
 * campaign can be behind for two unrelated reasons, and the same number means opposite things in
 * each. If the cap is what is holding delivery back, raising it to the required rate recovers the
 * budget. If the campaign is not spending the cap it already has, raising it changes nothing, and
 * quoting a required rate *below* the current cap would read as advice to cut the budget of a
 * campaign that is already behind.
 */
export type BudgetAdvice = {
  /** Daily spend needed from the first incomplete day through the flight end to deliver in full. */
  requiredDaily: number;
  /** The cap in force now, when the line items set one. */
  currentDaily: number | null;
  /** `requiredDaily / currentDaily`, so the UI can say how big a change it is asking for. */
  lift: number | null;
  /**
   * - `raise-budget`: the cap is binding and the required rate is a plausible lift from it.
   * - `fix-delivery`: the cap already permits the required rate; the campaign is not using it, so
   *   the constraint is bid or targeting and more budget is wasted effort.
   * - `unrecoverable`: the cap is binding but the required rate is too far above it to credit as a
   *   budget change alone; the flight or the commitment is what needs revisiting.
   */
  lever: "raise-budget" | "fix-delivery" | "unrecoverable";
};

export type CampaignPacing = {
  dailyBudget: number | null;
  totalBudget: number | null;
  flightStart: string | null;
  flightEnd: string | null;
  /** Spend from flight start through the last complete day. Null when not fully covered. */
  flightSpend: number | null;
  /** Fraction of the flight elapsed, counted in complete days. */
  elapsed: number | null;
  /** Fraction of the total budget spent. */
  consumed: number | null;
  /** `consumed / elapsed`. 1.0 is exactly on pace. */
  paceRatio: number | null;
  /** Total budget spend at the current run rate, if the rate holds to the flight end. */
  projectedSpend: number | null;
  /** Budget projected to go unspent. Negative means projected to exhaust early. */
  projectedShortfall: number | null;
  daysRemaining: number | null;
  /** Recent average daily spend against the daily budget, for campaigns without a flight. */
  deliveryRate: number | null;
  status: PacingStatus;
  /**
   * `flight` compares budget consumed against flight elapsed. `delivery` only compares the
   * recent run rate against the daily budget, used when the flight cannot be measured.
   */
  basis: "flight" | "delivery" | "none";
  /** Only set for campaigns behind pace against a measurable flight. */
  advice: BudgetAdvice | null;
};

/** Outside this band a campaign is called off pace. */
const PACE_TOLERANCE = 0.15;

/**
 * Spending at least this share of the daily cap means the cap is the thing holding delivery back,
 * so raising it is a real lever. Below it there is headroom the campaign is already failing to use.
 */
const CAP_BINDING_RATE = 0.9;

/**
 * Past this multiple of the current cap, a raise stops being a credible fix on its own. A campaign
 * that needs to spend five times its current rate for the days it has left is not short of budget;
 * the commitment or the end date is wrong.
 */
const MAX_PLAUSIBLE_LIFT = 3;

/**
 * Days of spend used for the delivery rate. The daily budget is whatever is deliverable *now*,
 * so averaging across a long window compares today's budget against spend from line items that
 * may since have paused — which produced rates above 2x on real accounts.
 */
const DELIVERY_RATE_DAYS = 7;

/**
 * Rolls line items up to a budget and flight per campaign.
 *
 * Deleted line items are excluded from the committed total, since their budget is not money the
 * advertiser still expects to spend. Daily budget counts only line items that are actually
 * delivering, because that is the rate the campaign can currently achieve.
 */
export function flightsFromLineItems(items: LineItemBudget[]): Map<string, CampaignFlight> {
  const flights = new Map<string, CampaignFlight>();

  for (const item of items) {
    const campaignId = item.campaign_id;
    if (!campaignId || item.deleted) continue;

    const flight =
      flights.get(campaignId) ??
      ({
        dailyBudget: null,
        totalBudget: null,
        startTime: null,
        endTime: null,
        lineItems: 0,
      } satisfies CampaignFlight);

    flight.lineItems += 1;

    if (item.total_budget_amount_local_micro != null) {
      flight.totalBudget =
        (flight.totalBudget ?? 0) + microsToCurrency(item.total_budget_amount_local_micro);
    }
    if (item.daily_budget_amount_local_micro != null && item.entity_status === "ACTIVE") {
      flight.dailyBudget =
        (flight.dailyBudget ?? 0) + microsToCurrency(item.daily_budget_amount_local_micro);
    }
    // The campaign's flight is the envelope of its line items' flights.
    if (item.start_time && (!flight.startTime || item.start_time < flight.startTime)) {
      flight.startTime = item.start_time;
    }
    if (item.end_time && (!flight.endTime || item.end_time > flight.endTime)) {
      flight.endTime = item.end_time;
    }

    flights.set(campaignId, flight);
  }

  return flights;
}

function flightStatus(paceRatio: number, ended: boolean): PacingStatus {
  if (ended) return "ended";
  if (paceRatio < 1 - PACE_TOLERANCE) return "underpacing";
  // Only meaningful against a committed total: the budget will run out before the flight ends.
  if (paceRatio > 1 + PACE_TOLERANCE) return "overpacing";
  return "on-pace";
}

/**
 * Delivery rate has no upper bound worth flagging. Daily budgets are allowed to overdeliver and
 * routinely do, so calling a campaign "overpacing" because it spent 1.2x its daily budget is a
 * false alarm — five of them on one real account. Only underdelivery is actionable here.
 */
function deliveryStatus(rate: number): PacingStatus {
  return rate < 1 - PACE_TOLERANCE ? "underpacing" : "on-pace";
}

/**
 * The daily rate that clears the remaining budget in the days the flight has left.
 *
 * `flightSpend` covers whole days only, and `daysRemaining` counts the days not yet covered by it,
 * so the division lines up exactly: money left over days left, with no day counted twice or missed.
 */
function adviseBudget(options: {
  totalBudget: number;
  flightSpend: number;
  daysRemaining: number;
  dailyBudget: number | null;
  deliveryRate: number | null;
}): BudgetAdvice | null {
  const { totalBudget, flightSpend, daysRemaining, dailyBudget, deliveryRate } = options;

  const remaining = totalBudget - flightSpend;
  // Nothing left to recover, or no days left to recover it in.
  if (remaining <= 0 || daysRemaining < 1) return null;

  const requiredDaily = remaining / daysRemaining;
  const lift = dailyBudget && dailyBudget > 0 ? requiredDaily / dailyBudget : null;

  /**
   * With no cap set there is nothing to raise, so the required rate is reported as a target to hit
   * rather than as a change to make. Treated as binding because the absence of a cap cannot be the
   * reason the campaign is behind.
   */
  if (lift == null) {
    return { requiredDaily, currentDaily: dailyBudget, lift: null, lever: "raise-budget" };
  }

  const capBinding =
    lift > 1 && (deliveryRate == null || deliveryRate >= CAP_BINDING_RATE);

  return {
    requiredDaily,
    currentDaily: dailyBudget,
    lift,
    lever: !capBinding
      ? "fix-delivery"
      : lift > MAX_PLAUSIBLE_LIFT
        ? "unrecoverable"
        : "raise-budget",
  };
}

const empty = (): CampaignPacing => ({
  dailyBudget: null,
  totalBudget: null,
  flightStart: null,
  flightEnd: null,
  flightSpend: null,
  elapsed: null,
  consumed: null,
  paceRatio: null,
  projectedSpend: null,
  projectedShortfall: null,
  daysRemaining: null,
  deliveryRate: null,
  status: "no-budget",
  basis: "none",
  advice: null,
});

/**
 * Pacing for one campaign.
 *
 * `flightSpend` must cover the whole flight to date or be null — a partial figure would read as
 * underpacing. When it is null the result falls back to the delivery-rate basis, which needs only
 * the recent daily spend the dashboard already has.
 */
export function computePacing(options: {
  flight: CampaignFlight | null;
  flightSpend: number | null;
  /** Daily spend over the dashboard's window, used for the delivery-rate fallback. */
  recentDailySpend: number[];
  /** Last complete day in the account's timezone, YYYY-MM-DD. */
  lastCompleteDay: string;
  /** Campaign `entity_status`; a paused campaign should not get a live delivery verdict. */
  entityStatus: string | null;
}): CampaignPacing {
  const { flight, flightSpend, recentDailySpend, lastCompleteDay, entityStatus } = options;
  if (!flight) return empty();

  const result = {
    ...empty(),
    dailyBudget: flight.dailyBudget,
    totalBudget: flight.totalBudget,
    flightStart: flight.startTime,
    flightEnd: flight.endTime,
    flightSpend,
  };

  if (flight.dailyBudget == null && flight.totalBudget == null) return result;

  const recent = recentDailySpend.slice(-DELIVERY_RATE_DAYS);
  // Average over days that actually delivered; including dark days would understate the rate a
  // campaign achieves when it is running.
  const activeDays = recent.filter((value) => value > 0);
  if (flight.dailyBudget) {
    const averageDaily =
      activeDays.length > 0
        ? activeDays.reduce((total, value) => total + value, 0) / activeDays.length
        : 0;
    result.deliveryRate = averageDaily / flight.dailyBudget;
  }

  const startDate = flight.startTime?.slice(0, 10) ?? null;
  const endDate = flight.endTime?.slice(0, 10) ?? null;

  if (startDate && startDate > lastCompleteDay) {
    return { ...result, status: "scheduled", basis: "none" };
  }

  /**
   * A closed flight is not live, whatever `entity_status` still says.
   *
   * Advertisers rarely switch a campaign off once its end date passes — there is no reason to —
   * so `entity_status` stays `ACTIVE` on flights that finished years ago and X marks them
   * `EXPIRED` in `effective_status` instead. Trusting `entity_status` alone reported 51 campaigns
   * on one account as live and never delivering, with $512,000 a day of budget behind them, the
   * oldest having ended in 2022.
   */
  const flightEnded = endDate != null && endDate <= lastCompleteDay;
  const live = entityStatus === "ACTIVE" && !flightEnded;

  /**
   * Live, funded, and spending nothing. These need their own statuses because the pace ratio is
   * 0.00, which reads as ordinary underpacing when it is actually a campaign delivering nothing —
   * on one account, an active campaign with a $110,000 daily budget.
   *
   * Something that was delivering and stopped is news a rep can act on today. Something that never
   * delivered in the window is abandoned setup, and on a test-heavy account there can be dozens of
   * them, so conflating the two buries the urgent case under the trivial ones.
   */
  if (live && flight.dailyBudget && activeDays.length === 0) {
    const deliveredEarlier = recentDailySpend
      .slice(0, -DELIVERY_RATE_DAYS)
      .some((value) => value > 0);
    return { ...result, status: deliveredEarlier ? "dark" : "idle", basis: "delivery" };
  }

  const canMeasureFlight =
    startDate != null && endDate != null && flight.totalBudget != null && flightSpend != null;

  if (!canMeasureFlight) {
    /**
     * A closed flight has no pace to hold and nothing left to act on, so it must not fall through
     * to the delivery-rate verdict below — that would read a flight which ended in 2022 as behind
     * on its budget today.
     */
    if (flightEnded) return { ...result, status: "ended", basis: "none" };
    // A paused campaign's recent average describes history, not a pace it is failing to hold.
    if (!live) return { ...result, status: "paused", basis: "none" };
    if (result.deliveryRate == null) return { ...result, status: "unknown", basis: "none" };
    return { ...result, status: deliveryStatus(result.deliveryRate), basis: "delivery" };
  }

  const totalDays = dayDiff(startDate!, endDate!) + 1;
  const ended = flightEnded;
  // Only complete days count, matching the days flightSpend was summed over.
  const elapsedDays = Math.min(dayDiff(startDate!, lastCompleteDay) + 1, totalDays);

  if (totalDays <= 0 || elapsedDays <= 0) {
    return { ...result, status: "scheduled", basis: "none" };
  }

  const elapsed = elapsedDays / totalDays;
  const consumed = flightSpend! / flight.totalBudget!;
  const paceRatio = consumed / elapsed;
  const runRate = flightSpend! / elapsedDays;
  const projectedSpend = ended ? flightSpend! : runRate * totalDays;
  const daysRemaining = Math.max(0, dayDiff(lastCompleteDay, endDate!));
  const status = flightStatus(paceRatio, ended);

  return {
    ...result,
    elapsed,
    consumed,
    paceRatio,
    projectedSpend,
    projectedShortfall: flight.totalBudget! - projectedSpend,
    daysRemaining,
    status,
    basis: "flight",
    advice:
      status === "underpacing"
        ? adviseBudget({
            totalBudget: flight.totalBudget!,
            flightSpend: flightSpend!,
            daysRemaining,
            dailyBudget: flight.dailyBudget,
            deliveryRate: result.deliveryRate,
          })
        : null,
  };
}

/**
 * Money at stake per day, which is how pacing problems get ranked against each other.
 *
 * A common unit is the whole point. Ranking by status tier first put a $1,500/day campaign
 * running at 53% above a campaign with a $110,000/day budget delivering nothing, and ranking a
 * flight shortfall in total dollars against a daily budget compares different things. Spreading
 * the shortfall over the days left puts every case in dollars per day.
 */
export function dailyStake(pacing: CampaignPacing): number {
  switch (pacing.status) {
    case "dark":
    case "idle":
      return pacing.dailyBudget ?? 0;
    case "underpacing":
      if (pacing.basis === "flight" && pacing.projectedShortfall != null) {
        // Days left is how long there is to recover it; fewer days means more urgency per day.
        return pacing.projectedShortfall / Math.max(1, pacing.daysRemaining ?? 1);
      }
      if (pacing.dailyBudget != null && pacing.deliveryRate != null) {
        return pacing.dailyBudget * Math.max(0, 1 - pacing.deliveryRate);
      }
      return 0;
    case "overpacing":
      // Not money lost, but the budget will run dry early. Ranked below real shortfalls.
      return 0;
    default:
      return 0;
  }
}
