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
 * The labels a rep is imagined to have already set, since a demo stores nothing and a reviewer
 * cannot set one themselves and watch what changes.
 *
 * Both of the bursty campaigns are shipped, one labelled and one not, so both states are on screen:
 * Harborline's trend buy reads as intermittent by design, and Lumen's "Live Moments" is still
 * reported as a campaign that stopped delivering, which is the problem the label exists to fix.
 *
 * Lumen carries two of each custom label, which is the smallest number that shows both comparisons
 * at once. Reviewing an L4R holds all four custom campaigns out of the standard baseline and then
 * gathers the *one other L4R* into a second baseline of its own — so the row shows how the unit did
 * against the brand's regular buys and against its own format, which a single custom campaign per
 * label could not demonstrate.
 */
export const DEMO_CAMPAIGN_LABELS: CampaignLabel[] = [
  {
    accountId: "18ce5dem0002",
    campaignId: entityId("c", "18ce5dem0002:trend-genius"),
    kind: "trend-genius",
    setBy: DEMO_USER.handle,
    setAt: "2026-01-06T09:12:00Z",
  },
  {
    accountId: "18ce5dem0001",
    campaignId: entityId("c", "18ce5dem0001:l4r-drop"),
    kind: "l4r",
    setBy: DEMO_USER.handle,
    setAt: "2026-01-06T09:14:00Z",
  },
  {
    accountId: "18ce5dem0001",
    campaignId: entityId("c", "18ce5dem0001:l4r-restock"),
    kind: "l4r",
    setBy: DEMO_USER.handle,
    setAt: "2026-01-06T09:14:30Z",
  },
  {
    accountId: "18ce5dem0001",
    campaignId: entityId("c", "18ce5dem0001:custom-thread"),
    kind: "custom",
    setBy: DEMO_USER.handle,
    setAt: "2026-01-06T09:15:00Z",
  },
  {
    accountId: "18ce5dem0001",
    campaignId: entityId("c", "18ce5dem0001:custom-poll"),
    kind: "custom",
    setBy: DEMO_USER.handle,
    setAt: "2026-01-06T09:15:30Z",
  },
];
