import { NextResponse } from "next/server";

import { normalizeHandle, resolveAiKey } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import { buildBenchmarkWithLookback } from "@/lib/x/benchmark-build";
import { buildBenchmarkPrompt } from "@/lib/x/benchmark-context";
import { AccountNotFoundError, buildDashboard } from "@/lib/x/dashboard";
import { GrokError, streamChat } from "@/lib/grok";
import { currentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 90;

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
    question?: string;
  };

  try {
    // Recomputed server-side rather than trusting the figures the panel already holds, so the
    // model is grounded in what the Ads API returned rather than in what a browser posted back.
    const dashboard = await buildDashboard({
      credentials,
      accountId,
      asUser: body.asUser ? normalizeHandle(body.asUser) : null,
      days: WINDOW_DAYS,
      actor: session.actor,
      includeRawSeries: true,
      skipComparisons: true,
      // Present only so a takeover is refused by name; cohorts exclude them either way.
      includeTakeovers: true,
    });

    if (dashboard.partial) {
      return NextResponse.json(
        { error: "The X Ads API did not return the full 90 days, so the comparison would be built on incomplete history." },
        { status: 503 },
      );
    }

    const campaign = dashboard.campaigns.find((row) => row.id === campaignId);
    if (!campaign) {
      return NextResponse.json({ error: "This campaign did not deliver in the last 90 days." }, { status: 404 });
    }
    if (campaign.takeover) {
      return NextResponse.json(
        { error: "A flat-rate takeover day buy has no objective cohort to be compared against." },
        { status: 400 },
      );
    }

    const benchmark = await buildBenchmarkWithLookback({
      credentials,
      accountId,
      asUser: body.asUser ? normalizeHandle(body.asUser) : null,
      actor: session.actor,
      dashboard,
      campaign,
      windowDays: WINDOW_DAYS,
    });

    // Nothing to discuss without a comparison, and inviting the model to fill the gap is exactly
    // how it would end up inventing a benchmark.
    if (benchmark.status !== "ok") {
      return NextResponse.json(
        { error: "There is no comparable history for this campaign, so there is nothing to discuss." },
        { status: 400 },
      );
    }

    const stream = await streamChat({
      apiKey: ai.apiKey,
      model: ai.model,
      messages: buildBenchmarkPrompt({
        campaignName: campaign.name,
        benchmark,
        currency: dashboard.account.currency,
        question: body.question?.trim() || null,
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
