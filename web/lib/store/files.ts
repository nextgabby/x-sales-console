import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../paths";
import { parseCampaignLabelKind } from "./types";
import type {
  AiConfig,
  AppKeys,
  AuditEvent,
  CampaignLabel,
  PendingToken,
  SpyGrant,
  StoreBackend,
  StoredUser,
} from "./types";

/**
 * The local backend: encrypted JSON under `DATA_DIR`, one directory per rep.
 *
 * Synchronous I/O behind an async interface, which is the right trade here. These files are a few
 * hundred bytes on local disk, the process serves one person, and sync writes are atomic enough that
 * a crash mid-write cannot interleave two records. The async signature exists for Postgres.
 */

const USERS_DIR = join(DATA_DIR, "users");
const PENDING_DIR = join(DATA_DIR, "pending");
const AUDIT_PATH = join(DATA_DIR, "audit.jsonl");
const LABELS_PATH = join(DATA_DIR, "campaign-labels.json");

/**
 * User ids come from X and are numeric, but they end up in a filesystem path, so they are checked
 * rather than trusted. A traversal here would let a crafted id read or overwrite files outside the
 * data directory.
 */
function userDir(userId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
    throw new Error(`Refusing to use ${userId} as a directory name.`);
  }
  return join(USERS_DIR, userId);
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
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
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function userFile(userId: string, name: string): string {
  return join(userDir(userId), name);
}

/* ------------------------------------------------------------------- the pre-sessions layout */

/**
 * Moves a single-user installation into the per-user layout.
 *
 * Before sessions existed there was one connection per machine, stored flat in `DATA_DIR`. Anyone
 * who had been using the local tool has real data in that shape: their authorization and their spy
 * grants. Without this they would open the console to a setup wizard, with the
 * advertisers they had added apparently gone — and would have to find their own app's keys again to
 * get back in.
 *
 * The encrypted values move across verbatim, which is safe because local installs have no
 * `ENCRYPTION_KEY` and so still decrypt with the same `master.key` sitting beside them.
 *
 * Copies rather than deletes: if this turns out to have got something wrong, the originals are still
 * there to look at. A `.migrated` marker stops it running twice, so a later edit in the new layout
 * cannot be overwritten by stale legacy files.
 */
type LegacyConnection = {
  userId?: string;
  handle?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  consumerKey?: string;
  consumerSecret?: string;
  accessToken?: string;
  accessTokenSecret?: string;
  connectedAt?: string;
};

const LEGACY_MARKER = join(DATA_DIR, ".migrated");
let migrated = false;

function migrateLegacyLayout() {
  if (migrated) return;
  migrated = true;
  if (existsSync(LEGACY_MARKER)) return;

  const legacyPath = join(DATA_DIR, "connection.json");
  const legacy = readJson<LegacyConnection | null>(legacyPath, null);
  if (!legacy?.userId || !legacy.accessToken || !legacy.accessTokenSecret) return;

  const dir = userDir(legacy.userId);
  ensureDir(dir);

  writeJson(join(dir, "connection.json"), {
    userId: legacy.userId,
    handle: legacy.handle ?? "",
    displayName: legacy.displayName ?? null,
    avatarUrl: legacy.avatarUrl ?? null,
    accessToken: legacy.accessToken,
    accessTokenSecret: legacy.accessTokenSecret,
    connectedAt: legacy.connectedAt ?? new Date().toISOString(),
  } satisfies StoredUser);

  // The app's own keys were part of the connection record; they are machine-wide now.
  if (legacy.consumerKey && legacy.consumerSecret && !existsSync(APP_KEYS_PATH)) {
    writeStoredAppKeys({
      consumerKey: legacy.consumerKey,
      consumerSecret: legacy.consumerSecret,
      savedAt: legacy.connectedAt ?? new Date().toISOString(),
    });
  }

  for (const name of ["spy-handles.json", "ai.json"]) {
    const from = join(DATA_DIR, name);
    if (!existsSync(from) || existsSync(join(dir, name))) continue;
    // Parsed rather than copied, so a file holding `null` does not become a confusing read later.
    const value = readJson<unknown>(from, null);
    if (value !== null) writeJson(join(dir, name), value);
  }

  writeFileSync(LEGACY_MARKER, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export const fileBackend: StoreBackend = {
  async getUser(userId) {
    migrateLegacyLayout();
    return readJson<StoredUser | null>(userFile(userId, "connection.json"), null);
  },

  async listUsers() {
    // Also here, because the local single-user fallback reaches this before it knows any user id.
    migrateLegacyLayout();
    if (!existsSync(USERS_DIR)) return [];
    return readdirSync(USERS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJson<StoredUser | null>(userFile(entry.name, "connection.json"), null))
      .filter((user): user is StoredUser => user !== null)
      .sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
  },

  async putUser(user) {
    ensureDir(userDir(user.userId));
    const existing = await fileBackend.getUser(user.userId);
    // Re-authorizing keeps the original connection date, matching the Postgres backend.
    writeJson(userFile(user.userId, "connection.json"), {
      ...user,
      connectedAt: existing?.connectedAt ?? user.connectedAt,
    });
  },

  async deleteUser(userId) {
    rmSync(userDir(userId), { recursive: true, force: true });
  },

  async putPendingToken({ token, tokenSecret }) {
    ensureDir(PENDING_DIR);
    writeJson(join(PENDING_DIR, `${pendingName(token)}.json`), { token, tokenSecret });
  },

  async takePendingToken(token) {
    const path = join(PENDING_DIR, `${pendingName(token)}.json`);
    const pending = readJson<PendingToken | null>(path, null);
    // Removed as part of the read, so a replayed callback finds nothing.
    rmSync(path, { force: true });
    return pending && pending.token === token ? pending : null;
  },

  async listSpyGrants(userId) {
    return readJson<SpyGrant[]>(userFile(userId, "spy-handles.json"), []);
  },

  async putSpyGrants(userId, grants) {
    ensureDir(userDir(userId));
    const byId = new Map((await fileBackend.listSpyGrants(userId)).map((g) => [g.accountId, g]));
    for (const grant of grants) byId.set(grant.accountId, grant);
    writeJson(
      userFile(userId, "spy-handles.json"),
      [...byId.values()].sort(
        (a, b) => a.asUser.localeCompare(b.asUser) || a.name.localeCompare(b.name),
      ),
    );
  },

  async deleteSpyGrant(userId, accountId) {
    const next = (await fileBackend.listSpyGrants(userId)).filter(
      (grant) => grant.accountId !== accountId,
    );
    writeJson(userFile(userId, "spy-handles.json"), next);
  },

  async deleteSpyGrantsByHandle(userId, asUser) {
    const target = asUser.toLowerCase();
    const next = (await fileBackend.listSpyGrants(userId)).filter(
      (grant) => grant.asUser.toLowerCase() !== target,
    );
    writeJson(userFile(userId, "spy-handles.json"), next);
  },

  async getAiConfig(userId) {
    return readJson<AiConfig | null>(userFile(userId, "ai.json"), null);
  },

  async putAiConfig(userId, config) {
    ensureDir(userDir(userId));
    writeJson(userFile(userId, "ai.json"), config);
  },

  async deleteAiConfig(userId) {
    rmSync(userFile(userId, "ai.json"), { force: true });
  },

  /**
   * Machine-wide rather than under a user directory, matching `app-keys.json`: these describe the
   * advertiser's buy, not the rep. In local mode there is only ever one rep anyway, so the
   * distinction costs nothing here and keeps the file in the same shape the hosted table is in.
   */
  async listCampaignLabels(accountId) {
    return readJson<CampaignLabel[]>(LABELS_PATH, [])
      .filter((label) => label.accountId === accountId)
      .flatMap((label) => {
        // A retired or unknown kind is dropped rather than carried as a label nothing handles.
        const kind = parseCampaignLabelKind(label.kind);
        return kind ? [{ ...label, kind }] : [];
      });
  },

  async putCampaignLabel(label) {
    ensureDir(DATA_DIR);
    const all = readJson<CampaignLabel[]>(LABELS_PATH, []).filter(
      (existing) =>
        existing.accountId !== label.accountId || existing.campaignId !== label.campaignId,
    );
    writeJson(LABELS_PATH, [...all, label]);
  },

  async deleteCampaignLabel(accountId, campaignId) {
    const all = readJson<CampaignLabel[]>(LABELS_PATH, []).filter(
      (label) => label.accountId !== accountId || label.campaignId !== campaignId,
    );
    writeJson(LABELS_PATH, all);
  },

  async appendAudit(event) {
    ensureDir(DATA_DIR);
    appendFileSync(AUDIT_PATH, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  },

  async readAudit({ userId, limit }) {
    if (!existsSync(AUDIT_PATH)) return [];
    const events = readFileSync(AUDIT_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is AuditEvent => event !== null)
      .filter((event) => !userId || event.userId === userId);
    // Filtered before slicing, or a busy rep's entries would push a quiet one's out of the window.
    return events.slice(-limit).reverse();
  },
};

/** Request tokens are opaque strings from X; hashing avoids assuming they are path-safe. */
function pendingName(token: string): string {
  return Buffer.from(token).toString("base64url");
}

/* ------------------------------------------------------- the app's own keys, local mode only */

/**
 * Consumer keys pasted into the setup wizard, stored once for the machine rather than per user.
 *
 * Local only, and not part of `StoreBackend` for that reason: the hosted build takes these from the
 * environment, so there is nothing for Postgres to implement. Kept because every rep running the
 * launcher has their own developer app, and the launcher's whole purpose is that they never open a
 * terminal or edit a dotfile to use it.
 */
const APP_KEYS_PATH = join(DATA_DIR, "app-keys.json");

export function readStoredAppKeys(): AppKeys | null {
  return readJson<AppKeys | null>(APP_KEYS_PATH, null);
}

export function writeStoredAppKeys(keys: AppKeys) {
  ensureDir(DATA_DIR);
  writeJson(APP_KEYS_PATH, keys);
}

export function deleteStoredAppKeys() {
  rmSync(APP_KEYS_PATH, { force: true });
}
