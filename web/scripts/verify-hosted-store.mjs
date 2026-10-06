/**
 * Exercises the hosted storage layer against a real Postgres.
 *
 * Run through `verify-hosted.sh`, which supplies the database and the keys. This half covers what
 * HTTP cannot reach without a genuine OAuth handshake: that two reps' data stays apart, that
 * secrets are unreadable in the table, and that a request token cannot be replayed.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/verify-hosted-store.mjs
 */
import { Pool } from "pg";

import { ensureSchema, isHosted } from "../lib/db.ts";
import {
  aiKeyStatus,
  clearAiConfig,
  deleteUser,
  getUser,
  listUsers,
  readAudit,
  readSpyGrants,
  recordAudit,
  resolveCredentials,
  saveAiConfig,
  savePendingRequestToken,
  saveSpyGrants,
  saveUser,
  takePendingRequestToken,
} from "../lib/store/index.ts";
import { checkHandle, allowedHandles } from "../lib/auth/allowlist.ts";

/**
 * The fixtures the assertions below are written against, pinned here rather than inherited.
 *
 * Both are read at call time, not import time, so setting them here is enough. A developer who has
 * sourced their own `.env.local` would otherwise fail the allowlist and xAI checks for reasons that
 * have nothing to do with the code under test.
 */
process.env.ALLOWED_HANDLES = "alice_sales, @BOB_SALES";
process.env.XAI_API_KEY = "";
// Hosted mode refuses to invent one, deliberately, so the suite has to bring its own. A fixed
// value rather than a random one keeps a failure reproducible from the output alone.
process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
/**
 * Pinned for the same reason, and found the hard way: without these `resolveCredentials` returns
 * null before it ever decrypts anything, so the round-trip assertion failed in a clean shell and
 * passed in one that happened to have a developer's app keys exported.
 */
process.env.X_CONSUMER_KEY = "verify-store-consumer-key";
process.env.X_CONSUMER_SECRET = "verify-store-consumer-secret";

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ""}`);
    fail += 1;
  }
}

const ALICE = "111111111111";
const BOB = "222222222222";

console.log("== mode ==");
check("DATABASE_URL puts the app in hosted mode", isHosted());

await ensureSchema();
// Twice, because every backend method calls it: a second run must not error on existing tables.
await ensureSchema();
check("schema bootstrap is idempotent", true);

console.log("== two reps stay separate ==");
await saveUser({
  userId: ALICE,
  handle: "alice_sales",
  accessToken: "alice-token",
  accessTokenSecret: "alice-secret",
  displayName: "Alice",
});
await saveUser({
  userId: BOB,
  handle: "bob_sales",
  accessToken: "bob-token",
  accessTokenSecret: "bob-secret",
  displayName: "Bob",
});

check("both users are stored", (await listUsers()).length === 2);
check("a user reads back under their own id", (await getUser(ALICE))?.handle === "alice_sales");

await saveSpyGrants(ALICE, [
  {
    accountId: "18ce0000001",
    asUser: "advertiser_a",
    name: "Advertiser A",
    timezone: "America/Los_Angeles",
    approvalStatus: "ACCEPTED",
    addedAt: new Date().toISOString(),
  },
]);
const aliceGrants = await readSpyGrants(ALICE);
const bobGrants = await readSpyGrants(BOB);
check("a spy grant round-trips with its fields intact", aliceGrants[0]?.timezone === "America/Los_Angeles");
check("one rep's spy grants are invisible to another", bobGrants.length === 0, JSON.stringify(bobGrants));

await saveAiConfig(ALICE, "xai-test-key-aaaaaaaaaaaaaaaa", "grok-4");
const bobAi = await aiKeyStatus(BOB);
check("an xAI key is not shared between reps", bobAi.configured === false, JSON.stringify(bobAi));
await clearAiConfig(ALICE);

console.log("== secrets at rest ==");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const raw = await pool.query("select access_token_secret from users where user_id = $1", [ALICE]);
const stored = raw.rows[0].access_token_secret;
check("the token secret is not in the table in the clear", !stored.includes("alice-secret"), stored.slice(0, 24));

const resolved = await resolveCredentials(ALICE);
check(
  "it still decrypts to the original",
  resolved?.accessTokenSecret === "alice-secret",
  resolved?.accessTokenSecret,
);
check(
  "resolved credentials carry the app's consumer key",
  resolved?.consumerKey === process.env.X_CONSUMER_KEY,
);

console.log("== the oauth handshake ==");
await savePendingRequestToken("req-token-1", "req-secret-1");
const taken = await takePendingRequestToken("req-token-1");
const replay = await takePendingRequestToken("req-token-1");
check("a request token resolves once", taken?.tokenSecret === "req-secret-1");
check("and cannot be replayed", replay === null);

// Two handshakes in flight at once is the normal case on a shared deployment, not an edge case.
await savePendingRequestToken("req-a", "secret-a");
await savePendingRequestToken("req-b", "secret-b");
const a = await takePendingRequestToken("req-a");
const b = await takePendingRequestToken("req-b");
check(
  "concurrent handshakes do not overwrite each other",
  a?.tokenSecret === "secret-a" && b?.tokenSecret === "secret-b",
);

console.log("== the allowlist ==");
check("ALLOWED_HANDLES parses", allowedHandles().join(",") === "alice_sales,bob_sales", allowedHandles().join(","));
check("a listed handle is allowed", checkHandle("alice_sales").allowed === true);
check("an @ prefix and case are ignored", checkHandle("@Alice_Sales").allowed === true);
const stranger = checkHandle("someone_else");
check("an unlisted handle is refused", stranger.allowed === false && stranger.reason === "not-listed");

console.log("== the audit trail ==");
recordAudit({
  at: new Date().toISOString(),
  userId: ALICE,
  handle: "alice_sales",
  accountId: "18ce0000001",
  path: "/accounts/18ce0000001/campaigns",
  asUser: "advertiser_a",
  status: 200,
  durationMs: 42,
});
// Fire-and-forget by design, so the write is not ordered against this read.
await new Promise((resolve) => setTimeout(resolve, 300));
const aliceAudit = await readAudit({ userId: ALICE, limit: 10 });
const bobAudit = await readAudit({ userId: BOB, limit: 10 });
check("the audit row is attributed to the rep", aliceAudit[0]?.userId === ALICE, JSON.stringify(aliceAudit[0]));
check("and does not appear under another rep", bobAudit.length === 0);

console.log("== removing a rep ==");
await deleteUser(ALICE);
check("the user record is gone", (await getUser(ALICE)) === null);
check("their advertisers went with it", (await readSpyGrants(ALICE)).length === 0);
// Deliberately not cascaded: who looked at which advertiser has to outlive their access.
const auditAfter = await readAudit({ userId: ALICE, limit: 10 });
check("but the audit trail survives them", auditAfter.length === 1, `${auditAfter.length} rows`);

await pool.end();
console.log(`\npassed: ${pass}  failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
