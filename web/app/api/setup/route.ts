import { NextResponse } from "next/server";

import { saveConsumerKeys } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Stores the rep's own app credentials. The secret is encrypted before it touches disk. */
export async function POST(request: Request) {
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
      { error: "Both the API key and API secret are required." },
      { status: 400 },
    );
  }

  // Catches the common mistake of pasting an access token into the consumer key field.
  if (consumerKey.includes("-")) {
    return NextResponse.json(
      {
        error:
          "That looks like an Access Token rather than an API Key. Use the API Key and API Secret from the 'Consumer Keys' section of your app.",
      },
      { status: 400 },
    );
  }

  try {
    saveConsumerKeys(consumerKey, consumerSecret);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message || "Could not save credentials." },
      { status: 500 },
    );
  }
}
