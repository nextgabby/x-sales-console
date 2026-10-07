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

/**
 * How a campaign is bought, in the cases the Ads API cannot express.
 *
 * None of these is identifiable from the API. A live Trend Genius campaign comes back as
 * `PROMOTED_TWEETS` / `REACH` / `ALL_ON_TWITTER`, indistinguishable from an ordinary reach buy, and
 * the custom units Creative Strategy builds are not named anywhere in the API at all — not in the
 * campaign, the line item or the card type. Advertisers sometimes say so in the campaign name and
 * often do not, so a rep says so instead.
 *
 * The kinds answer two unrelated questions, which is why `isBursty` exists rather than every label
 * behaving alike:
 *
 * - `trend-genius` is about **delivery**. It fires when a matching trend does, so it delivers in
 *   bursts and the pacing verdict reads it as behind, or stopped, when it is doing exactly what it
 *   was sold to do.
 * - `l4r` and `custom` are about **creative**. They deliver continuously like any other campaign,
 *   so they must pace normally; what they change is the comparison. The question they exist to
 *   answer is whether a custom unit beats the brand's regular buys on the same objective, which
 *   means holding the brand's other custom campaigns out of the baseline.
 */
export type CampaignLabelKind = "trend-genius" | "l4r" | "custom";

/** Labels that mean the campaign delivers in bursts, and so must not be paced against a daily rate. */
export function isBursty(kind: CampaignLabelKind | null): boolean {
  return kind === "trend-genius";
}

/** Labels that mark a Creative Strategy buy, whose baseline is the brand's standard campaigns. */
export function isCustomCreative(kind: CampaignLabelKind | null): boolean {
  return kind === "l4r" || kind === "custom";
}

/**
 * Reads a kind back out of storage, which is where a retired label can still turn up.
 *
 * `notification` was the original second label, for subscription-notification buys, and it
 * suppressed the pacing alarm the way `trend-genius` does. It was replaced because the thing worth
 * recording about those campaigns turned out to be the custom unit they are built on rather than
 * their delivery: they do not actually switch on and off, so they should pace like anything else.
 * L4R is the mechanic behind them, so that is where stored rows land. Anything unrecognised is
 * dropped rather than guessed at, so a label written by a newer version of the app cannot make an
 * older one report a verdict it does not understand.
 */
export function parseCampaignLabelKind(raw: string): CampaignLabelKind | null {
  if (raw === "trend-genius" || raw === "l4r" || raw === "custom") return raw;
  if (raw === "notification") return "l4r";
  return null;
}

export type CampaignLabel = {
  accountId: string;
  campaignId: string;
  kind: CampaignLabelKind;
  /** The rep who set it, so a surprising label can be asked about rather than just overridden. */
  setBy: string | null;
  setAt: string;
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

  listSpyGrants(userId: string): Promise<SpyGrant[]>;
  putSpyGrants(userId: string, grants: SpyGrant[]): Promise<void>;
  deleteSpyGrant(userId: string, accountId: string): Promise<void>;
  deleteSpyGrantsByHandle(userId: string, asUser: string): Promise<void>;

  getAiConfig(userId: string): Promise<AiConfig | null>;
  putAiConfig(userId: string, config: AiConfig): Promise<void>;
  deleteAiConfig(userId: string): Promise<void>;

  /**
   * Keyed by ad account, not by rep — the only thing on this interface that is, which is why it is
   * called out here. How a campaign is bought is a fact about the campaign, not one rep's opinion
   * of it, so one rep labelling a Trend Genius buy fixes the pacing verdict for everyone looking at
   * that advertiser. The alternative, per-rep labels, means every rep re-labelling the same
   * campaigns and a verdict that differs depending on who is looking at it.
   */
  listCampaignLabels(accountId: string): Promise<CampaignLabel[]>;
  putCampaignLabel(label: CampaignLabel): Promise<void>;
  deleteCampaignLabel(accountId: string, campaignId: string): Promise<void>;

  appendAudit(event: AuditEvent): Promise<void>;
  readAudit(options: { userId?: string; limit: number }): Promise<AuditEvent[]>;
};
