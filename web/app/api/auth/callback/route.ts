import { NextResponse } from "next/server";

import { resolveConsumerCredentials, saveUserTokens, takePendingRequestToken } from "@/lib/store";
import { exchangeVerifier, fetchProfile } from "@/lib/x/auth";
import { appUrl } from "@/lib/x/origin";

export const dynamic = "force-dynamic";

function fail(message: string) {
  return NextResponse.redirect(appUrl(`/setup?error=${encodeURIComponent(message)}`));
}

/** Leg three: exchange the verifier for the rep's own access token. */
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

  const consumer = resolveConsumerCredentials();
  if (!consumer) return fail("Consumer keys are missing. Re-enter them and retry.");

  // Also guards against a replayed callback, since the pending token is consumed here.
  const pending = takePendingRequestToken(requestToken);
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

    saveUserTokens({
      accessToken: result.accessToken,
      accessTokenSecret: result.accessTokenSecret,
      handle: result.handle || profile.handle || "",
      userId: result.userId,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
    });

    return NextResponse.redirect(appUrl("/accounts"));
  } catch (error) {
    return fail((error as Error).message || "Could not complete authorization.");
  }
}
