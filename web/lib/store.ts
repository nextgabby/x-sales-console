import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decryptSecret, encryptSecret, maskSecret } from "./crypto";
import { DEFAULT_MODEL as FALLBACK_AI_MODEL } from "./grok";
import { DATA_DIR } from "./paths";
import { isDemoAiLive, isDemoMode } from "./demo/mode";
import {
  DEMO_CONNECTION,
  DEMO_CREDENTIALS,
  DEMO_SPY_GRANTS,
  demoFavorites,
  demoToggleFavorite,
} from "./demo/store";

/**
 * Single-user file store. Every read and write goes through this module so swapping in a
 * real database for a hosted deployment only touches this file.
 *
 * Demo mode is handled here rather than at the routes for the same reason: this is the one place
 * that touches disk, so guarding it is what makes a demo deployment stateless. Writes become
 * no-ops; there are no secrets to write and nothing a visitor does should outlive their visit.
 */

class DemoReadOnlyError extends Error {
  constructor() {
    super("This is a demo. Settings cannot be changed here.");
  }
}

const CONNECTION_PATH = join(DATA_DIR, "connection.json");
const FAVORITES_PATH = join(DATA_DIR, "favorites.json");
const AUDIT_PATH = join(DATA_DIR, "audit.jsonl");
const PENDING_PATH = join(DATA_DIR, "pending-request-token.json");
const SPY_PATH = join(DATA_DIR, "spy-handles.json");
const AI_PATH = join(DATA_DIR, "ai.json");

export type XCredentials = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

export type Connection = {
  consumerKey: string;
  /** Encrypted at rest. */
  consumerSecret: string;
  accessToken?: string;
  /** Encrypted at rest. */
  accessTokenSecret?: string;
  handle?: string;
  userId?: string;
  displayName?: string;
  avatarUrl?: string;
  connectedAt?: string;
};

export type AuditEvent = {
  at: string;
  handle: string | null;
  accountId: string | null;
  path: string;
  asUser: string | null;
  status: number | null;
  durationMs: number;
};

function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  ensureDataDir();
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function readConnection(): Connection | null {
  if (isDemoMode()) return DEMO_CONNECTION;
  return readJson<Connection | null>(CONNECTION_PATH, null);
}

export function saveConsumerKeys(consumerKey: string, consumerSecret: string): Connection {
  if (isDemoMode()) throw new DemoReadOnlyError();
  const existing = readConnection();
  const next: Connection = {
    ...existing,
    consumerKey: consumerKey.trim(),
    consumerSecret: encryptSecret(consumerSecret.trim()),
  };
  // Changing the app invalidates any user token minted by the previous one.
  if (existing?.consumerKey && existing.consumerKey !== next.consumerKey) {
    delete next.accessToken;
    delete next.accessTokenSecret;
    delete next.handle;
    delete next.userId;
    delete next.displayName;
    delete next.avatarUrl;
    delete next.connectedAt;
  }
  writeJson(CONNECTION_PATH, next);
  return next;
}

export function saveUserTokens(params: {
  accessToken: string;
  accessTokenSecret: string;
  handle: string;
  userId: string;
  displayName?: string;
  avatarUrl?: string;
}): Connection {
  if (isDemoMode()) throw new DemoReadOnlyError();
  const existing = readConnection();
  if (!existing?.consumerKey) {
    throw new Error("No consumer keys stored. Complete setup before saving user tokens.");
  }
  const next: Connection = {
    ...existing,
    accessToken: params.accessToken,
    accessTokenSecret: encryptSecret(params.accessTokenSecret),
    handle: params.handle,
    userId: params.userId,
    displayName: params.displayName,
    avatarUrl: params.avatarUrl,
    connectedAt: new Date().toISOString(),
  };
  writeJson(CONNECTION_PATH, next);
  return next;
}

/** Decrypts into memory for the duration of one request. Never return this to the client. */
export function resolveCredentials(): XCredentials | null {
  if (isDemoMode()) return DEMO_CREDENTIALS;
  const connection = readConnection();
  if (
    !connection?.consumerKey ||
    !connection.consumerSecret ||
    !connection.accessToken ||
    !connection.accessTokenSecret
  ) {
    return null;
  }
  return {
    consumerKey: connection.consumerKey,
    consumerSecret: decryptSecret(connection.consumerSecret),
    accessToken: connection.accessToken,
    accessTokenSecret: decryptSecret(connection.accessTokenSecret),
  };
}

/** Consumer-only credentials, used for the OAuth handshake before a user token exists. */
export function resolveConsumerCredentials(): { key: string; secret: string } | null {
  if (isDemoMode()) return null;
  const connection = readConnection();
  if (!connection?.consumerKey || !connection.consumerSecret) return null;
  return { key: connection.consumerKey, secret: decryptSecret(connection.consumerSecret) };
}

export function clearConnection() {
  if (isDemoMode()) throw new DemoReadOnlyError();
  writeJson(CONNECTION_PATH, null);
}

/**
 * The request token secret has to survive the redirect to X and back, so it is parked on
 * disk between leg one and leg three of the handshake rather than held in memory.
 */
export function savePendingRequestToken(token: string, tokenSecret: string) {
  if (isDemoMode()) throw new DemoReadOnlyError();
  writeJson(PENDING_PATH, {
    token,
    tokenSecret: encryptSecret(tokenSecret),
    createdAt: new Date().toISOString(),
  });
}

export function takePendingRequestToken(
  token: string,
): { token: string; tokenSecret: string } | null {
  const pending = readJson<{ token: string; tokenSecret: string } | null>(PENDING_PATH, null);
  if (!pending || pending.token !== token) return null;
  writeJson(PENDING_PATH, null);
  return { token: pending.token, tokenSecret: decryptSecret(pending.tokenSecret) };
}

export function readFavorites(): string[] {
  if (isDemoMode()) return demoFavorites();
  return readJson<string[]>(FAVORITES_PATH, []);
}

export function toggleFavorite(accountId: string): string[] {
  if (isDemoMode()) return demoToggleFavorite(accountId);
  const current = new Set(readFavorites());
  if (current.has(accountId)) {
    current.delete(accountId);
  } else {
    current.add(accountId);
  }
  const next = [...current];
  writeJson(FAVORITES_PATH, next);
  return next;
}

export type SpyGrant = {
  accountId: string;
  /** The handle to send as `x-as-user` when reaching this account. */
  asUser: string;
  name: string;
  timezone: string;
  approvalStatus: string | null;
  addedAt: string;
};

/**
 * Spy access is granted per ad account, and no API endpoint enumerates it — the list lives
 * only in the spy manager UI. So reps paste it in, each entry is verified against the API,
 * and the verified grants are stored here.
 */
export function readSpyGrants(): SpyGrant[] {
  if (isDemoMode()) return DEMO_SPY_GRANTS;
  return readJson<SpyGrant[]>(SPY_PATH, []);
}

export function saveSpyGrants(grants: SpyGrant[]): SpyGrant[] {
  if (isDemoMode()) throw new DemoReadOnlyError();
  const byId = new Map(readSpyGrants().map((grant) => [grant.accountId, grant]));
  for (const grant of grants) byId.set(grant.accountId, grant);
  const next = [...byId.values()].sort(
    (a, b) => a.asUser.localeCompare(b.asUser) || a.name.localeCompare(b.name),
  );
  writeJson(SPY_PATH, next);
  return next;
}

export function removeSpyGrant(accountId: string): SpyGrant[] {
  if (isDemoMode()) throw new DemoReadOnlyError();
  const next = readSpyGrants().filter((grant) => grant.accountId !== accountId);
  writeJson(SPY_PATH, next);
  return next;
}

export function removeSpyHandleGroup(asUser: string): SpyGrant[] {
  if (isDemoMode()) throw new DemoReadOnlyError();
  const normalized = normalizeHandle(asUser).toLowerCase();
  const next = readSpyGrants().filter(
    (grant) => grant.asUser.toLowerCase() !== normalized,
  );
  writeJson(SPY_PATH, next);
  return next;
}

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "");
}

export type AiConfig = {
  /** Encrypted at rest, exactly like the X secrets. */
  apiKey: string;
  model: string;
  savedAt: string;
};

/**
 * The xAI key is the rep's own, stored beside their X credentials and never returned to the
 * browser — the same rule the X secrets follow.
 */
export function readAiConfig(): AiConfig | null {
  if (isDemoMode()) return null;
  return readJson<AiConfig | null>(AI_PATH, null);
}

export function saveAiConfig(apiKey: string, model: string): AiConfig {
  if (isDemoMode()) throw new DemoReadOnlyError();
  const next: AiConfig = {
    apiKey: encryptSecret(apiKey.trim()),
    model: model.trim(),
    savedAt: new Date().toISOString(),
  };
  writeJson(AI_PATH, next);
  return next;
}

/**
 * Upserts the model choice. It is stored even with no key of its own, so a model picked while
 * `XAI_API_KEY` supplies the key still survives a restart. An empty `apiKey` never resolves.
 */
export function saveAiModel(model: string): AiConfig {
  if (isDemoMode()) throw new DemoReadOnlyError();
  const existing = readAiConfig();
  const next: AiConfig = {
    apiKey: existing?.apiKey ?? "",
    model: model.trim(),
    savedAt: existing?.savedAt ?? new Date().toISOString(),
  };
  writeJson(AI_PATH, next);
  return next;
}

/** Where the key in use came from. Surfaced in the UI so it is never ambiguous. */
export type AiKeySource = "env" | "stored";

function envAiKey(): string | null {
  const key = process.env.XAI_API_KEY?.trim();
  return key ? key : null;
}

/** Set to pin the model alongside `XAI_API_KEY`; otherwise the stored choice applies. */
function envAiModel(): string | null {
  const model = process.env.XAI_MODEL?.trim();
  return model ? model : null;
}

/**
 * Decrypts into memory for one request. Never return this to the client.
 *
 * `XAI_API_KEY` wins over a stored key. The environment is the more deliberate declaration — you
 * edited a file on this machine — and letting a stale stored key silently take precedence is how
 * someone ends up billing the wrong account.
 */
export function resolveAiKey():
  | { apiKey: string; model: string; source: AiKeySource }
  | null {
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
    const stored = readAiConfig();
    return {
      apiKey: fromEnv,
      model: envAiModel() ?? stored?.model ?? FALLBACK_AI_MODEL,
      source: "env",
    };
  }

  const config = readAiConfig();
  if (!config?.apiKey) return null;
  return {
    apiKey: decryptSecret(config.apiKey),
    model: config.model,
    source: "stored",
  };
}

/** Everything the settings UI needs, without the key itself. */
export function aiKeyStatus() {
  const resolved = resolveAiKey();
  if (!resolved) return { configured: false as const };

  const stored = readAiConfig();
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

export function clearAiConfig() {
  if (isDemoMode()) throw new DemoReadOnlyError();
  writeJson(AI_PATH, null);
}

export function recordAudit(event: AuditEvent) {
  if (isDemoMode()) return;
  ensureDataDir();
  appendFileSync(AUDIT_PATH, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function readAudit(limit = 200): AuditEvent[] {
  if (isDemoMode()) return [];
  if (!existsSync(AUDIT_PATH)) return [];
  return readFileSync(AUDIT_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as AuditEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is AuditEvent => event !== null)
    .reverse();
}
