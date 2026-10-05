import { NextResponse } from "next/server";

import { normalizeHandle } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import { buildAccountSummary, type AccountRef } from "@/lib/x/accounts";
import { currentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Enrichment for a single account, so the picker can render immediately and fill in stats
 * progressively. The client passes back the descriptive fields it already has to avoid
 * re-fetching the account object.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "not-connected" }, { status: 401 });
  }
  const credentials = session.credentials;

  const { accountId } = await params;
  const url = new URL(request.url);
  const asUserParam = url.searchParams.get("asUser");
  const timezone = url.searchParams.get("timezone");

  if (!timezone) {
    return NextResponse.json(
      { error: "timezone is required to align the reporting window." },
      { status: 400 },
    );
  }

  const ref: AccountRef = {
    id: accountId,
    name: url.searchParams.get("name") ?? accountId,
    businessName: null,
    timezone,
    approvalStatus: url.searchParams.get("approvalStatus"),
    createdAt: null,
    updatedAt: null,
    access: asUserParam ? "spy" : "direct",
    asUser: asUserParam ? normalizeHandle(asUserParam) : null,
  };

  try {
    const summary = await buildAccountSummary(credentials, ref, session.actor);
    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof AdsApiError) {
      return NextResponse.json(
        { error: "ads-api-error", detail: error.message, status: error.status },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: "unexpected", detail: (error as Error).message },
      { status: 500 },
    );
  }
}
