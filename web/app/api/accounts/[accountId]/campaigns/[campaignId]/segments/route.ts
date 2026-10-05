import { NextResponse } from "next/server";

import { normalizeHandle } from "@/lib/store";
import { adsRequest, adsRequestAll, AdsApiError } from "@/lib/x/ads-client";
import type { Campaign } from "@/lib/x/accounts";
import { normalizeDays } from "@/lib/x/dashboard";
import { buildAudience } from "@/lib/x/audience";
import { buildPlatformBreakdown, type SpotlightSplit } from "@/lib/x/segments";
import { fetchDailyStats, totalsFrom, type MetricSeries } from "@/lib/x/stats";
import { buildRange, recentDayRange } from "@/lib/x/time";
import { currentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Where a campaign's money actually went, by platform.
 *
 * Separate from the campaign detail because segmented figures come only from the asynchronous jobs
 * endpoint: the request creates a job, polls it, then downloads a gzipped file, which takes
 * seconds. The drawer should open immediately and fill this in when it arrives.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string; campaignId: string }> },
) {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "not-connected" }, { status: 401 });
  }
  const credentials = session.credentials;

  const { accountId, campaignId } = await params;
  const url = new URL(request.url);
  const asUser = url.searchParams.get("asUser");
  const asUserHandle = asUser ? normalizeHandle(asUser) : null;
  const days = normalizeDays(url.searchParams.get("days"));
  const timezone = url.searchParams.get("timezone") || "UTC";
  const audit = { actor: session.actor, accountId };

  try {
    /**
     * A takeover is defined by `GET /campaigns` refusing to describe an entity that nonetheless
     * spent, so the lookup failing here is the signal rather than an error worth surfacing.
     */
    let campaign: Campaign | null = null;
    try {
      const response = await adsRequest<{ data?: Campaign }>({
        path: `/accounts/${accountId}/campaigns/${campaignId}`,
        credentials,
        asUser: asUserHandle,
        audit,
        query: { with_deleted: true },
      });
      campaign = response.data ?? null;
    } catch (error) {
      if (!(error instanceof AdsApiError) || error.status !== 404) throw error;
    }

    /**
     * The objective decides which metric the breakdown is judged on, and campaigns report it as
     * null — it lives on the line items. Without it a reach campaign running video creative looks
     * like a video campaign, and a wild cost-per-view spread gets presented as a buying mistake.
     */
    const lineItems = campaign
      ? await adsRequestAll<{ objective?: string | null }>({
          path: `/accounts/${accountId}/line_items`,
          credentials,
          asUser: asUserHandle,
          audit,
          query: { campaign_ids: campaignId, with_deleted: true },
        }).catch(() => [])
      : [];
    const objective = lineItems.find((item) => item.objective)?.objective ?? null;

    const range = buildRange(days, timezone);
    const window = recentDayRange(days, timezone);

    // The unsegmented figure the dashboard already showed, so the breakdown can be checked
    // against it rather than presented on faith, plus the Spotlight slice of it.
    const [unsegmented, spotlightStats] = await Promise.all([
      fetchDailyStats({
        credentials,
        accountId,
        asUser: asUserHandle,
        entity: "CAMPAIGN",
        entityIds: [campaignId],
        range,
        metricGroups: "ENGAGEMENT,BILLING",
        actor: session.actor,
      }),
      fetchDailyStats({
        credentials,
        accountId,
        asUser: asUserHandle,
        entity: "CAMPAIGN",
        entityIds: [campaignId],
        range,
        metricGroups: "ENGAGEMENT,BILLING",
        placement: "SPOTLIGHT",
        actor: session.actor,
      }).catch(() => null),
    ]);

    /**
     * `fetchDailyStats` does not throw on a dropped window — it leaves those days at zero. Both of
     * these figures would then be understated, and the consequences are worse than a low number:
     * the segmented job is a single request over the whole span and is therefore right, so the
     * reconciliation note would blame our own missing request on a documented API caveat. And
     * because the Spotlight remainder is computed by subtraction, an understated slice inflates the
     * "everywhere else" CPM it is compared against. Neither is worth showing on partial data.
     */
    const unsegmentedComplete = unsegmented.failedRequests === 0;
    const spotlightComplete = spotlightStats !== null && spotlightStats.failedRequests === 0;

    const series = unsegmented.series[campaignId];
    const totals = unsegmentedComplete && series ? totalsFrom(series) : null;
    const reportedSpend = totals?.spend ?? 0;

    const spotlight = spotlightComplete
      ? spotlightSplitFrom(
          spotlightStats.series[campaignId] ?? null,
          totals?.spend ?? 0,
          totals?.impressions ?? 0,
        )
      : null;

    /**
     * One job per dimension — the API allows no multi-segmentation — so all three run together
     * rather than in sequence. The drawer already showed its synchronous numbers before this
     * request was made, so the cost is latency on a panel, not on opening the campaign.
     */
    const shared = {
      credentials,
      accountId,
      asUser: asUserHandle,
      campaignId,
      startTime: window.startTime,
      endTime: window.endTime,
      days,
      takeover: campaign === null,
      actor: session.actor,
    };
    const reportedImpressions = totals?.impressions ?? null;

    const [breakdown, audience] = await Promise.all([
      buildPlatformBreakdown({ ...shared, objective, reportedSpend, spotlight }),
      buildAudience({ ...shared, reportedImpressions }),
    ]);

    return NextResponse.json({ days, breakdown, audience });
  } catch (error) {
    if (error instanceof AdsApiError) {
      return NextResponse.json(
        { error: `Could not load the platform breakdown: ${error.message}` },
        { status: error.status === 403 ? 403 : 502 },
      );
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/**
 * Spotlight is a slice of the headline figures, not an extra, so the remainder is what is left
 * after subtracting it rather than a second query. A slice larger than the total would mean the
 * subset assumption is wrong, and inventing a negative remainder is worse than showing nothing.
 */
function spotlightSplitFrom(
  series: MetricSeries | null,
  totalSpend: number,
  totalImpressions: number,
): SpotlightSplit | null {
  if (!series) return null;

  const spotlight = totalsFrom(series);
  if (spotlight.spend <= 0 || spotlight.spend > totalSpend) return null;

  const restSpend = totalSpend - spotlight.spend;
  const restImpressions = Math.max(totalImpressions - spotlight.impressions, 0);

  return {
    spend: spotlight.spend,
    impressions: spotlight.impressions,
    cpm: spotlight.cpm,
    spendShare: totalSpend > 0 ? spotlight.spend / totalSpend : 0,
    rest: {
      spend: restSpend,
      impressions: restImpressions,
      cpm: restImpressions > 0 ? (restSpend / restImpressions) * 1000 : 0,
    },
  };
}
