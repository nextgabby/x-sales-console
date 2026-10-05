import { Pool } from "pg";

/**
 * Postgres connection and schema, for the hosted multi-rep deployment.
 *
 * `DATABASE_URL` is the single switch between the two ways this app can run. Set, and every rep gets
 * their own row and the allowlist is enforced; unset, and the app stays the single-user local tool
 * it started as, storing encrypted files under `DATA_DIR`. There is deliberately no third mode and
 * no separate flag to forget to set.
 */
export function isHosted(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

let pool: Pool | null = null;

export function db(): Pool {
  if (!isHosted()) {
    throw new Error("DATABASE_URL is not set, so there is no database to query.");
  }
  if (pool) return pool;

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    /**
     * Render's managed Postgres terminates TLS with a certificate this container has no root for,
     * and the connection is inside Render's private network. Verifying would fail outright; the
     * alternative of disabling TLS entirely would be worse.
     */
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
    // A handful of reps on a small instance. The default of 10 would exhaust a starter database's
    // connection limit across more than one app instance.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  return pool;
}

/**
 * Creates the schema if it is absent.
 *
 * Idempotent DDL rather than a migration tool: there are five tables, the app owns all of them, and
 * a dependency that needs its own CLI step in the build would be more to get wrong than this is.
 * Run once per process, awaited by every caller so concurrent first requests cannot race.
 */
let ready: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (ready) return ready;

  ready = (async () => {
    const client = await db().connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          user_id             text PRIMARY KEY,
          handle              text NOT NULL,
          display_name        text,
          avatar_url          text,
          access_token        text NOT NULL,
          access_token_secret text NOT NULL,
          connected_at        timestamptz NOT NULL DEFAULT now(),
          updated_at          timestamptz NOT NULL DEFAULT now()
        );

        -- Case-insensitive, because the allowlist and every lookup compare handles that way.
        CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lower ON users (lower(handle));

        CREATE TABLE IF NOT EXISTS spy_grants (
          user_id         text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          account_id      text NOT NULL,
          as_user         text NOT NULL,
          name            text NOT NULL,
          timezone        text NOT NULL,
          approval_status text,
          added_at        timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, account_id)
        );

        CREATE TABLE IF NOT EXISTS favorites (
          user_id    text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          account_id text NOT NULL,
          PRIMARY KEY (user_id, account_id)
        );

        CREATE TABLE IF NOT EXISTS ai_config (
          user_id  text PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
          api_key  text NOT NULL,
          model    text NOT NULL,
          saved_at timestamptz NOT NULL DEFAULT now()
        );

        /*
         * Keyed by the request token rather than by rep, because leg one of OAuth happens before
         * anyone is identified. Two reps authorizing at the same moment would otherwise overwrite
         * each other's pending secret and both handshakes would fail.
         */
        CREATE TABLE IF NOT EXISTS pending_tokens (
          token        text PRIMARY KEY,
          token_secret text NOT NULL,
          created_at   timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS audit (
          id          bigserial PRIMARY KEY,
          at          timestamptz NOT NULL DEFAULT now(),
          user_id     text,
          handle      text,
          account_id  text,
          path        text NOT NULL,
          as_user     text,
          status      integer,
          duration_ms integer
        );

        CREATE INDEX IF NOT EXISTS audit_at ON audit (at DESC);
        CREATE INDEX IF NOT EXISTS audit_user ON audit (user_id, at DESC);
      `);
    } finally {
      client.release();
    }
  })();

  // A failed bootstrap must not be cached, or every later request inherits a transient outage.
  ready.catch(() => {
    ready = null;
  });

  return ready;
}

/** Abandoned handshakes are rows nobody will ever claim. Cleared opportunistically. */
export async function purgeStalePendingTokens(): Promise<void> {
  await db().query(`DELETE FROM pending_tokens WHERE created_at < now() - interval '1 hour'`);
}
