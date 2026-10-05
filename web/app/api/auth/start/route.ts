import { NextResponse } from "next/server";

import { consumerCredentials, savePendingRequestToken } from "@/lib/store";
import { isHosted, purgeStalePendingTokens } from "@/lib/db";
import { authorizeUrl, fetchRequestToken } from "@/lib/x/auth";
import { appUrl } from "@/lib/x/origin";
import { isDemoMode } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";

/** Leg one of the handshake: trade the app credentials for a request token, then redirect. */
export async function GET() {
  if (isDemoMode()) {
    return NextResponse.redirect(appUrl("/accounts"));
  }

  const consumer = await consumerCredentials();
  if (!consumer) {
    return NextResponse.redirect(
      appUrl(
        "/setup?error=" +
          encodeURIComponent(
            "This deployment has no X_CONSUMER_KEY and X_CONSUMER_SECRET configured, so it cannot start a sign-in.",
          ),
      ),
    );
  }

  /**
   * Someone who starts a sign-in and closes the tab leaves a row nobody will ever claim. Cleared
   * here because it is the only moment one is created, which keeps the table bounded without a cron
   * job. Not awaited, and failure is ignored: a sign-in must not break over housekeeping.
   */
  if (isHosted()) {
    void purgeStalePendingTokens().catch(() => {});
  }

  try {
    const { token, tokenSecret } = await fetchRequestToken(consumer);
    await savePendingRequestToken(token, tokenSecret);
    return NextResponse.redirect(authorizeUrl(token));
  } catch (error) {
    return NextResponse.redirect(
      appUrl(`/setup?error=${encodeURIComponent((error as Error).message)}`),
    );
  }
}
