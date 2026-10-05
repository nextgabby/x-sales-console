import { NextResponse } from "next/server";

import { normalizeHandle, readConnection, resolveAiKey, resolveCredentials } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import { buildCampaignDetail, CampaignNotFoundError } from "@/lib/x/campaign-detail";
import { normalizeDays } from "@/lib/x/dashboard";
import { buildCreativePrompt } from "@/lib/x/creative-context";
import { GrokError, streamChat } from "@/lib/grok";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string; campaignId: string }> },
) {
  const credentials = resolveCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "not-connected" }, { status: 401 });
  }

  const ai = resolveAiKey();
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
     * Refetched server-side rather than accepting the creative figures the drawer already holds,
     * so the answer is grounded in what the Ads API returned. Previews are skipped: they are
     * iframes for the browser to mount and cost a round trip per batch.
     */
    const detail = await buildCampaignDetail({
      credentials,
      accountId,
      campaignId,
      asUser: body.asUser ? normalizeHandle(body.asUser) : null,
      days: normalizeDays(body.days),
      timezone: body.timezone || "UTC",
      auditHandle: readConnection()?.handle ?? null,
      includePreviews: false,
    });

    if (detail.promotedPosts.every((post) => post.totals.impressions === 0)) {
      return NextResponse.json(
        { error: "No creative in this campaign delivered in this window, so there is nothing to compare." },
        { status: 400 },
      );
    }

    const stream = await streamChat({
      apiKey: ai.apiKey,
      model: ai.model,
      messages: buildCreativePrompt({ detail, question: body.question?.trim() || null }),
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
        { error: `Could not load creative data: ${error.message}` },
        { status: error.status === 403 ? 403 : 502 },
      );
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
