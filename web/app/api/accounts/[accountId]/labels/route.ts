import { NextResponse } from "next/server";

import { normalizeHandle, setCampaignLabel, type CampaignLabelKind } from "@/lib/store";
import { ReadOnlyStoreError } from "@/lib/store";
import { adsRequest, AdsApiError } from "@/lib/x/ads-client";
import { currentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const KINDS: CampaignLabelKind[] = ["trend-genius", "notification"];

/**
 * Records how a campaign is bought, which is the one thing a rep can write that another rep reads.
 *
 * Team-wide by design — a Trend Genius buy is one for everybody — so this is also the only write
 * that needs its own authorization. Everywhere else the Ads API is the gate: a rep without access
 * to an advertiser simply gets a 403 from X and sees nothing. Nothing here touches the Ads API for
 * its own sake, so without the check below an allowlisted rep could label campaigns on an
 * advertiser they cannot open, in an account their colleagues can. One cheap request applies
 * exactly the gate X would have applied to a data read.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "not-connected" }, { status: 401 });
  }

  const { accountId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    campaignId?: string;
    kind?: string | null;
    asUser?: string | null;
  };

  const campaignId = body.campaignId?.trim();
  if (!campaignId) {
    return NextResponse.json({ error: "A campaign id is required." }, { status: 400 });
  }

  // Null clears the label, so one route both sets and removes.
  const kind = body.kind == null ? null : (body.kind as CampaignLabelKind);
  if (kind != null && !KINDS.includes(kind)) {
    return NextResponse.json(
      { error: `Unknown label. Expected one of ${KINDS.join(", ")}.` },
      { status: 400 },
    );
  }

  const asUser = body.asUser ? normalizeHandle(body.asUser) : null;

  try {
    await adsRequest({
      path: `/accounts/${accountId}/campaigns`,
      credentials: session.credentials,
      asUser,
      audit: { actor: session.actor, accountId },
      query: { campaign_ids: campaignId, count: 1 },
    });
  } catch (error) {
    if (error instanceof AdsApiError) {
      return NextResponse.json(
        {
          error:
            error.status === 403
              ? "You do not have access to this advertiser, so you cannot label its campaigns."
              : `Could not confirm access to this campaign: ${error.message}`,
        },
        { status: error.status === 403 ? 403 : 502 },
      );
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  try {
    const labels = await setCampaignLabel({
      accountId,
      campaignId,
      kind,
      setBy: session.actor.handle ?? null,
    });
    return NextResponse.json({ labels });
  } catch (error) {
    if (error instanceof ReadOnlyStoreError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
