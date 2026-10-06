/**
 * Seeds two reps and prints a signed session cookie for each, for `verify-hosted.sh`.
 *
 * A real sign-in needs X, which a test cannot have, so the stored half is created through the app's
 * own `saveUser` and the cookie is minted here. The cookie format is the only thing reimplemented;
 * if it were wrong the server would reject it and every assertion downstream would fail, so the
 * tests still prove the server's own verification rather than agreeing with themselves.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/hosted-fixture.mjs
 */
import { createHmac } from "node:crypto";

import { ensureSchema } from "../lib/db.ts";
import { saveSpyGrants, saveUser } from "../lib/store/index.ts";

/**
 * Alice's, so the suite has per-rep data to check the scoping of over http. Seeded here rather than
 * posted to `/api/spy`, which verifies each account against the Ads API and so cannot write anything
 * while the suite points that base at a dead port.
 */
const ALICE_GRANT = {
  accountId: "18ce0000777",
  asUser: "harborline",
  name: "Harborline Travel",
  timezone: "America/Los_Angeles",
  approvalStatus: "ACCEPTED",
};

const REPS = [
  { userId: "111111111111", handle: "alice_sales", displayName: "Alice Sales" },
  { userId: "222222222222", handle: "bob_sales", displayName: "Bob Sales" },
];

function cookieFor(userId) {
  const signature = createHmac("sha256", process.env.SESSION_SECRET)
    .update(userId)
    .digest("base64url");
  return `${Buffer.from(userId).toString("base64url")}.${signature}`;
}

await ensureSchema();

const lines = [];
for (const rep of REPS) {
  await saveUser({
    ...rep,
    accessToken: `${rep.handle}-token`,
    accessTokenSecret: `${rep.handle}-secret`,
  });
  lines.push(`${rep.handle} ${rep.userId} ${cookieFor(rep.userId)}`);
}

await saveSpyGrants(REPS[0].userId, [{ ...ALICE_GRANT, addedAt: new Date().toISOString() }]);

// Last, so a tampered cookie can be tested against a well-formed one.
lines.push(`forged 999999999999 ${Buffer.from("111111111111").toString("base64url")}.notavalidsignature`);

console.log(lines.join("\n"));
process.exit(0);
