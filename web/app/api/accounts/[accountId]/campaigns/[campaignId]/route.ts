import { NextResponse } from "next/server";

import { normalizeHandle } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import { buildCampaignDetail, CampaignNotFoundError } from "@/lib/x/campaign-detail";
import { normalizeDays } from "@/lib/x/dashboard";
import { currentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

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
  const asUserParam = url.searchParams.get("asUser");

  try {
    const payload = await buildCampaignDetail({
      credentials,
      accountId,
      campaignId,
      asUser: asUserParam ? normalizeHandle(asUserParam) : null,
      days: normalizeDays(url.searchParams.get("days")),
      timezone: url.searchParams.get("timezone") || "UTC",
      actor: session.actor,
    });

    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof CampaignNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof AdsApiError) {
      return NextResponse.json(
        { error: "ads-api-error", detail: error.message },
        { status: error.status === 403 ? 403 : 502 },
      );
    }
    return NextResponse.json(
      { error: "unexpected", detail: (error as Error).message },
      { status: 500 },
    );
  }
}
