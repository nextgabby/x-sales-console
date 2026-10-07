import { NextResponse } from "next/server";

import { normalizeHandle, resolveAiKey } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import { buildCampaignDetail, CampaignNotFoundError } from "@/lib/x/campaign-detail";
import { normalizeDays } from "@/lib/x/dashboard";
import { buildTargetingPrompt } from "@/lib/x/targeting-context";
import { GrokError, streamChat } from "@/lib/grok";
import { currentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string; campaignId: string }> },
) {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "not-connected" }, { status: 401 });
  }
  const credentials = session.credentials;

  const ai = await resolveAiKey(session.userId);
  if (!ai) {
    return NextResponse.json({ error: "no-ai-key" }, { status: 400 });
  }

  const { accountId, campaignId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    asUser?: string | null;
    days?: number;
    timezone?: string;
    question?: string;
  };

  try {
    /**
     * Refetched server-side rather than taking the targeting the drawer already holds, for the same
     * reason the creative route refetches: an answer must be grounded in what the Ads API returned,
     * not in something a client could edit on the way back.
     */
    const detail = await buildCampaignDetail({
      credentials,
      accountId,
      campaignId,
      asUser: body.asUser ? normalizeHandle(body.asUser) : null,
      days: normalizeDays(body.days),
      timezone: body.timezone || "UTC",
      actor: session.actor,
      includePreviews: false,
    });

    if (detail.targeting.status === "unavailable") {
      return NextResponse.json(
        { error: detail.targeting.reason ?? "The targeting for this campaign could not be loaded." },
        { status: 502 },
      );
    }

    /**
     * Nothing to review is different from a failure, and worth its own sentence: the campaign is
     * running wide open, which is the answer rather than an obstacle to one.
     */
    if (detail.targeting.status === "none") {
      return NextResponse.json(
        {
          error:
            detail.targeting.lineItems === 0
              ? "This campaign has no live line items, so there is no targeting to review."
              : "No line item on this campaign carries any targeting, so there is nothing to review — its delivery is unconstrained.",
        },
        { status: 400 },
      );
    }

    const stream = await streamChat({
      apiKey: ai.apiKey,
      model: ai.model,
      messages: buildTargetingPrompt({ detail, question: body.question?.trim() || null }),
      signal: request.signal,
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Model": ai.model,
      },
    });
  } catch (error) {
    if (error instanceof GrokError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof CampaignNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof AdsApiError) {
      return NextResponse.json(
        { error: `Could not load targeting data: ${error.message}` },
        { status: error.status === 403 ? 403 : 502 },
      );
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
