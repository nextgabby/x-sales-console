import { NextResponse } from "next/server";

import { normalizeHandle, readConnection, resolveCredentials } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import {
  AccountNotFoundError,
  buildDashboard,
  normalizeDays,
} from "@/lib/x/dashboard";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const credentials = resolveCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "not-connected" }, { status: 401 });
  }

  const { accountId } = await params;
  const url = new URL(request.url);
  const asUserParam = url.searchParams.get("asUser");

  try {
    const payload = await buildDashboard({
      credentials,
      accountId,
      asUser: asUserParam ? normalizeHandle(asUserParam) : null,
      days: normalizeDays(url.searchParams.get("days")),
      auditHandle: readConnection()?.handle ?? null,
      includeTakeovers: url.searchParams.get("takeovers") === "1",
    });
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof AccountNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof AdsApiError) {
      if (error.status === 403) {
        return NextResponse.json(
          { error: "no-access", detail: "You cannot read this account." },
          { status: 403 },
        );
      }
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
