/**
 * Shapes shared between the dashboard route handlers and the client components. Kept in its
 * own module so client code never imports a server route file.
 */
import type { Totals } from "@/lib/x/stats";
import type { CampaignPacing } from "@/lib/x/pacing";
import type { TargetingSummary } from "@/lib/x/targeting";

export type CampaignRow = {
  id: string;
  name: string;
  entityStatus: string | null;
  effectiveStatus: string | null;
  servable: boolean;
  objective: string | null;
  dailyBudget: number | null;
  totalBudget: number | null;
  fundingInstrumentId: string | null;
  startTime: string | null;
  endTime: string | null;
  /** Budget pacing, measured against flight-to-date spend rather than the selected window. */
  pacing: CampaignPacing;
  totals: Totals;
  spendSeries: number[];
  /**
   * Daily series for the chartable metrics, omitted for campaigns with no activity since
   * those are all zeros and would only bloat the payload.
   */
  series?: Record<string, number[]>;
  /** True when the campaign had no recorded activity in the window. */
  dormant: boolean;
  /** Deleted, yet still holding spend in this window. */
  retired: boolean;
  /**
   * A takeover buy: it spent, but the campaigns endpoint does not describe it. Hidden unless
   * asked for, matching Ads Manager, and never comparable to an auction campaign on price.
   */
  takeover: boolean;
};

export type FundingInstrumentRow = {
  id: string;
  description: string | null;
  currency: string | null;
  creditLimit: number | null;
  fundedAmount: number | null;
  ableToFund: boolean;
};

export type PacingSummary = {
  /** Campaigns whose budget consumption could be measured against their flight. */
  trackedCampaigns: number;
  committedBudget: number;
  projectedSpend: number;
  /** Committed budget projected to go unspent, across underpacing campaigns only. */
  budgetAtRisk: number;
  underpacing: number;
  overpacing: number;
  /** Live campaigns that were delivering and have stopped. */
  dark: number;
  darkDailyBudget: number;
  /** Live campaigns that never delivered in this window. */
  idle: number;
  idleDailyBudget: number;
};

export type DashboardPayload = {
  account: {
    id: string;
    name: string;
    businessName: string | null;
    timezone: string;
    approvalStatus: string | null;
    asUser: string | null;
    currency: string | null;
  };
  range: { days: number; dates: string[]; provisionalDays: number };
  totals: Totals;
  previousTotals: Totals;
  spendSeries: number[];
  series: Record<string, number[]>;
  campaigns: CampaignRow[];
  pacing: PacingSummary;
  /**
   * Takeover spend in this window. Reported whether or not it is included, so the rep can see it
   * exists; `totals` and `campaigns` only contain it when `included` is true.
   */
  takeovers: {
    count: number;
    spend: number;
    impressions: number;
    included: boolean;
  };
  /** True when some stats requests failed, so totals understate reality. */
  partial: boolean;
  fundingInstruments: FundingInstrumentRow[];
  warnings: string[];
};

export type LineItemRow = {
  id: string;
  name: string | null;
  /** Deleted but still holding spend in the window, so it is shown rather than dropped. */
  retired: boolean;
  objective: string | null;
  productType: string | null;
  entityStatus: string | null;
  bidAmount: number | null;
  goal: string | null;
  totals: Totals;
  spendSeries: number[];
};

export type PromotedPostRow = {
  id: string;
  tweetId: string | null;
  lineItemId: string | null;
  /** Line item name, so a creative can be read in the context it competed in. */
  lineItemName: string | null;
  text: string | null;
  authorHandle: string | null;
  createdAt: string | null;
  /** Thumbnail from the post's attached media, when it has any. */
  mediaUrl: string | null;
  mediaType: string | null;
  /**
   * X-hosted render of the actual creative, including cards and video that the v2 media
   * expansion does not return for Promoted-only posts. Host-validated server side.
   */
  previewUrl: string | null;
  entityStatus: string | null;
  /** A rejected creative explains zero delivery, so it is worth surfacing. */
  approvalStatus: string | null;
  totals: Totals;
  spendSeries: number[];
};

export type CampaignDetailPayload = {
  campaign: {
    id: string;
    name: string;
    entityStatus: string | null;
    effectiveStatus: string | null;
    objective: string | null;
    dailyBudget: number | null;
    totalBudget: number | null;
    startTime: string | null;
    endTime: string | null;
  };
  currency: string | null;
  range: { days: number; dates: string[] };
  totals: Totals;
  spendSeries: number[];
  lineItems: LineItemRow[];
  promotedPosts: PromotedPostRow[];
  /** What the campaign is set to target, as against `AudienceBreakdown`, which is who it reached. */
  targeting: TargetingSummary;
  warnings: string[];
};
