import { NextResponse } from "next/server";

import { normalizeHandle, readConnection, resolveCredentials } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import { buildBenchmarkWithLookback } from "@/lib/x/benchmark-build";
import { AccountNotFoundError, buildDashboard } from "@/lib/x/dashboard";

export const dynamic = "force-dynamic";

/**
 * The brand's own history for one campaign's objective.
 *
 * Its own endpoint rather than part of the campaign detail because it costs a 90-day account
 * build — about ten seconds on an account with a hundred campaigns — and a rep opening a drawer to
 * glance at creatives should not wait for it. Takeovers are left out: a flat-rate day buy is not a
 * price the advertiser could have won at auction, so it is not a baseline for anything.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string; campaignId: string }> },
) {
  const credentials = resolveCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "not-connected" }, { status: 401 });
  }

  const { accountId, campaignId } = await params;
  const url = new URL(request.url);
  const asUserParam = url.searchParams.get("asUser");
  const windowDays = 90;

  try {
    const dashboard = await buildDashboard({
      credentials,
      accountId,
      asUser: asUserParam ? normalizeHandle(asUserParam) : null,
      days: windowDays,
      auditHandle: readConnection()?.handle ?? null,
      includeRawSeries: true,
      skipComparisons: true,
      // Included only so a takeover can be recognised and refused by name. `buildBenchmark` keeps
      // them out of every cohort regardless, so this cannot pollute a baseline.
      includeTakeovers: true,
    });

    const campaign = dashboard.campaigns.find((row) => row.id === campaignId);
    if (!campaign) {
      return NextResponse.json(
        { error: "This campaign did not deliver in the last 90 days, so there is nothing to compare." },
        { status: 404 },
      );
    }

    if (campaign.takeover) {
      return NextResponse.json(
        {
          error:
            "This is a flat-rate takeover day buy, not an auction campaign. Its price was " +
            "negotiated, so there is no objective cohort it can fairly be compared against.",
        },
        { status: 400 },
      );
    }

    /**
     * A partial fetch understates every campaign unevenly, which would show up as a confident
     * verdict built on missing days. Refusing is the only honest answer.
     */
    if (dashboard.partial) {
      return NextResponse.json(
        {
          error:
            "The X Ads API did not return the full 90 days, so a benchmark would be built on " +
            "incomplete history. Wait a minute and try again.",
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      currency: dashboard.account.currency,
      campaignName: campaign.name,
      benchmark: await buildBenchmarkWithLookback({
        credentials,
        accountId,
        asUser: asUserParam ? normalizeHandle(asUserParam) : null,
        auditHandle: readConnection()?.handle ?? null,
        dashboard,
        campaign,
        windowDays,
      }),
    });
  } catch (error) {
    if (error instanceof AccountNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof AdsApiError) {
      return NextResponse.json(
        { error: `Could not load history: ${error.message}` },
        { status: error.status === 403 ? 403 : 502 },
      );
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
