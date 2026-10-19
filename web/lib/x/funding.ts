/**
 * Pacing for an insertion order, which is the commitment a CAM is actually held to.
 *
 * Campaign pacing already exists and is not this. A campaign's budget is one line of a buy; the
 * IO is the money the advertiser agreed to spend, and an account routinely splits it across
 * campaigns that each pace fine while the IO as a whole falls short. Novig is the case that
 * prompted it: one IO at 57.5% consumed with 72% of its flight gone, and three more holding
 * $928,000 that have never spent a dollar.
 *
 * Deliberately separate from `pacing.ts` rather than folded into it. An IO has no line items, no
 * daily budget and no delivery of its own, so the lever that module exists to reason about — "is
 * the daily cap what is holding this back" — has no meaning here. Sharing the type would mean
 * carrying fields that are always null and a status set where half the values cannot occur.
 */

/** What a rep should do about this instrument, in the order the panel sorts by. */
export type FundingStatus =
  /** Spending behind its flight, and the shortfall is real money. */
  | "underpacing"
  /** On track to consume the commitment by the end date. */
  | "on-pace"
  /** Will exhaust the commitment early, so delivery stops before the flight does. */
  | "overpacing"
  /** Has budget and an open flight but cannot spend — paused, or no payment method. */
  | "blocked"
  /** Flight has not started. */
  | "scheduled"
  /** Flight is over. Whatever went unspent is now final. */
  | "ended"
  /** No funded amount to measure against: a credit card, or an empty shell. */
  | "unfunded";

export type FundingPacing = {
  status: FundingStatus;
  /** Flight-to-date spend against the instrument, not the dashboard's window. */
  spendToDate: number;
  fundedAmount: number;
  /** Fraction of the commitment spent, and of the flight elapsed. The gap between them is the story. */
  shareSpent: number;
  shareElapsed: number;
  /** Straight-line projection of the end state at the current rate. */
  projectedSpend: number;
  /** Commitment projected to go unspent. Zero when it is on or over pace. */
  atRisk: number;
  daysElapsed: number;
  daysRemaining: number;
  /**
   * Why it cannot spend, taken from `reasons_not_able_to_fund` rather than inferred. Only set on
   * `blocked`, because a paused IO and an unfunded one need different conversations.
   */
  blockedReason: string | null;
};

export type FundingInput = {
  id: string;
  fundedAmount: number | null;
  startTime: string | null;
  endTime: string | null;
  entityStatus: string | null;
  ableToFund: boolean;
  reasonsNotAbleToFund: string[];
  /** Flight-to-date spend. Null when it was not fetched, which is not the same as zero. */
  spendToDate: number | null;
};

/**
 * Tolerance before a gap between spend and flight is called a problem.
 *
 * Billing settles over several days and an IO's flight is measured in weeks, so a few points of
 * difference is noise rather than a shortfall. 10% was picked to match the campaign pacing bands,
 * so the two panels do not call the same delivery by different names.
 */
const PACE_TOLERANCE = 0.1;

/**
 * Whether this instrument is worth putting in front of a rep by default.
 *
 * Status is the wrong test, which is the whole reason this function exists. On Novig the instrument
 * described as "(no payment method has been set up yet)" is ACTIVE and able to fund with nothing in
 * it, while the three IOs holding $928,000 are PAUSED. Filtering on ACTIVE would keep the empty one
 * and hide the money. Funded, and inside its flight, keeps the rows that represent a commitment
 * somebody is accountable for.
 */
export function isLiveCommitment(
  input: Pick<FundingInput, "fundedAmount" | "startTime" | "endTime">,
  now = new Date(),
): boolean {
  if (!input.fundedAmount || input.fundedAmount <= 0) return false;
  const today = now.toISOString().slice(0, 10);
  if (input.startTime && input.startTime.slice(0, 10) > today) return false;
  if (input.endTime && input.endTime.slice(0, 10) < today) return false;
  return true;
}

export function computeFundingPacing(input: FundingInput, now = new Date()): FundingPacing | null {
  const funded = input.fundedAmount ?? 0;
  const spend = input.spendToDate ?? 0;
  const today = now.toISOString().slice(0, 10);
  const start = input.startTime?.slice(0, 10) ?? null;
  const end = input.endTime?.slice(0, 10) ?? null;

  const daysElapsed = start ? Math.max(dayDiff(start, today), 0) : 0;
  const daysRemaining = end ? Math.max(dayDiff(today, end), 0) : 0;
  const flightDays = start && end ? Math.max(dayDiff(start, end), 1) : null;
  const shareElapsed = flightDays ? Math.min(daysElapsed / flightDays, 1) : 0;
  const shareSpent = funded > 0 ? spend / funded : 0;

  const base = {
    spendToDate: spend,
    fundedAmount: funded,
    shareSpent,
    shareElapsed,
    daysElapsed,
    daysRemaining,
    blockedReason: null as string | null,
  };

  if (funded <= 0) {
    return { ...base, status: "unfunded", projectedSpend: spend, atRisk: 0 };
  }
  if (start && start > today) {
    return { ...base, status: "scheduled", projectedSpend: 0, atRisk: 0 };
  }
  if (end && end < today) {
    // The flight is over, so the projection is simply what happened and the gap is final.
    return {
      ...base,
      status: "ended",
      projectedSpend: spend,
      atRisk: Math.max(funded - spend, 0),
    };
  }

  /**
   * Blocked outranks the pace verdict. A paused IO with an open flight is behind pace *because* it
   * is paused, and leading with "underpacing" would send a rep to raise budgets on campaigns that
   * cannot spend whatever their caps say.
   */
  if (!input.ableToFund) {
    return {
      ...base,
      status: "blocked",
      projectedSpend: spend,
      atRisk: Math.max(funded - spend, 0),
      blockedReason: describeBlock(input.reasonsNotAbleToFund, input.entityStatus),
    };
  }

  // Straight-line from the rate achieved so far. No flight dates means no projection to make.
  const projectedSpend =
    daysElapsed > 0 && flightDays ? Math.min((spend / daysElapsed) * flightDays, funded) : spend;
  const atRisk = Math.max(funded - projectedSpend, 0);

  let status: FundingStatus = "on-pace";
  if (flightDays) {
    if (shareSpent < shareElapsed - PACE_TOLERANCE) status = "underpacing";
    else if (shareSpent > shareElapsed + PACE_TOLERANCE) status = "overpacing";
  }

  return { ...base, status, projectedSpend, atRisk: status === "underpacing" ? atRisk : 0 };
}

/** `["PAUSED"]` becomes "paused"; an empty list means X refused without saying why. */
function describeBlock(reasons: string[], entityStatus: string | null): string {
  const named = reasons.filter(Boolean).map((reason) => reason.toLowerCase().replace(/_/g, " "));
  if (named.length > 0) return named.join(", ");
  return entityStatus ? entityStatus.toLowerCase() : "cannot fund";
}

/** Whole days between two `YYYY-MM-DD` dates. */
function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
