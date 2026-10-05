import { cookies } from "next/headers";

import { DEMO_ACCOUNTS } from "./universe";

/**
 * Favourites for a demo visitor, kept in their own cookie.
 *
 * This is the one piece of demo state that cannot live in a module variable. A demo link is opened
 * by several reviewers at once, and server-side state is shared between all of them — one person
 * starring an account would star it for everybody, which reads as a bug in the product rather than
 * an artifact of the demo. Process memory is also lost whenever the host idles the instance, which
 * Render's starter plan does and serverless platforms do by design.
 *
 * A cookie is per-visitor, survives an instance going away, and needs no storage. It has to be read
 * from a request scope, which is why this is not wired into `lib/store.ts` like the rest of demo
 * mode: that module's reads are synchronous, and `cookies()` is not.
 */
const COOKIE = "demo-favorites";

/** A year. There is nothing sensitive here, and a reviewer coming back to the link keeps their pins. */
const MAX_AGE = 60 * 60 * 24 * 365;

const KNOWN = new Set(DEMO_ACCOUNTS.map((account) => account.id));

export async function readDemoFavorites(): Promise<string[]> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) {
    // A first visit starts with one pinned, so the sort order it drives is visible without hunting.
    return [DEMO_ACCOUNTS[0]!.id];
  }
  // Filtered against the universe, so a stale or hand-edited cookie cannot inject arbitrary ids.
  return raw.split(",").filter((id) => KNOWN.has(id));
}

export async function toggleDemoFavorite(accountId: string): Promise<string[]> {
  const current = new Set(await readDemoFavorites());
  if (current.has(accountId)) {
    current.delete(accountId);
  } else if (KNOWN.has(accountId)) {
    current.add(accountId);
  }

  const next = [...current];
  (await cookies()).set(COOKIE, next.join(","), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  return next;
}
