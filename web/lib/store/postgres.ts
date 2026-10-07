import { db, ensureSchema } from "../db";
import type { CampaignLabelKind, StoreBackend, StoredUser } from "./types";

/** The hosted backend. Every method bootstraps the schema first, so a cold database self-heals. */

type UserRow = {
  user_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  access_token: string;
  access_token_secret: string;
  connected_at: Date;
};

function toUser(row: UserRow): StoredUser {
  return {
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    accessToken: row.access_token,
    accessTokenSecret: row.access_token_secret,
    connectedAt: row.connected_at.toISOString(),
  };
}

async function query<T extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const result = await db().query(sql, values);
  return result.rows as T[];
}

export const postgresBackend: StoreBackend = {
  async getUser(userId) {
    const rows = await query<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [userId]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  async listUsers() {
    const rows = await query<UserRow>(`SELECT * FROM users ORDER BY connected_at`);
    return rows.map(toUser);
  },

  async putUser(user) {
    /**
     * Re-authorizing replaces the tokens but keeps the original `connected_at`, so the UI can say
     * how long a rep has had access rather than resetting the clock every time a token is refreshed.
     * The handle is updated, because people do rename themselves and the allowlist matches on it.
     */
    await query(
      `INSERT INTO users (user_id, handle, display_name, avatar_url, access_token,
                          access_token_secret, connected_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id) DO UPDATE SET
         handle = EXCLUDED.handle,
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url,
         access_token = EXCLUDED.access_token,
         access_token_secret = EXCLUDED.access_token_secret,
         updated_at = now()`,
      [
        user.userId,
        user.handle,
        user.displayName,
        user.avatarUrl,
        user.accessToken,
        user.accessTokenSecret,
        user.connectedAt,
      ],
    );
  },

  async deleteUser(userId) {
    // Grants and the AI key cascade; the audit trail deliberately does not, because a record of who
    // read whose data must outlive the access itself.
    await query(`DELETE FROM users WHERE user_id = $1`, [userId]);
  },

  async putPendingToken({ token, tokenSecret }) {
    await query(
      `INSERT INTO pending_tokens (token, token_secret) VALUES ($1, $2)
       ON CONFLICT (token) DO UPDATE SET token_secret = EXCLUDED.token_secret, created_at = now()`,
      [token, tokenSecret],
    );
  },

  async takePendingToken(token) {
    // Deleting as part of the read is what makes a replayed callback fail.
    const rows = await query<{ token: string; token_secret: string }>(
      `DELETE FROM pending_tokens WHERE token = $1 RETURNING token, token_secret`,
      [token],
    );
    const row = rows[0];
    return row ? { token: row.token, tokenSecret: row.token_secret } : null;
  },

  async listSpyGrants(userId) {
    const rows = await query<{
      account_id: string;
      as_user: string;
      name: string;
      timezone: string;
      approval_status: string | null;
      added_at: Date;
    }>(
      `SELECT * FROM spy_grants WHERE user_id = $1 ORDER BY lower(as_user), lower(name)`,
      [userId],
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      asUser: row.as_user,
      name: row.name,
      timezone: row.timezone,
      approvalStatus: row.approval_status,
      addedAt: row.added_at.toISOString(),
    }));
  },

  async putSpyGrants(userId, grants) {
    for (const grant of grants) {
      await query(
        `INSERT INTO spy_grants (user_id, account_id, as_user, name, timezone, approval_status, added_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, account_id) DO UPDATE SET
           as_user = EXCLUDED.as_user,
           name = EXCLUDED.name,
           timezone = EXCLUDED.timezone,
           approval_status = EXCLUDED.approval_status`,
        [
          userId,
          grant.accountId,
          grant.asUser,
          grant.name,
          grant.timezone,
          grant.approvalStatus,
          grant.addedAt,
        ],
      );
    }
  },

  async deleteSpyGrant(userId, accountId) {
    await query(`DELETE FROM spy_grants WHERE user_id = $1 AND account_id = $2`, [
      userId,
      accountId,
    ]);
  },

  async deleteSpyGrantsByHandle(userId, asUser) {
    await query(`DELETE FROM spy_grants WHERE user_id = $1 AND lower(as_user) = lower($2)`, [
      userId,
      asUser,
    ]);
  },

  async getAiConfig(userId) {
    const rows = await query<{ api_key: string; model: string; saved_at: Date }>(
      `SELECT api_key, model, saved_at FROM ai_config WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    return row
      ? { apiKey: row.api_key, model: row.model, savedAt: row.saved_at.toISOString() }
      : null;
  },

  async putAiConfig(userId, config) {
    await query(
      `INSERT INTO ai_config (user_id, api_key, model, saved_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         api_key = EXCLUDED.api_key, model = EXCLUDED.model, saved_at = EXCLUDED.saved_at`,
      [userId, config.apiKey, config.model, config.savedAt],
    );
  },

  async deleteAiConfig(userId) {
    await query(`DELETE FROM ai_config WHERE user_id = $1`, [userId]);
  },

  async listCampaignLabels(accountId) {
    const rows = await query<{
      account_id: string;
      campaign_id: string;
      kind: string;
      set_by: string | null;
      set_at: Date;
    }>(`SELECT * FROM campaign_labels WHERE account_id = $1`, [accountId]);
    return rows.map((row) => ({
      accountId: row.account_id,
      campaignId: row.campaign_id,
      kind: row.kind as CampaignLabelKind,
      setBy: row.set_by,
      setAt: row.set_at.toISOString(),
    }));
  },

  async putCampaignLabel(label) {
    await query(
      `INSERT INTO campaign_labels (account_id, campaign_id, kind, set_by, set_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, campaign_id) DO UPDATE SET
         kind = EXCLUDED.kind, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
      [label.accountId, label.campaignId, label.kind, label.setBy, label.setAt],
    );
  },

  async deleteCampaignLabel(accountId, campaignId) {
    await query(`DELETE FROM campaign_labels WHERE account_id = $1 AND campaign_id = $2`, [
      accountId,
      campaignId,
    ]);
  },

  async appendAudit(event) {
    await query(
      `INSERT INTO audit (at, user_id, handle, account_id, path, as_user, status, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.at,
        event.userId,
        event.handle,
        event.accountId,
        event.path,
        event.asUser,
        event.status,
        event.durationMs,
      ],
    );
  },

  async readAudit({ userId, limit }) {
    const rows = await query<{
      at: Date;
      user_id: string | null;
      handle: string | null;
      account_id: string | null;
      path: string;
      as_user: string | null;
      status: number | null;
      duration_ms: number | null;
    }>(
      userId
        ? `SELECT * FROM audit WHERE user_id = $2 ORDER BY at DESC LIMIT $1`
        : `SELECT * FROM audit ORDER BY at DESC LIMIT $1`,
      userId ? [limit, userId] : [limit],
    );
    return rows.map((row) => ({
      at: row.at.toISOString(),
      userId: row.user_id,
      handle: row.handle,
      accountId: row.account_id,
      path: row.path,
      asUser: row.as_user,
      status: row.status,
      durationMs: row.duration_ms ?? 0,
    }));
  },
};
