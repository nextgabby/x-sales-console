import { NextResponse } from "next/server";

import { maskSecret } from "@/lib/crypto";
import { readConnection } from "@/lib/store";
import { callbackUrl } from "@/lib/x/auth";

export const dynamic = "force-dynamic";

/** Connection status for the UI. Deliberately returns no secret material. */
export async function GET() {
  const connection = readConnection();

  return NextResponse.json({
    hasConsumerKeys: Boolean(connection?.consumerKey && connection?.consumerSecret),
    isConnected: Boolean(connection?.accessToken && connection?.accessTokenSecret),
    consumerKeyPreview: connection?.consumerKey ? maskSecret(connection.consumerKey) : null,
    handle: connection?.handle ?? null,
    displayName: connection?.displayName ?? null,
    avatarUrl: connection?.avatarUrl ?? null,
    connectedAt: connection?.connectedAt ?? null,
    callbackUrl: callbackUrl(),
  });
}
