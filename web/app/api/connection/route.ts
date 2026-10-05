import { NextResponse } from "next/server";

import { consumerCredentials, consumerKeyPreview, consumerKeysFromEnv } from "@/lib/store";
import { currentSession } from "@/lib/auth/session";
import { allowedHandles } from "@/lib/auth/allowlist";
import { isHosted } from "@/lib/db";
import { isDemoMode } from "@/lib/demo/mode";
import { callbackUrl } from "@/lib/x/auth";

export const dynamic = "force-dynamic";

/** Connection status for the UI. Deliberately returns no secret material. */
export async function GET() {
  const session = await currentSession();

  return NextResponse.json({
    isConnected: Boolean(session),
    handle: session?.handle ?? null,
    displayName: session?.displayName ?? null,
    avatarUrl: session?.avatarUrl ?? null,
    /** True once the deployment itself can start a sign-in, whoever is asking. */
    canSignIn: Boolean(await consumerCredentials()),
    /** Hosted mode owns one team app, so the UI hides the key step entirely. */
    hosted: isHosted(),
    keysFromEnv: consumerKeysFromEnv(),
    /**
     * Only the local wizard displays this, to confirm which app's keys are in use. A hosted
     * deployment has no such step, and this endpoint answers unauthenticated requests — so there is
     * nothing to gain from handing a stranger even part of the team app's key.
     */
    consumerKeyPreview: isHosted() ? null : await consumerKeyPreview(),
    demo: isDemoMode(),
    /**
     * Whether an allowlist is in force, but never who is on it — that would let anyone with the URL
     * enumerate the sales team.
     */
    allowlistConfigured: allowedHandles().length > 0,
    /** Shown in local setup so the rep can register the right callback in their own app. */
    callbackUrl: callbackUrl(),
  });
}
