"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Badge, Button, buttonClasses, Callout, Field, Input, Skeleton } from "@/components/ui";
import { GrokKey } from "./grok-key";

type ConnectionStatus = {
  isConnected: boolean;
  canSignIn: boolean;
  hosted: boolean;
  keysFromEnv: boolean;
  consumerKeyPreview: string | null;
  allowlistConfigured: boolean;
  handle: string | null;
  displayName: string | null;
  callbackUrl: string;
};

async function fetchConnection(): Promise<ConnectionStatus> {
  const response = await fetch("/api/connection", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not read connection status.");
  return response.json();
}

export function SetupWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectError = searchParams.get("error");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["connection"],
    queryFn: fetchConnection,
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="rise space-y-10">
      <header className="space-y-3">
        <Badge tone="accent">Internal tool</Badge>
        {/*
          The headline names the product, not the identity provider. A page on an unaffiliated domain
          whose first line is "Sign in with <brand>" has the shape of a credential-harvesting page,
          and Safe Browsing blocked this deployment as one. Authorization is described below instead,
          including the fact that it happens on x.com rather than here.
        */}
        <h1 className="text-3xl font-bold tracking-tight">Ads Sales Console</h1>
        <p className="text-[15px] leading-relaxed text-muted">
          {data.hosted ? (
            <>
              Campaign performance for the advertiser accounts you already have access to. You
              approve access on <span className="text-ink">x.com</span> — your password is never
              entered here — and every request the console makes afterwards is signed with{" "}
              <span className="text-ink">your own</span> token, so nothing is shared between people.
            </>
          ) : (
            <>
              This runs entirely on your machine and uses{" "}
              <span className="text-ink">your own</span> app credentials. Your keys are encrypted on
              this computer and are only ever sent to X.
            </>
          )}
        </p>
      </header>

      {redirectError ? <Callout tone="negative">{redirectError}</Callout> : null}

      {data.isConnected ? (
        <>
          <ConnectedPanel data={data} onContinue={() => router.push("/accounts")} />
          <GrokKey />
        </>
      ) : data.hosted ? (
        <HostedSignIn data={data} />
      ) : (
        <LocalSteps data={data} onSaved={refetch} />
      )}
    </div>
  );
}

/**
 * The hosted build has no setup: one team-owned app is already registered, so there is a single
 * button and nothing to paste.
 */
function HostedSignIn({ data }: { data: ConnectionStatus }) {
  return (
    <div className="space-y-6 rounded-2xl border border-border bg-surface p-6">
      {data.canSignIn ? (
        <>
          {/* A real navigation, not a router push: this route redirects out to X. */}
          <a href="/api/auth/start" className={buttonClasses("primary")}>
            Authorize with X
          </a>
          <p className="text-sm leading-relaxed text-muted">
            {data.allowlistConfigured
              ? "Access is limited to approved handles. If yours has not been added yet, ask whoever runs this deployment to add it."
              : "You will be asked to approve read access to your ad accounts."}
          </p>
        </>
      ) : (
        <Callout tone="negative">
          This deployment is missing its X app credentials, so sign-in is unavailable. Whoever
          configured it needs to set X_CONSUMER_KEY and X_CONSUMER_SECRET.
        </Callout>
      )}
    </div>
  );
}

/** The launcher flow: the rep's own developer app, so the callback and keys are theirs to set up. */
function LocalSteps({
  data,
  onSaved,
}: {
  data: ConnectionStatus;
  onSaved: () => void;
}) {
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const hasKeys = Boolean(data.consumerKeyPreview);

  async function saveKeys(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consumerKey, consumerSecret }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save credentials.");
      setConsumerKey("");
      setConsumerSecret("");
      onSaved();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function copyCallback() {
    await navigator.clipboard.writeText(data.callbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="space-y-8">
      <Step
        index={1}
        title="Add the callback URL to your app"
        done={false}
        description="In your own app's settings on console.x.com, add this exact URL to the allowed callback URLs. It has to match character for character, and X accepts 127.0.0.1 rather than localhost. If you have not created an app yet, START-HERE.md walks through it."
      >
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg border border-border bg-canvas px-3 py-2 font-mono text-xs text-ink">
            {data.callbackUrl}
          </code>
          <Button variant="secondary" type="button" onClick={copyCallback}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </Step>

      <Step
        index={2}
        title="Paste your app's API key and secret"
        done={hasKeys}
        description="From the Consumer Keys section of your own app, under Keys and tokens. These identify the app, not you — the next step is what authorizes your account."
      >
        {data.keysFromEnv ? (
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="positive">Set in environment</Badge>
            <code className="font-mono text-xs text-muted">{data.consumerKeyPreview}</code>
            <p className="text-xs text-muted">
              Taken from X_CONSUMER_KEY, which overrides anything saved here.
            </p>
          </div>
        ) : hasKeys ? (
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="positive">Saved</Badge>
            <code className="font-mono text-xs text-muted">{data.consumerKeyPreview}</code>
            <Button
              variant="ghost"
              type="button"
              onClick={async () => {
                setConsumerKey("");
                setConsumerSecret("");
                // Only the app keys, so a rep swapping developer apps does not also have to
                // re-authorize if their token is still good.
                await fetch("/api/setup", { method: "DELETE" });
                onSaved();
              }}
            >
              Replace
            </Button>
          </div>
        ) : (
          <form onSubmit={saveKeys} className="space-y-4">
            <Field label="API Key">
              <Input
                value={consumerKey}
                onChange={(event) => setConsumerKey(event.target.value)}
                placeholder="e.g. OqEqJeafRSF11jBMStrZz"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </Field>
            <Field label="API Key Secret">
              <Input
                type="password"
                value={consumerSecret}
                onChange={(event) => setConsumerSecret(event.target.value)}
                placeholder="Stored encrypted on this machine"
                autoComplete="off"
                required
              />
            </Field>
            {formError ? <Callout tone="negative">{formError}</Callout> : null}
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save keys"}
            </Button>
          </form>
        )}
      </Step>

      <Step
        index={3}
        title="Authorize your account"
        done={false}
        description="This mints an access token that belongs to you. Every request the console makes is signed with it, so you only ever see the ad accounts you already have access to."
        last
      >
        {/* A real navigation, not a router push: this route redirects out to X. */}
        <a
          href="/api/auth/start"
          aria-disabled={!data.canSignIn}
          className={buttonClasses("primary", data.canSignIn ? "" : "pointer-events-none opacity-50")}
        >
          Authorize with X
        </a>
        {!data.canSignIn ? (
          <p className="mt-2 text-xs text-muted">Add your API key and secret first.</p>
        ) : null}
      </Step>
    </div>
  );
}

function ConnectedPanel({
  data,
  onContinue,
}: {
  data: ConnectionStatus;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-6 rounded-2xl border border-border bg-surface p-6">
      <div className="flex items-center gap-3">
        <Badge tone="positive">Connected</Badge>
        <span className="text-sm text-muted">
          Signed in as <span className="font-semibold text-ink">@{data.handle || "unknown"}</span>
          {data.displayName ? ` · ${data.displayName}` : ""}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-muted">
        Requests are signed with your own token, so the console shows exactly the advertiser
        accounts you have been granted — nothing more.
      </p>
      <div className="flex gap-3">
        <Button onClick={onContinue}>View your accounts</Button>
        {/*
         * "Connected" here means a token is stored, which is not the same as it working: a revoked
         * app, a rotated consumer key, or an authorization predating Ads API approval all look
         * identical until X is called. Re-authorizing overwrites the token in place, so this is the
         * way out that does not involve disconnecting and starting over.
         */}
        <a href="/api/auth/start" className={buttonClasses("secondary")}>
          Re-authorize
        </a>
        <Button
          variant="danger"
          onClick={async () => {
            await fetch("/api/auth/disconnect", { method: "POST" });
            window.location.reload();
          }}
        >
          {data.hosted ? "Sign out" : "Disconnect"}
        </Button>
      </div>
    </div>
  );
}

function Step({
  index,
  title,
  description,
  done,
  children,
  last,
}: {
  index: number;
  title: string;
  description: string;
  done: boolean;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section className="relative pl-12">
      <div
        className={`absolute left-0 top-0 flex size-8 items-center justify-center rounded-full border text-sm font-semibold ${
          done
            ? "border-positive/40 bg-positive/10 text-positive"
            : "border-border bg-surface text-muted"
        }`}
      >
        {done ? "✓" : index}
      </div>
      {!last ? (
        <div className="absolute left-4 top-9 bottom-[-2rem] w-px -translate-x-1/2 bg-border" />
      ) : null}
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="mt-1 mb-4 text-sm leading-relaxed text-muted">{description}</p>
      {children}
    </section>
  );
}
