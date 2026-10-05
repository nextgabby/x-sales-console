import { demoChatStream } from "./demo/ai";
import { isDemoAiLive, isDemoMode } from "./demo/mode";

/**
 * Minimal xAI client. The API is OpenAI-compatible, so chat completions and the model list
 * need nothing beyond fetch — no SDK, and the provider stays swappable.
 */

const XAI_BASE = process.env.XAI_API_BASE?.replace(/\/$/, "") || "https://api.x.ai/v1";

export const DEFAULT_MODEL = "grok-4.6";

export class GrokError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GrokError";
    this.status = status;
  }
}

function describe(status: number, body: unknown): string {
  const message = (body as { error?: { message?: string } | string })?.error;
  const text =
    typeof message === "string" ? message : (message?.message ?? JSON.stringify(body));
  if (status === 401 || status === 403) {
    return "That key was rejected by xAI. Check it was copied in full and is still active.";
  }
  if (status === 429) {
    return "xAI rate-limited the request. Wait a moment and try again.";
  }
  return text?.slice(0, 300) || `xAI returned ${status}.`;
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/**
 * Validates a key by listing the models it can reach, which doubles as the model picker's
 * source. Fetching the list beats hardcoding a name that goes stale as models ship.
 */
export async function listModels(apiKey: string): Promise<string[]> {
  const response = await fetch(`${XAI_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
  });

  const body = await parse(response);
  if (!response.ok) throw new GrokError(response.status, describe(response.status, body));

  const data = (body as { data?: Array<{ id?: string }> })?.data ?? [];
  return data
    .map((entry) => entry.id)
    .filter((id): id is string => Boolean(id))
    .sort();
}

/** Prefers the configured default, then the newest-looking chat model the key can reach. */
export function pickModel(models: string[]): string {
  if (models.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;

  const chatModels = models.filter(
    (id) =>
      id.startsWith("grok") &&
      !/image|vision|embed|audio|video|code|build/i.test(id),
  );
  if (chatModels.length === 0) return models[0] ?? DEFAULT_MODEL;

  // Highest version number wins, so a newer Grok is picked up without a code change.
  const version = (id: string) => {
    const match = /grok-(\d+)(?:\.(\d+))?/.exec(id);
    return match ? Number(match[1]) * 1000 + Number(match[2] ?? 0) : 0;
  };
  return [...chatModels].sort((a, b) => version(b) - version(a))[0]!;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Streams a completion as plain text deltas. Returning text rather than raw SSE keeps the
 * client trivial: read the body and append.
 */
export async function streamChat(options: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
}): Promise<ReadableStream<Uint8Array>> {
  // Demo mode serves fixed text unless DEMO_AI=live, so an open URL cannot run up an xAI bill.
  if (isDemoMode() && !isDemoAiLive()) return demoChatStream(options.messages);

  const response = await fetch(`${XAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.3,
      stream: true,
    }),
    signal: options.signal,
    cache: "no-store",
  });

  if (!response.ok || !response.body) {
    const body = await parse(response);
    throw new GrokError(response.status, describe(response.status, body));
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        // SSE events are newline-delimited; the last fragment may be incomplete.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let emitted = "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            emitted += chunk.choices?.[0]?.delta?.content ?? "";
          } catch {
            // Ignore keep-alives and anything unparseable.
          }
        }

        if (emitted) {
          controller.enqueue(encoder.encode(emitted));
          return;
        }
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
}
