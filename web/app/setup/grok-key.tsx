"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge, Button, Callout, Field, Input } from "@/components/ui";

type AiStatus = {
  configured: boolean;
  source?: "env" | "stored";
  model?: string;
  modelLocked?: boolean;
  keyPreview?: string | null;
  savedAt?: string | null;
  storedKeyShadowed?: boolean;
  models?: string[];
};

/**
 * `hosted` only changes wording, but the wording was wrong without it: a rep on the shared
 * deployment has no `.env.local` to edit and no machine of their own for a key to be encrypted on.
 */
export function GrokKey({ hosted }: { hosted: boolean }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["ai-key"],
    queryFn: async () => {
      const response = await fetch("/api/ai/key?models=1", { cache: "no-store" });
      return (await response.json()) as AiStatus;
    },
  });

  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/ai/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save the key.");
      setApiKey("");
      await refetch();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function changeModel(model: string) {
    await fetch("/api/ai/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    await refetch();
  }

  async function remove() {
    await fetch("/api/ai/key", { method: "DELETE" });
    await refetch();
  }

  if (isLoading) return null;

  const fromEnv = data?.source === "env";

  /**
   * Nothing here belongs to a rep on the shared deployment: the key is the team's and the model is
   * whatever was set alongside it, so a masked preview and an environment variable name are only an
   * invitation to fiddle. The panel still appears when a rep supplies their own key, and always in
   * the local install, where the reader is the person who configured it.
   */
  if (hosted && fromEnv) return null;

  return (
    <section id="grok" className="rounded-2xl border border-border bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Grok summaries</h2>
        {data?.configured ? (
          <Badge tone="positive">
            {data.source === "env" ? "From environment" : "Connected"}
          </Badge>
        ) : (
          <Badge>Optional</Badge>
        )}
      </div>

      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        {fromEnv ? (
          <>
            Optional, and already set up. In the compare view, Grok can write a summary and answer
            questions about the campaigns you selected. The key comes from{" "}
            <code className="font-mono">XAI_API_KEY</code>
            {hosted ? (
              <>, set on this deployment and shared by everyone using it.</>
            ) : (
              <>
                {" "}
                in <code className="font-mono">.env.local</code>.
              </>
            )}
          </>
        ) : (
          <>
            Optional. With your own{" "}
            <a
              className="underline hover:text-ink"
              href="https://console.x.ai"
              target="_blank"
              rel="noreferrer"
            >
              xAI API key
            </a>
            , the compare view can write a summary and answer questions about the campaigns you
            selected. Paste it below.{" "}
            {hosted
              ? "It is encrypted and stored against your account, so it is yours alone."
              : "It is encrypted on this machine."}{" "}
            It is only ever sent to xAI.
          </>
        )}
      </p>

      {data?.configured ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <code className="font-mono text-xs text-muted">{data.keyPreview}</code>
            {fromEnv ? (
              <span className="text-xs text-muted">
                from <code className="font-mono">XAI_API_KEY</code> ·{" "}
                {hosted ? (
                  <>changing it means editing the environment variables on the deployment</>
                ) : (
                  <>
                    change it in <code className="font-mono">.env.local</code> and restart
                  </>
                )}
              </span>
            ) : (
              <Button variant="ghost" onClick={remove}>
                Remove key
              </Button>
            )}
          </div>

          {data.storedKeyShadowed ? (
            <Callout tone="warn">
              A key saved here is being ignored because <code className="font-mono">XAI_API_KEY</code>{" "}
              is set. Remove that variable from the environment to use the saved key, or remove the
              saved key to avoid the ambiguity.
              <span className="mt-2 block">
                <Button variant="ghost" onClick={remove}>
                  Remove saved key
                </Button>
              </span>
            </Callout>
          ) : null}

          <Field
            label="Model"
            hint={
              data.modelLocked
                ? "Pinned by XAI_MODEL in your environment."
                : "Fetched from your key, so newer Grok models appear here as they ship."
            }
          >
            {(data.models?.length ?? 0) > 0 && !data.modelLocked ? (
              <select
                value={data.model}
                onChange={(event) => void changeModel(event.target.value)}
                className="w-full rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none"
              >
                {data.models?.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex items-center gap-2">
                <code className="font-mono text-xs text-ink">{data.model}</code>
                {data.modelLocked ? null : (
                  <span className="text-xs text-muted">
                    · could not reach xAI to list the other models
                  </span>
                )}
              </div>
            )}
          </Field>
        </div>
      ) : (
        <form onSubmit={save} className="mt-4 space-y-4">
          <Field label="xAI API key" hint="Checked against xAI before it is saved.">
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="xai-…"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          {error ? <Callout tone="negative">{error}</Callout> : null}
          <Button type="submit" disabled={saving || apiKey.trim().length === 0}>
            {saving ? "Checking with xAI…" : "Save key"}
          </Button>
        </form>
      )}

      <p className="mt-4 text-xs leading-relaxed text-muted">
        Campaign performance figures for the campaigns you are comparing are sent to xAI to
        produce the summary. Nothing is sent until you press Summarize.
      </p>
    </section>
  );
}
