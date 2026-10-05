import type { Connection, SpyGrant, XCredentials } from "../store";
import { DEMO_ACCOUNTS } from "./universe";

/**
 * Stands in for everything the file store would hold.
 *
 * A demo deployment stores nothing. There are no credentials to encrypt, no connection to persist
 * and no `master.key` to create, which also means the app runs on a host with a read-only or
 * ephemeral filesystem without any of the writes failing. The one piece of state the UI expects to
 * be able to change — favourites — is held in memory, so it works for the length of a visit and
 * resets on restart.
 */

export const DEMO_CONNECTION: Connection = {
  consumerKey: "demo-consumer-key",
  consumerSecret: "demo",
  accessToken: "demo-access-token",
  accessTokenSecret: "demo",
  handle: "demo_sales",
  userId: "100000000000",
  displayName: "Demo Sales",
  connectedAt: "2026-01-05T16:00:00Z",
};

/**
 * Placeholders. Nothing signs a request in demo mode — `adsRequest` returns before it would build
 * an OAuth header — but `resolveCredentials()` returning null would make every route report that
 * the app is not connected.
 */
export const DEMO_CREDENTIALS: XCredentials = {
  consumerKey: "demo-consumer-key",
  consumerSecret: "demo-consumer-secret",
  accessToken: "demo-access-token",
  accessTokenSecret: "demo-access-token-secret",
};

/**
 * The accounts reached by impersonation. The first demo account is granted directly and so is
 * absent here, exactly as it would be in real use: `GET /accounts` already returns it.
 */
export const DEMO_SPY_GRANTS: SpyGrant[] = DEMO_ACCOUNTS.filter(
  (account) => account.asUser !== null,
).map((account) => ({
  accountId: account.id,
  asUser: account.asUser!,
  name: account.name,
  timezone: account.timezone,
  approvalStatus: "ACCEPTED",
  addedAt: "2026-01-05T16:04:00Z",
}));

const favorites = new Set<string>([DEMO_ACCOUNTS[0]!.id]);

export function demoFavorites(): string[] {
  return [...favorites];
}

export function demoToggleFavorite(accountId: string): string[] {
  if (favorites.has(accountId)) {
    favorites.delete(accountId);
  } else {
    favorites.add(accountId);
  }
  return [...favorites];
}
