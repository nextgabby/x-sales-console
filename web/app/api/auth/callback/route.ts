import { NextResponse } from "next/server";

import { consumerCredentials, saveUser, takePendingRequestToken } from "@/lib/store";
import { checkHandle, denialMessage } from "@/lib/auth/allowlist";
import { startSession } from "@/lib/auth/session";
import { exchangeVerifier, fetchProfile } from "@/lib/x/auth";
import { appUrl } from "@/lib/x/origin";

export const dynamic = "force-dynamic";

function fail(message: string) {
  return NextResponse.redirect(appUrl(`/setup?error=${encodeURIComponent(message)}`));
}

/** Leg three: exchange the verifier for this rep's own access token, then sign them in. */
export async function GET(request: Request) {
  const url = new URL(request.url);

  if (url.searchParams.get("denied")) {
    return fail("Authorization was declined on X. Nothing was saved.");
  }

  const requestToken = url.searchParams.get("oauth_token");
  const verifier = url.searchParams.get("oauth_verifier");
  if (!requestToken || !verifier) {
    return fail("X did not return a verifier. Start the connection again.");
  }

  const consumer = await consumerCredentials();
  if (!consumer) return fail("This deployment has no X app credentials configured.");

  // Also guards against a replayed callback, since the pending token is consumed here.
  const pending = await takePendingRequestToken(requestToken);
  if (!pending) {
    return fail("This authorization link is stale. Start the connection again.");
  }

  try {
    const result = await exchangeVerifier({
      consumer,
      requestToken: pending.token,
      requestTokenSecret: pending.tokenSecret,
      verifier,
    });

    const profile = await fetchProfile({
      consumerKey: consumer.key,
      consumerSecret: consumer.secret,
      accessToken: result.accessToken,
      accessTokenSecret: result.accessTokenSecret,
    });

    const handle = result.handle || profile.handle || "";

    /**
     * Checked before anything is written. Someone who is not on the list leaves no token in the
     * database and no session cookie, so a refused sign-in cannot leave behind credentials that a
     * later change to the list would quietly activate.
     */
    const decision = checkHandle(handle);
    if (!decision.allowed) {
      return fail(denialMessage(decision.reason, handle));
    }

    await saveUser({
      userId: result.userId,
      handle,
      accessToken: result.accessToken,
      accessTokenSecret: result.accessTokenSecret,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
    });

    await startSession(result.userId);

    return NextResponse.redirect(appUrl("/accounts"));
  } catch (error) {
    return fail((error as Error).message || "Could not complete authorization.");
  }
}
