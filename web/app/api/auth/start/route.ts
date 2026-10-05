import { NextResponse } from "next/server";

import { resolveConsumerCredentials, savePendingRequestToken } from "@/lib/store";
import { authorizeUrl, fetchRequestToken } from "@/lib/x/auth";
import { appUrl } from "@/lib/x/origin";

export const dynamic = "force-dynamic";

/** Leg one of the handshake: trade the app credentials for a request token, then redirect. */
export async function GET() {
  const consumer = resolveConsumerCredentials();
  if (!consumer) {
    return NextResponse.redirect(appUrl("/setup?error=Add+your+API+key+and+secret+first."));
  }

  try {
    const { token, tokenSecret } = await fetchRequestToken(consumer);
    savePendingRequestToken(token, tokenSecret);
    return NextResponse.redirect(authorizeUrl(token));
  } catch (error) {
    return NextResponse.redirect(
      appUrl(`/setup?error=${encodeURIComponent((error as Error).message)}`),
    );
  }
}
