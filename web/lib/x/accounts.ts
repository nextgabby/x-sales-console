import { adsRequest, adsRequestAll, AdsApiError, chunkEntityIds } from "./ads-client";
import { microsToCurrency, recentDayRange } from "./time";
import type { XCredentials } from "../store";

export type AdsAccount = {
  id: string;
  name: string;
  business_name?: string | null;
  timezone: string;
  approval_status?: string;
  deleted?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type PromotableUser = { user_id: string; promotable_user_type?: string };

export type FundingInstrument = {
  id: string;
  description?: string | null;
  type?: string;
  currency?: string;
  credit_limit_local_micro?: number | null;
  funded_amount_local_micro?: number | null;
  entity_status?: string;
  able_to_fund?: boolean;
};

/**
 * The currency every amount on a page is formatted with.
 *
 * Taking the first instrument the API happened to page back is not safe: an account can hold
 * several, and the wrong symbol on a real figure reads as the wrong amount. A fundable, live
 * instrument is preferred, then the most common currency across them, so the choice is at least
 * deterministic and representative rather than arbitrary.
 */
export function accountCurrency(instruments: FundingInstrument[]): string | null {
  const fundable = instruments.find(
    (instrument) => instrument.able_to_fund && instrument.entity_status === "ACTIVE",
  );
  if (fundable?.currency) return fundable.currency;

  const counts = new Map<string, number>();
  for (const instrument of instruments) {
    if (instrument.currency) {
      counts.set(instrument.currency, (counts.get(instrument.currency) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

export type Campaign = {
  id: string;
  name: string;
  entity_status?: string;
  effective_status?: string;
  deleted?: boolean;
  servable?: boolean;
  objective?: string | null;
  funding_instrument_id?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  daily_budget_amount_local_micro?: number | null;
  total_budget_amount_local_micro?: number | null;
};

/** How the rep reaches an account: directly granted, or through impersonation. */
export type AccessMode = "direct" | "spy";

export type AccountRef = {
  id: string;
  name: string;
  businessName: string | null;
  timezone: string;
  approvalStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  access: AccessMode;
  /** The handle to send as `x-as-user`; null for directly granted accounts. */
  asUser: string | null;
};

export type AccountSummary = {
  id: string;
  name: string;
  businessName: string | null;
  timezone: string;
  approvalStatus: string | null;
  createdAt: string | null;
  access: AccessMode;
  /** The handle sent as `x-as-user` to reach this account, if any. */
  asUser: string | null;
  /** The account's own promotable advertiser handle, resolved for display. */
  advertiserHandle: string | null;
  advertiserUserId: string | null;
  permissions: string[];
  currency: string | null;
  fundingInstruments: Array<{
    id: string;
    description: string | null;
    type: string | null;
    currency: string | null;
    creditLimit: number | null;
    fundedAmount: number | null;
    ableToFund: boolean;
  }>;
  activeCampaigns: number;
  pausedCampaigns: number;
  totalCampaigns: number;
  /** Daily spend for the last 7 complete account-local days, oldest first. */
  spendSparkline: number[];
  spend7d: number;
  /**
   * False when the account can no longer be read. Spy grants lapse, so this distinguishes
   * "expired access" from "partial data" and lets the UI say so plainly.
   */
  accessible: boolean;
  /** Set when enrichment partly failed, so the card can show what is missing. */
  warnings: string[];
};

type AuthenticatedUserAccess = { permissions?: string[] };

type StatsResponse = {
  data?: Array<{
    id: string;
    id_data?: Array<{
      metrics?: Record<string, Array<number | null> | null>;
    }>;
  }>;
};

function toRef(account: AdsAccount, access: AccessMode, asUser: string | null): AccountRef {
  return {
    id: account.id,
    name: account.name,
    businessName: account.business_name ?? null,
    timezone: account.timezone,
    approvalStatus: account.approval_status ?? null,
    createdAt: account.created_at ?? null,
    updatedAt: account.updated_at ?? null,
    access,
    asUser,
  };
}

/**
 * Called with the rep's own token and deliberately without `x-as-user`: this is what makes
 * the result "the accounts this rep already has access to" rather than a list we guessed at.
 */
export async function listDirectAccounts(
  credentials: XCredentials,
  handle: string | null,
): Promise<AccountRef[]> {
  const accounts = await adsRequestAll<AdsAccount>({
    path: "/accounts",
    credentials,
    audit: { handle, accountId: null },
  });
  return accounts
    .filter((account) => !account.deleted)
    .map((account) => toRef(account, "direct", null));
}

/**
 * Every account the impersonated advertiser can see. This is the *advertiser's* list, not the
 * employee's spy grant — many of these will reject sub-resource requests — so results must be
 * passed through verifySpyAccess() before being treated as usable.
 */
export async function listSpyAccounts(
  credentials: XCredentials,
  asUser: string,
  handle: string | null,
): Promise<AccountRef[]> {
  const accounts = await adsRequestAll<AdsAccount>({
    path: "/accounts",
    credentials,
    asUser,
    audit: { handle, accountId: null },
  });
  return accounts
    .filter((account) => !account.deleted)
    .map((account) => toRef(account, "spy", asUser));
}

/**
 * Proves the rep can actually read an account through impersonation.
 *
 * `GET /accounts` succeeds far more broadly than real access, so the check has to hit a
 * sub-resource: an account outside the employee's spy grant returns
 * `403 "Cannot access spy for account"` on `/campaigns` while still appearing in the list.
 */
export async function verifySpyAccess(
  credentials: XCredentials,
  accountId: string,
  asUser: string,
  handle: string | null,
): Promise<{ ok: true; account: AdsAccount } | { ok: false; reason: string }> {
  try {
    await adsRequest({
      path: `/accounts/${accountId}/campaigns`,
      credentials,
      asUser,
      audit: { handle, accountId },
      query: { count: 1 },
    });
  } catch (error) {
    if (error instanceof AdsApiError) {
      if (error.status === 403) {
        return { ok: false, reason: `No spy access to ${accountId} as @${asUser}.` };
      }
      if (error.status === 404) {
        return { ok: false, reason: `Account ${accountId} does not exist.` };
      }
      return { ok: false, reason: `${accountId} failed (${error.status}).` };
    }
    return { ok: false, reason: `${accountId}: ${(error as Error).message}` };
  }

  try {
    const detail = await adsRequest<{ data?: AdsAccount }>({
      path: `/accounts/${accountId}`,
      credentials,
      asUser,
      audit: { handle, accountId },
    });
    if (!detail.data) return { ok: false, reason: `${accountId} returned no account data.` };
    return { ok: true, account: detail.data };
  } catch (error) {
    return {
      ok: false,
      reason: `${accountId}: ${(error as Error).message}`,
    };
  }
}

export function grantToRef(grant: {
  accountId: string;
  asUser: string;
  name: string;
  timezone: string;
  approvalStatus: string | null;
}): AccountRef {
  return {
    id: grant.accountId,
    name: grant.name,
    businessName: null,
    timezone: grant.timezone,
    approvalStatus: grant.approvalStatus,
    createdAt: null,
    updatedAt: null,
    access: "spy",
    asUser: grant.asUser,
  };
}

/** Enrichment failures degrade a card rather than failing the whole page. */
async function attempt<T>(
  label: string,
  warnings: string[],
  operation: () => Promise<T>,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const detail =
      error instanceof AdsApiError ? `${error.status}` : (error as Error)?.message ?? "failed";
    warnings.push(`${label} unavailable (${detail})`);
    return null;
  }
}

const SPARKLINE_DAYS = 7;
/** Five chunks of 20 IDs. Beyond this the picker warns rather than under-reporting silently. */
const MAX_SPARKLINE_CAMPAIGNS = 100;

type ActiveEntity = { entity_id: string };

/**
 * Spend has to be summed from campaigns: the ACCOUNT entity returns an empty metrics object
 * even when campaigns are actively spending. `active_entities` narrows the set first so an
 * account with hundreds of dormant campaigns costs only a call or two.
 */
async function fetchSpendSparkline(
  credentials: XCredentials,
  account: AccountRef,
  handle: string | null,
  warnings: string[],
  describedCampaigns: Promise<Campaign[] | null>,
): Promise<number[]> {
  const empty = new Array(SPARKLINE_DAYS).fill(0) as number[];
  const range = recentDayRange(SPARKLINE_DAYS, account.timezone);

  const active = await attempt("Spend", warnings, () =>
    adsRequest<{ data?: ActiveEntity[] }>({
      path: `/stats/accounts/${account.id}/active_entities`,
      credentials,
      asUser: account.asUser,
      audit: { handle, accountId: account.id },
      query: {
        entity: "CAMPAIGN",
        start_time: range.startTime,
        end_time: range.endTime,
      },
    }),
  );

  let campaignIds = [...new Set((active?.data ?? []).map((entity) => entity.entity_id))];
  if (campaignIds.length === 0) return empty;

  /**
   * Takeovers are dropped here for the same reason the dashboard drops them: they do not appear in
   * Ads Manager. The card and the dashboard have to agree, or the rep sees the figure shrink when
   * they click through. Classification needs the deleted campaigns too — a deleted campaign that
   * spent is still described by the API, and mistaking one for a takeover would drop real spend.
   */
  const described = await describedCampaigns;
  if (described) {
    const describedIds = new Set(described.map((campaign) => campaign.id));
    const withoutTakeovers = campaignIds.filter((id) => describedIds.has(id));
    if (withoutTakeovers.length !== campaignIds.length) {
      warnings.push(
        `Spend excludes ${campaignIds.length - withoutTakeovers.length} takeover buy(s), as in Ads Manager`,
      );
      campaignIds = withoutTakeovers;
    }
    if (campaignIds.length === 0) return empty;
  }

  if (campaignIds.length > MAX_SPARKLINE_CAMPAIGNS) {
    warnings.push(
      `Spend covers the ${MAX_SPARKLINE_CAMPAIGNS} of ${campaignIds.length} active campaigns sampled`,
    );
    campaignIds = campaignIds.slice(0, MAX_SPARKLINE_CAMPAIGNS);
  }

  const totals = [...empty];

  for (const chunk of chunkEntityIds(campaignIds)) {
    const stats = await attempt("Spend", warnings, () =>
      adsRequest<StatsResponse>({
        path: `/stats/accounts/${account.id}`,
        credentials,
        asUser: account.asUser,
        audit: { handle, accountId: account.id },
        query: {
          entity: "CAMPAIGN",
          entity_ids: chunk.join(","),
          start_time: range.startTime,
          end_time: range.endTime,
          granularity: "DAY",
          metric_groups: "BILLING",
          placement: "ALL_ON_TWITTER",
        },
      }),
    );

    for (const entity of stats?.data ?? []) {
      const series = entity.id_data?.[0]?.metrics?.billed_charge_local_micro;
      if (!Array.isArray(series)) continue;
      series.forEach((value, index) => {
        if (index < totals.length) totals[index] += microsToCurrency(value ?? 0);
      });
    }
  }

  return totals;
}

export async function buildAccountSummary(
  credentials: XCredentials,
  account: AccountRef,
  handle: string | null,
): Promise<AccountSummary> {
  const warnings: string[] = [];
  const asUser = account.asUser;

  // Started before the Promise.all so the sparkline can await it without serializing the two.
  // Deleted campaigns are fetched so spend classification is right; the counts below ignore them.
  const campaignsPromise = attempt("Campaigns", warnings, () =>
    adsRequestAll<Campaign>({
      path: `/accounts/${account.id}/campaigns`,
      credentials,
      asUser,
      audit: { handle, accountId: account.id },
      query: { with_deleted: true },
    }),
  );

  const [promotableUsers, access, fundingInstruments, campaigns, spendSparkline] =
    await Promise.all([
      attempt("Advertiser handle", warnings, () =>
        adsRequestAll<PromotableUser>({
          path: `/accounts/${account.id}/promotable_users`,
          credentials,
          asUser,
          audit: { handle, accountId: account.id },
        }),
      ),
      attempt("Permissions", warnings, () =>
        adsRequest<{ data?: AuthenticatedUserAccess }>({
          path: `/accounts/${account.id}/authenticated_user_access`,
          credentials,
          asUser,
          audit: { handle, accountId: account.id },
        }),
      ),
      attempt("Funding", warnings, () =>
        adsRequestAll<FundingInstrument>({
          path: `/accounts/${account.id}/funding_instruments`,
          credentials,
          asUser,
          audit: { handle, accountId: account.id },
        }),
      ),
      campaignsPromise,
      fetchSpendSparkline(credentials, account, handle, warnings, campaignsPromise),
    ]);

  const primaryFunding = fundingInstruments?.[0];
  const advertiserUserId = promotableUsers?.[0]?.user_id ?? null;
  // Campaigns is the canonical access probe: it is the call that 403s on a lapsed spy grant.
  const accessible = campaigns !== null;
  // Deleted campaigns are fetched only to classify spend, so they stay out of the counts.
  const live = (campaigns ?? []).filter((campaign) => !campaign.deleted);

  return {
    accessible,
    id: account.id,
    name: account.name,
    businessName: account.businessName,
    timezone: account.timezone,
    approvalStatus: account.approvalStatus,
    createdAt: account.createdAt,
    access: account.access,
    asUser,
    advertiserHandle: advertiserUserId
      ? await resolveHandle(credentials, advertiserUserId)
      : null,
    advertiserUserId,
    permissions: access?.data?.permissions ?? [],
    currency: primaryFunding?.currency ?? null,
    fundingInstruments: (fundingInstruments ?? []).map((instrument) => ({
      id: instrument.id,
      description: instrument.description ?? null,
      type: instrument.type ?? null,
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
    activeCampaigns: live.filter((c) => c.entity_status === "ACTIVE").length,
    pausedCampaigns: live.filter((c) => c.entity_status === "PAUSED").length,
    totalCampaigns: live.length,
    spendSparkline,
    spend7d: spendSparkline.reduce((sum, value) => sum + value, 0),
    // A lapsed grant fails every sub-request, so the individual warnings are just noise.
    warnings: accessible ? warnings : [],
  };
}

/**
 * promotable_users returns numeric IDs, so a handle needs a v2 users lookup. Cached for the
 * process lifetime because agency accounts under one advertiser repeat the same ID.
 */
const handleCache = new Map<string, string | null>();

async function resolveHandle(
  credentials: XCredentials,
  userId: string,
): Promise<string | null> {
  const cached = handleCache.get(userId);
  if (cached !== undefined) return cached;

  const { buildOAuth1AuthorizationHeader } = await import("./oauth1");
  const url = `https://api.x.com/2/users/${userId}`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: buildOAuth1AuthorizationHeader("GET", url, {
          consumerKey: credentials.consumerKey,
          consumerSecret: credentials.consumerSecret,
          token: credentials.accessToken,
          tokenSecret: credentials.accessTokenSecret,
        }),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      handleCache.set(userId, null);
      return null;
    }
    const payload = (await response.json()) as { data?: { username?: string } };
    const username = payload.data?.username ?? null;
    handleCache.set(userId, username);
    return username;
  } catch {
    // Handles are a display nicety; leaving them null is acceptable.
    handleCache.set(userId, null);
    return null;
  }
}
