import { NextResponse } from "next/server";

import {
  aiKeyStatus,
  clearAiConfig,
  hasEnvAiKey,
  readAiConfig,
  resolveAiKey,
  saveAiConfig,
  saveAiModel,
} from "@/lib/store";
import { currentSession } from "@/lib/auth/session";
import { isHosted } from "@/lib/db";
import { GrokError, listModels, pickModel } from "@/lib/grok";
import { maskSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const notConnected = () => NextResponse.json({ error: "not-connected" }, { status: 401 });

export async function GET(request: Request) {
  const session = await currentSession();
  if (!session) return notConnected();

  // Only ever a mask — the key itself must not reach the browser.
  const status = await aiKeyStatus(session.userId);
  if (!status.configured || !new URL(request.url).searchParams.has("models")) {
    return NextResponse.json(status);
  }

  /**
   * Listed here as well as on save, so the picker works for an environment key and after a reload,
   * neither of which involves pasting anything. A failure here is not worth an error — the stored
   * model still works, the list is just unavailable.
   */
  const resolved = await resolveAiKey(session.userId);
  const models = resolved ? await listModels(resolved.apiKey).catch(() => []) : [];
  return NextResponse.json({ ...status, models });
}

export async function POST(request: Request) {
  const session = await currentSession();
  if (!session) return notConnected();

  const body = (await request.json().catch(() => ({}))) as {
    apiKey?: string;
    model?: string;
  };

  // Changing only the model. Works for an environment key too, unless XAI_MODEL pins it.
  if (!body.apiKey && body.model) {
    if (process.env.XAI_MODEL?.trim()) {
      return NextResponse.json(
        { error: "XAI_MODEL is set in the environment, so the model cannot be changed here." },
        { status: 409 },
      );
    }
    const stored = await readAiConfig(session.userId);
    if (!stored?.apiKey && !hasEnvAiKey()) {
      return NextResponse.json({ error: "No xAI key configured yet." }, { status: 400 });
    }
    const updated = await saveAiModel(session.userId, body.model);
    return NextResponse.json({ configured: true, model: updated.model });
  }

  /**
   * Refused rather than stored. Saving a key that `XAI_API_KEY` would then override leaves someone
   * believing they switched keys when every request still uses the old one.
   */
  if (hasEnvAiKey()) {
    return NextResponse.json(
      {
        error: isHosted()
          ? "This deployment supplies an xAI key through its environment, and that key takes precedence. There is nothing to paste here."
          : "XAI_API_KEY is set in this app's environment and takes precedence. Remove it from .env.local and restart if you want to paste a key here instead.",
      },
      { status: 409 },
    );
  }

  const apiKey = body.apiKey?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "Paste your xAI API key." }, { status: 400 });
  }
  if (apiKey.length < 20) {
    return NextResponse.json(
      { error: "That looks too short to be an xAI API key." },
      { status: 400 },
    );
  }

  try {
    // Validate before storing, so a typo is caught here rather than mid-summary.
    const models = await listModels(apiKey);
    const model = body.model?.trim() || pickModel(models);
    const saved = await saveAiConfig(session.userId, apiKey, model);

    return NextResponse.json({
      configured: true,
      model: saved.model,
      models,
      keyPreview: maskSecret(apiKey),
    });
  } catch (error) {
    if (error instanceof GrokError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Could not reach xAI: ${(error as Error).message}` },
      { status: 502 },
    );
  }
}

export async function DELETE() {
  const session = await currentSession();
  if (!session) return notConnected();

  await clearAiConfig(session.userId);
  // The stored key is gone, but an environment key is not ours to remove — say so rather than
  // reporting "not configured" while summaries keep working.
  return NextResponse.json(await aiKeyStatus(session.userId));
}
