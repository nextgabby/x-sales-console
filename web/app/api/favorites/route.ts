import { NextResponse } from "next/server";

import { readFavorites, toggleFavorite } from "@/lib/store";
import { currentSession } from "@/lib/auth/session";
import { isDemoMode } from "@/lib/demo/mode";
import { readDemoFavorites, toggleDemoFavorite } from "@/lib/demo/favorites";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isDemoMode()) {
    return NextResponse.json({ favorites: await readDemoFavorites() });
  }

  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "not-connected" }, { status: 401 });

  return NextResponse.json({ favorites: await readFavorites(session.userId) });
}

export async function POST(request: Request) {
  let payload: { accountId?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const accountId = payload.accountId?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required." }, { status: 400 });
  }

  /**
   * Demo favourites live in the visitor's own cookie. Server memory would be shared between every
   * reviewer looking at the link at once — one person's star appearing for everyone else — and would
   * be lost whenever the host idled the instance.
   */
  if (isDemoMode()) {
    return NextResponse.json({ favorites: await toggleDemoFavorite(accountId) });
  }

  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "not-connected" }, { status: 401 });

  return NextResponse.json({ favorites: await toggleFavorite(session.userId, accountId) });
}
