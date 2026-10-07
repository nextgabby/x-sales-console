import type { CampaignLabel, SpyGrant, StoredUser, XCredentials } from "../store/types";
import { DEMO_ACCOUNTS, entityId } from "./universe";

/**
 * Stands in for everything the real store would hold.
 *
 * A demo deployment stores nothing. There are no credentials to encrypt, no connection to persist
 * and no key material to manage, which also means it runs on a host with a read-only or ephemeral
 * filesystem and needs no database. There is no visitor state at all: a demo link is opened by
 * several reviewers at once, and anything held server-side would be shared between all of them.
 */

export const DEMO_USER: StoredUser = {
  userId: "100000000000",
  handle: "demo_sales",
  displayName: "Demo Sales",
  avatarUrl: null,
  accessToken: "demo-access-token",
  accessTokenSecret: "demo",
  connectedAt: "2026-01-05T16:00:00Z",
};

/**
 * Placeholders. Nothing signs a request in demo mode — `adsRequest` returns before it would build an
 * OAuth header — but `resolveCredentials()` returning null would make every route report that the
 * app is not connected.
 */
export const DEMO_CREDENTIALS: XCredentials = {
  consumerKey: "demo-consumer-key",
  consumerSecret: "demo-consumer-secret",
  accessToken: "demo-access-token",
  accessTokenSecret: "demo-access-token-secret",
};

/**
 * The accounts reached by impersonation. The first demo account is granted directly and so is absent
 * here, exactly as it would be in real use: `GET /accounts` already returns it.
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

/**
 * One of the two bursty campaigns is labelled and the other is not, deliberately.
 *
 * A demo stores nothing, so a reviewer cannot set a label themselves and see what changes. Shipping
 * one of each puts both states on screen instead: Harborline's trend buy reads as intermittent by
 * design, and Lumen's notification campaign is still being reported as behind pace, which is the
 * problem the label exists to fix.
 */
export const DEMO_CAMPAIGN_LABELS: CampaignLabel[] = [
  {
    accountId: "18ce5dem0002",
    campaignId: entityId("c", "18ce5dem0002:trend-genius"),
    kind: "trend-genius",
    setBy: DEMO_USER.handle,
    setAt: "2026-01-06T09:12:00Z",
  },
];
