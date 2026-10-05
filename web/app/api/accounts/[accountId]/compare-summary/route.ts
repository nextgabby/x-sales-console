import { NextResponse } from "next/server";

import { normalizeHandle, resolveAiKey } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import { AccountNotFoundError, buildDashboard, normalizeDays } from "@/lib/x/dashboard";
import { GrokError, streamChat } from "@/lib/grok";
import { buildComparePrompt } from "@/lib/x/summary-context";
import { MAX_COMPARE } from "@/app/accounts/[accountId]/metrics";
import { currentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
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

  const { accountId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    asUser?: string | null;
    days?: number;
    ids?: string[];
    question?: string;
    takeovers?: boolean;
  };

  const ids = (body.ids ?? []).filter(Boolean).slice(0, MAX_COMPARE);
  if (ids.length < 2) {
    return NextResponse.json(
      { error: "Pick at least two campaigns to summarize." },
      { status: 400 },
    );
  }

  try {
    /**
     * Rebuilt server-side rather than accepting figures from the browser, so the narrative is
     * always grounded in what the Ads API actually returned. This is the same cached-free code
     * path the dashboard uses.
     */
    const dashboard = await buildDashboard({
      credentials,
      accountId,
      asUser: body.asUser ? normalizeHandle(body.asUser) : null,
      days: normalizeDays(body.days),
      actor: session.actor,
      // Mirrors the view: a takeover can only be summarised if the rep asked to see it.
      includeTakeovers: Boolean(body.takeovers),
    });

    /**
     * Refuse rather than narrate understated numbers. A confident summary built on a partial
     * fetch is worse than no summary, because the rep would quote it to an advertiser.
     */
    if (dashboard.partial) {
      return NextResponse.json(
        {
          error:
            "Some campaign data did not load, so the figures are incomplete. Refresh the page and try again.",
        },
        { status: 503 },
      );
    }

    const selected = ids
      .map((id) => dashboard.campaigns.find((campaign) => campaign.id === id))
      .filter((campaign): campaign is NonNullable<typeof campaign> => Boolean(campaign));

    if (selected.length < 2) {
      return NextResponse.json(
        { error: "Those campaigns are no longer in this account." },
        { status: 404 },
      );
    }

    const messages = buildComparePrompt({
      dashboard,
      selected,
      question: body.question?.trim() || null,
    });

    const stream = await streamChat({
      apiKey: ai.apiKey,
      model: ai.model,
      messages,
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
    if (error instanceof AccountNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof AdsApiError) {
      return NextResponse.json(
        { error: `Could not load campaign data: ${error.message}` },
        { status: error.status === 403 ? 403 : 502 },
      );
    }
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
