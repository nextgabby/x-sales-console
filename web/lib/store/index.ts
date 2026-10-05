import { decryptSecret, encryptSecret, maskSecret } from "../crypto";
import { isHosted } from "../db";
import { DEFAULT_MODEL as FALLBACK_AI_MODEL } from "../grok";
import { isDemoAiLive, isDemoMode } from "../demo/mode";
import { DEMO_CREDENTIALS, DEMO_SPY_GRANTS, DEMO_USER } from "../demo/store";
import { deleteStoredAppKeys, fileBackend, readStoredAppKeys, writeStoredAppKeys } from "./files";
import { postgresBackend } from "./postgres";
import type { AiConfig, AuditEvent, SpyGrant, StoredUser, XCredentials } from "./types";

export type { AiConfig, AuditEvent, SpyGrant, StoredUser, XCredentials } from "./types";

/**
 * Every read and write goes through here, so the two deployments differ in one place.
 *
 * `DATABASE_URL` set means the hosted multi-rep build; unset means the local single-user tool. The
 * backends implement the same user-scoped interface, so nothing above this file branches on it.
 */
function backend() {
  return isHosted() ? postgresBackend : fileBackend;
}

export class ReadOnlyStoreError extends Error {
  constructor(message = "This is a demo. Settings cannot be changed here.") {
    super(message);
    this.name = "ReadOnlyStoreError";
  }
}

function refuseInDemo() {
  if (isDemoMode()) throw new ReadOnlyStoreError();
}

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "");
}

/* ------------------------------------------------------------------ the app's own X credentials */

/**
 * Consumer keys identify the *application*, not the rep, so they are never user-scoped.
 *
 * The environment wins, and on the hosted deployment it is the only source. That is what the
 * team-owned app decision buys: OAuth redirects back to one fixed callback URL, and that URL has to
 * be registered inside whichever developer app the consumer key belongs to — so per-rep keys would
 * mean every rep registering the hosted callback in their own app before they could log in, and
 * again whenever the URL changed. One app registered once removes that, and costs nothing in
 * attribution, because each rep still completes their own OAuth and gets their own access token.
 *
 * The stored fallback is for the launcher, where each rep uses their own app and pastes its keys
 * into the setup wizard. Reading the environment first means a rep who later moves onto the hosted
 * build cannot end up signing requests with stale keys left on disk.
 */
export async function consumerCredentials(): Promise<{ key: string; secret: string } | null> {
  const key = process.env.X_CONSUMER_KEY?.trim();
  const secret = process.env.X_CONSUMER_SECRET?.trim();
  if (key && secret) return { key, secret };
  if (isHosted()) return null;

  const stored = readStoredAppKeys();
  return stored
    ? { key: stored.consumerKey, secret: decryptSecret(stored.consumerSecret) }
    : null;
}

/** True when the keys are fixed by the deployment, so the UI must not offer to change them. */
export function consumerKeysFromEnv(): boolean {
  return Boolean(process.env.X_CONSUMER_KEY?.trim() && process.env.X_CONSUMER_SECRET?.trim());
}

export async function saveConsumerKeys(key: string, secret: string): Promise<void> {
  refuseInDemo();
  if (isHosted()) {
    throw new ReadOnlyStoreError(
      "This deployment supplies its own app keys. There is nothing to paste here.",
    );
  }
  writeStoredAppKeys({
    consumerKey: key.trim(),
    consumerSecret: encryptSecret(secret.trim()),
    savedAt: new Date().toISOString(),
  });
}

/** Lets a local rep swap in a different developer app without finding the data directory. */
export async function clearConsumerKeys(): Promise<void> {
  refuseInDemo();
  if (!isHosted()) deleteStoredAppKeys();
}

export async function consumerKeyPreview(): Promise<string | null> {
  if (consumerKeysFromEnv()) return maskSecret(process.env.X_CONSUMER_KEY!.trim());
  if (isHosted()) return null;
  const stored = readStoredAppKeys();
  return stored ? maskSecret(stored.consumerKey) : null;
}

/* ----------------------------------------------------------------------------------------- users */

export async function getUser(userId: string): Promise<StoredUser | null> {
  if (isDemoMode()) return DEMO_USER;
  return backend().getUser(userId);
}

export async function listUsers(): Promise<StoredUser[]> {
  if (isDemoMode()) return [DEMO_USER];
  return backend().listUsers();
}

export async function saveUser(params: {
  userId: string;
  handle: string;
  accessToken: string;
  accessTokenSecret: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}): Promise<StoredUser> {
  refuseInDemo();
  const user: StoredUser = {
    userId: params.userId,
    handle: params.handle,
    displayName: params.displayName ?? null,
    avatarUrl: params.avatarUrl ?? null,
    accessToken: params.accessToken,
    accessTokenSecret: encryptSecret(params.accessTokenSecret),
    connectedAt: new Date().toISOString(),
  };
  await backend().putUser(user);
  return user;
}

export async function deleteUser(userId: string): Promise<void> {
  refuseInDemo();
  await backend().deleteUser(userId);
}

/** Decrypts into memory for the duration of one request. Never return this to the client. */
export async function resolveCredentials(userId: string): Promise<XCredentials | null> {
  if (isDemoMode()) return DEMO_CREDENTIALS;

  const consumer = await consumerCredentials();
  const user = await backend().getUser(userId);
  if (!consumer || !user) return null;

  return {
    consumerKey: consumer.key,
    consumerSecret: consumer.secret,
    accessToken: user.accessToken,
    accessTokenSecret: decryptSecret(user.accessTokenSecret),
  };
}

/* ------------------------------------------------------------------------------ oauth handshake */

/**
 * The request token secret has to survive the redirect to X and back, so it is parked in storage
 * between leg one and leg three rather than held in memory — which also means it works when more
 * than one instance is serving requests.
 */
export async function savePendingRequestToken(token: string, tokenSecret: string): Promise<void> {
  refuseInDemo();
  await backend().putPendingToken({ token, tokenSecret: encryptSecret(tokenSecret) });
}

export async function takePendingRequestToken(
  token: string,
): Promise<{ token: string; tokenSecret: string } | null> {
  const pending = await backend().takePendingToken(token);
  if (!pending) return null;
  return { token: pending.token, tokenSecret: decryptSecret(pending.tokenSecret) };
}

/* ------------------------------------------------------------------------------------ favorites */

export async function readFavorites(userId: string): Promise<string[]> {
  return backend().listFavorites(userId);
}

export async function toggleFavorite(userId: string, accountId: string): Promise<string[]> {
  const current = new Set(await backend().listFavorites(userId));
  if (current.has(accountId)) {
    current.delete(accountId);
  } else {
    current.add(accountId);
  }
  const next = [...current];
  await backend().putFavorites(userId, next);
  return next;
}

/* ----------------------------------------------------------------------------------- spy grants */

/**
 * Spy access is granted per ad account, and no API endpoint enumerates it — the list lives only in
 * the spy manager UI. So reps paste it in, each entry is verified against the API, and the verified
 * grants are stored per rep.
 */
export async function readSpyGrants(userId: string): Promise<SpyGrant[]> {
  if (isDemoMode()) return DEMO_SPY_GRANTS;
  return backend().listSpyGrants(userId);
}

export async function saveSpyGrants(userId: string, grants: SpyGrant[]): Promise<SpyGrant[]> {
  refuseInDemo();
  await backend().putSpyGrants(userId, grants);
  return backend().listSpyGrants(userId);
}

export async function removeSpyGrant(userId: string, accountId: string): Promise<SpyGrant[]> {
  refuseInDemo();
  await backend().deleteSpyGrant(userId, accountId);
  return backend().listSpyGrants(userId);
}

export async function removeSpyHandleGroup(userId: string, asUser: string): Promise<SpyGrant[]> {
  refuseInDemo();
  await backend().deleteSpyGrantsByHandle(userId, normalizeHandle(asUser));
  return backend().listSpyGrants(userId);
}

/* ------------------------------------------------------------------------------------- xai keys */

export async function readAiConfig(userId: string): Promise<AiConfig | null> {
  if (isDemoMode()) return null;
  return backend().getAiConfig(userId);
}

export async function saveAiConfig(
  userId: string,
  apiKey: string,
  model: string,
): Promise<AiConfig> {
  refuseInDemo();
  const config: AiConfig = {
    apiKey: encryptSecret(apiKey.trim()),
    model: model.trim(),
    savedAt: new Date().toISOString(),
  };
  await backend().putAiConfig(userId, config);
  return config;
}

/**
 * Upserts the model choice. It is stored even with no key of its own, so a model picked while
 * `XAI_API_KEY` supplies the key still survives a restart. An empty `apiKey` never resolves.
 */
export async function saveAiModel(userId: string, model: string): Promise<AiConfig> {
  refuseInDemo();
  const existing = await backend().getAiConfig(userId);
  const config: AiConfig = {
    apiKey: existing?.apiKey ?? "",
    model: model.trim(),
    savedAt: existing?.savedAt ?? new Date().toISOString(),
  };
  await backend().putAiConfig(userId, config);
  return config;
}

export async function clearAiConfig(userId: string): Promise<void> {
  refuseInDemo();
  await backend().deleteAiConfig(userId);
}

export type AiKeySource = "env" | "stored";

function envAiKey(): string | null {
  return process.env.XAI_API_KEY?.trim() || null;
}

/** Set to pin the model alongside `XAI_API_KEY`; otherwise the stored choice applies. */
function envAiModel(): string | null {
  return process.env.XAI_MODEL?.trim() || null;
}

/**
 * Decrypts into memory for one request. Never return this to the client.
 *
 * `XAI_API_KEY` wins over a stored key. In a hosted deployment it is the shared team key, which is
 * the deliberate declaration; letting a rep's stale stored key silently take precedence is how
 * someone ends up billing the wrong account.
 */
export async function resolveAiKey(
  userId: string,
): Promise<{ apiKey: string; model: string; source: AiKeySource } | null> {
  /**
   * In demo mode the AI panels should look available whether or not a key is present, because with
   * `DEMO_AI` unset nothing reaches xAI anyway — `streamChat` answers from fixed text. Reporting
   * "not configured" would hide the feature rather than demonstrate it.
   */
  if (isDemoMode() && !isDemoAiLive()) {
    return { apiKey: "demo", model: envAiModel() ?? FALLBACK_AI_MODEL, source: "env" };
  }

  const fromEnv = envAiKey();
  if (fromEnv) {
    const stored = await readAiConfig(userId);
    return {
      apiKey: fromEnv,
      model: envAiModel() ?? stored?.model ?? FALLBACK_AI_MODEL,
      source: "env",
    };
  }

  const config = await readAiConfig(userId);
  if (!config?.apiKey) return null;
  return { apiKey: decryptSecret(config.apiKey), model: config.model, source: "stored" };
}

/** Everything the settings UI needs, without the key itself. */
export async function aiKeyStatus(userId: string) {
  const resolved = await resolveAiKey(userId);
  if (!resolved) return { configured: false as const };

  const stored = await readAiConfig(userId);
  return {
    configured: true as const,
    source: resolved.source,
    model: resolved.model,
    /** True when `XAI_MODEL` pins the model, so the picker cannot change it. */
    modelLocked: resolved.source === "env" && envAiModel() != null,
    savedAt: resolved.source === "stored" ? (stored?.savedAt ?? null) : null,
    keyPreview: maskSecret(resolved.apiKey),
    /** A stored key exists but is being ignored in favour of the environment. */
    storedKeyShadowed: resolved.source === "env" && Boolean(stored?.apiKey),
  };
}

export function hasEnvAiKey(): boolean {
  return envAiKey() != null;
}

/* ---------------------------------------------------------------------------------------- audit */

/**
 * Fire-and-forget, and deliberately so. An audit write failing must not turn a working data request
 * into an error for the rep, and in the hosted build it is a network round trip that would otherwise
 * be added to the latency of every single Ads API call.
 */
export function recordAudit(event: AuditEvent): void {
  if (isDemoMode()) return;
  void backend()
    .appendAudit(event)
    .catch((error) => {
      console.error("Could not write audit event", error);
    });
}

export async function readAudit(options: { userId?: string; limit?: number } = {}) {
  if (isDemoMode()) return [];
  return backend().readAudit({ userId: options.userId, limit: options.limit ?? 200 });
}
