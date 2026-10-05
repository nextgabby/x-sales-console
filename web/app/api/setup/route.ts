import { NextResponse } from "next/server";

import {
  clearConsumerKeys,
  consumerKeysFromEnv,
  ReadOnlyStoreError,
  saveConsumerKeys,
} from "@/lib/store";
import { isHosted } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Stores the developer app's consumer keys. Local launcher only.
 *
 * The hosted deployment owns one team app and takes its keys from the environment, so there is
 * nothing to accept here and a stored key could only ever shadow the real one. Refused outright
 * rather than ignored, so a request that cannot do what it says returns an error.
 */
export async function POST(request: Request) {
  if (isHosted() || consumerKeysFromEnv()) {
    return NextResponse.json(
      { error: "This deployment supplies its own app keys." },
      { status: 409 },
    );
  }

  let payload: { consumerKey?: string; consumerSecret?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const consumerKey = payload.consumerKey?.trim();
  const consumerSecret = payload.consumerSecret?.trim();
  if (!consumerKey || !consumerSecret) {
    return NextResponse.json(
      { error: "Both the API key and its secret are required." },
      { status: 400 },
    );
  }

  try {
    await saveConsumerKeys(consumerKey, consumerSecret);
  } catch (error) {
    if (error instanceof ReadOnlyStoreError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  if (isHosted() || consumerKeysFromEnv()) {
    return NextResponse.json(
      { error: "This deployment supplies its own app keys." },
      { status: 409 },
    );
  }

  try {
    await clearConsumerKeys();
  } catch (error) {
    if (error instanceof ReadOnlyStoreError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ ok: true });
}
