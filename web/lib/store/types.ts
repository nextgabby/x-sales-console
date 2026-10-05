/**
 * The storage contract, shared by the file backend and the Postgres one.
 *
 * Everything is keyed by the rep's X user id, including in local single-user mode. Carrying the key
 * through even when there is only ever one user means the two backends implement exactly the same
 * interface, and nothing above this layer has to know which deployment it is running in — the
 * difference stays in one `if` in `index.ts` rather than spreading through seventeen routes.
 *
 * Secrets arrive already encrypted and leave still encrypted. A backend stores bytes; deciding what
 * is sensitive is the facade's job, so a new backend cannot accidentally be the place where a token
 * gets written in the clear.
 */

export type XCredentials = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

/**
 * The developer app's own keys. Identifies the application, not a person, so it is not user-scoped.
 * Only the file backend persists these; see `readStoredAppKeys`.
 */
export type AppKeys = {
  consumerKey: string;
  /** Encrypted at rest. */
  consumerSecret: string;
  savedAt: string;
};

export type StoredUser = {
  userId: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Encrypted at rest. */
  accessToken: string;
  /** Encrypted at rest. */
  accessTokenSecret: string;
  connectedAt: string;
};

export type SpyGrant = {
  accountId: string;
  /** The handle to send as `x-as-user` when reaching this account. */
  asUser: string;
  name: string;
  timezone: string;
  approvalStatus: string | null;
  addedAt: string;
};

export type AiConfig = {
  /** Encrypted at rest, exactly like the X secrets. */
  apiKey: string;
  model: string;
  savedAt: string;
};

export type AuditEvent = {
  at: string;
  userId: string | null;
  handle: string | null;
  accountId: string | null;
  path: string;
  asUser: string | null;
  status: number | null;
  durationMs: number;
};

export type PendingToken = { token: string; tokenSecret: string };

export type StoreBackend = {
  getUser(userId: string): Promise<StoredUser | null>;
  /** Used by the local single-user fallback, and by nothing else. */
  listUsers(): Promise<StoredUser[]>;
  putUser(user: StoredUser): Promise<void>;
  deleteUser(userId: string): Promise<void>;

  /**
   * Keyed by the request token, not by rep: leg one of the handshake happens before anyone is
   * identified, and two reps authorizing at the same moment must not overwrite each other.
   */
  putPendingToken(token: PendingToken): Promise<void>;
  takePendingToken(token: string): Promise<PendingToken | null>;

  listFavorites(userId: string): Promise<string[]>;
  putFavorites(userId: string, accountIds: string[]): Promise<void>;

  listSpyGrants(userId: string): Promise<SpyGrant[]>;
  putSpyGrants(userId: string, grants: SpyGrant[]): Promise<void>;
  deleteSpyGrant(userId: string, accountId: string): Promise<void>;
  deleteSpyGrantsByHandle(userId: string, asUser: string): Promise<void>;

  getAiConfig(userId: string): Promise<AiConfig | null>;
  putAiConfig(userId: string, config: AiConfig): Promise<void>;
  deleteAiConfig(userId: string): Promise<void>;

  appendAudit(event: AuditEvent): Promise<void>;
  readAudit(options: { userId?: string; limit: number }): Promise<AuditEvent[]>;
};
