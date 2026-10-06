import { NextResponse } from "next/server";

import { readSpyGrants } from "@/lib/store";
import { AdsApiError } from "@/lib/x/ads-client";
import { grantToRef, listDirectAccounts, type AccountRef } from "@/lib/x/accounts";
import { isDemoMode } from "@/lib/demo/mode";
import { isHosted } from "@/lib/db";
import { currentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export type AccountGroup = {
  source: "direct" | "spy";
  asUser: string | null;
  accounts: AccountRef[];
  error: string | null;
};

/**
 * Cheap by design: one API call for the rep's own accounts, and zero for spy accounts, which
 * come from grants already verified at add time. Per-account stats load lazily via the summary
 * route so a rep with dozens of accounts still gets an instant page.
 */
export async function GET() {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "not-connected" }, { status: 401 });
  }
  const credentials = session.credentials;

  const groups: AccountGroup[] = [];

  try {
    groups.push({
      source: "direct",
      asUser: null,
      accounts: await listDirectAccounts(credentials, session.actor),
      error: null,
    });
  } catch (error) {
    /**
     * Reported separately from a stale token, because signing in again cannot fix it: the app, not
     * the person, is what X is refusing. Left as "not-connected" it produces an endless loop of
     * successful authorizations followed by the same failure.
     */
    if (error instanceof AdsApiError && error.isAppNotApproved) {
      return NextResponse.json(
        { error: "app-not-approved", detail: error.message },
        { status: 403 },
      );
    }
    if (error instanceof AdsApiError && (error.status === 401 || error.status === 403)) {
      return NextResponse.json({ error: "not-connected" }, { status: 401 });
    }
    groups.push({
      source: "direct",
      asUser: null,
      accounts: [],
      error: (error as Error).message,
    });
  }

  const grants = await readSpyGrants(session.userId);
  const byHandle = new Map<string, AccountRef[]>();
  for (const grant of grants) {
    const existing = byHandle.get(grant.asUser) ?? [];
    existing.push(grantToRef(grant));
    byHandle.set(grant.asUser, existing);
  }

  for (const [asUser, accounts] of [...byHandle.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    groups.push({ source: "spy", asUser, accounts, error: null });
  }

  return NextResponse.json({
    handle: session.handle,
    spyGrants: grants,
    groups,
    /**
     * Lets the client hide the controls that change stored settings. Carried on this response
     * rather than read from a `NEXT_PUBLIC_` variable so there is only one flag to set, and no way
     * for the browser to believe it is in a different mode from the server.
     */
    demo: isDemoMode(),
    /** Shared deployment, so the header offers an explicit way to end the session. */
    hosted: isHosted(),
  });
}
