import { NextResponse } from "next/server";

import { readFavorites, toggleFavorite } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ favorites: readFavorites() });
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

  return NextResponse.json({ favorites: toggleFavorite(accountId) });
}
