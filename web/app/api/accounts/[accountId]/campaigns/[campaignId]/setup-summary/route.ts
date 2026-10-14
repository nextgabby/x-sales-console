import { NextResponse } from "next/server";

import { normalizeHandle, resolveAiKey } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import { buildCampaignDetail, CampaignNotFoundError } from "@/lib/x/campaign-detail";
import { normalizeDays } from "@/lib/x/dashboard";
import { buildSetupMessages } from "@/lib/x/setup-context";
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
    objectiveSiblings?: number;
  };

  try {
    /**
     * Refetched server-side rather than trusting the checklist the drawer already holds, matching
     * the targeting and creative routes: a verdict Grok explains has to be one the Ads API supports,
     * not one a client could have edited on the way back.
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
      objectiveSiblings:
        Number.isInteger(body.objectiveSiblings) && body.objectiveSiblings! >= 0
          ? body.objectiveSiblings
          : null,
    });

    const stream = await streamChat({
      apiKey: ai.apiKey,
      model: ai.model,
      messages: buildSetupMessages({
        detail,
        setup: detail.setup,
        question: body.question?.trim() || undefined,
      }),
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
        { error: `Could not load the campaign's settings: ${error.message}` },
        { status: error.status === 403 ? 403 : 502 },
      );
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
