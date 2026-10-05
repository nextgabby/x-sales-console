import { NextResponse } from "next/server";

import { deleteUser } from "@/lib/store";
import { endSession, sessionUserId } from "@/lib/auth/session";
import { isDemoMode } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";

/**
 * Signs out and deletes this rep's stored credentials. Does not revoke the app on X — that happens
 * in X account settings, and the UI says so.
 *
 * Only ever touches the caller's own record. Deleting by session rather than by a posted id is what
 * stops one rep disconnecting another on a shared deployment.
 */
export async function POST() {
  if (isDemoMode()) {
    return NextResponse.json({ error: "This is a demo; there is nothing to disconnect." }, { status: 400 });
  }

  const userId = await sessionUserId();
  if (userId) await deleteUser(userId);
  // Cleared even when no user was found, so a stale cookie cannot survive a "disconnect".
  await endSession();

  return NextResponse.json({ ok: true });
}
