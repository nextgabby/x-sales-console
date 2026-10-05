import { NextResponse } from "next/server";

import { clearConnection } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Wipes stored credentials. Does not revoke the app on X — that happens in X settings. */
export async function POST() {
  clearConnection();
  return NextResponse.json({ ok: true });
}
