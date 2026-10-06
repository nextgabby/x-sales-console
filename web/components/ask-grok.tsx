"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge, Button, Callout, cx, Input } from "@/components/ui";

type AiStatus = { configured: boolean; model?: string; reachesXai?: boolean };

/**
 * The Grok panel, shared by the campaign comparison and the creative list.
 *
 * Both need the same things — a key check, a streaming request that can be stopped, suggested
 * questions and a free-text box — and differ only in which endpoint they post to and what they
 * call the results. Two copies of the streaming logic would drift.
 */
export function AskGrok({
  endpoint,
  body,
  title,
  description,
  primaryLabel,
  emptyState,
  suggestions,
  askPlaceholder,
  unconfiguredHint,
  className,
}: {
  endpoint: string;
  /** Merged into the POST body alongside the question. */
  body: Record<string, unknown>;
  title: string;
  description: string;
  primaryLabel: string;
  emptyState: string;
  suggestions: string[];
  askPlaceholder: string;
  unconfiguredHint: string;
  className?: string;
}) {
  const { data: ai, isLoading: checkingKey } = useQuery({
    queryKey: ["ai-key"],
    queryFn: async () => {
      const response = await fetch("/api/ai/key", { cache: "no-store" });
      return (await response.json()) as AiStatus;
    },
  });

  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function run(prompt: string | null) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStreaming(true);
    setError(null);
    setText("");
    setAsked(prompt);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, question: prompt }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? "Grok could not be reached.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      // Append as chunks arrive so the rep sees progress rather than a spinner.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setText((previous) => previous + decoder.decode(value, { stream: true }));
      }
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") {
        setError((caught as Error).message);
      }
    } finally {
      setStreaming(false);
    }
  }

  if (checkingKey) return null;

  if (!ai?.configured) {
    return (
      <section className={cx("rounded-2xl border border-border bg-surface p-5", className)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            <p className="mt-0.5 text-xs text-muted">{unconfiguredHint}</p>
          </div>
          <Link
            href="/setup#grok"
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            Add your xAI key
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className={cx("rounded-2xl border border-border bg-surface p-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {title}
            {ai.model ? <Badge tone="accent">{ai.model}</Badge> : null}
          </h2>
          <p className="mt-0.5 text-xs text-muted">{description}</p>
          {/*
            The disclosure sits here rather than on the setup page, which a rep sees once and which
            no longer shows them anything when the key belongs to the deployment. This is the button
            that does the sending — and in the demo nothing is sent at all, so it says nothing.
          */}
          {ai.reachesXai ? (
            <p className="mt-0.5 text-xs text-muted">
              Figures from this view are sent to xAI when you press {primaryLabel}, and not before.
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {streaming ? (
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-xs"
              onClick={() => abortRef.current?.abort()}
            >
              Stop
            </Button>
          ) : null}
          <Button
            className="px-3 py-1.5 text-xs"
            onClick={() => void run(null)}
            disabled={streaming}
          >
            {text ? "Regenerate" : primaryLabel}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-4">
          <Callout tone="negative">{error}</Callout>
        </div>
      ) : null}

      {asked ? (
        <p className="mt-4 text-xs text-muted">
          <span className="font-semibold text-ink">Asked:</span> {asked}
        </p>
      ) : null}

      {text ? (
        <div className="mt-3 space-y-2 text-sm leading-relaxed whitespace-pre-wrap text-ink">
          {renderNarrative(text)}
          {streaming ? (
            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" />
          ) : null}
        </div>
      ) : streaming ? (
        <p className="mt-4 text-sm text-muted">Reading the numbers…</p>
      ) : (
        <p className="mt-4 text-sm text-muted">{emptyState}</p>
      )}

      <div className="mt-5 border-t border-border pt-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = question.trim();
            if (!trimmed || streaming) return;
            setQuestion("");
            void run(trimmed);
          }}
          className="flex gap-2"
        >
          <Input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={askPlaceholder}
            disabled={streaming}
          />
          <Button
            type="submit"
            variant="secondary"
            className="shrink-0 px-4 py-2 text-xs"
            disabled={streaming || question.trim().length === 0}
          >
            Ask
          </Button>
        </form>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => void run(suggestion)}
              disabled={streaming}
              className={cx(
                "rounded-full border border-border px-2.5 py-1 text-[11px] text-muted transition-colors",
                streaming
                  ? "cursor-not-allowed opacity-50"
                  : "hover:border-border-strong hover:text-ink",
              )}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Deliberately not a markdown renderer. The model is asked for short paragraphs and bullets,
 * and pulling in a parser plus sanitizer to render a few kinds of node is not worth the
 * dependency or the injection surface.
 */
function renderNarrative(text: string) {
  return text.split(/\n{2,}/).map((block, blockIndex) => {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    const bulleted = lines.length > 0 && lines.every((line) => /^\s*[-*•]\s/.test(line));
    const numbered = lines.length > 0 && lines.every((line) => /^\s*\d+[.)]\s/.test(line));

    if (bulleted || numbered) {
      const Tag = numbered ? "ol" : "ul";
      return (
        <Tag
          key={blockIndex}
          className={cx(
            "space-y-1 pl-5",
            numbered ? "list-decimal" : "list-disc",
          )}
        >
          {lines.map((line, index) => (
            <li key={index}>
              {emphasize(line.replace(/^\s*(?:[-*•]|\d+[.)])\s/, ""))}
            </li>
          ))}
        </Tag>
      );
    }

    return <p key={blockIndex}>{emphasize(block)}</p>;
  });
}

/** Renders **bold** only; everything else stays literal text. */
function emphasize(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={index} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}
