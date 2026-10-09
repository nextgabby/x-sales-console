/**
 * Checks the local single-user mode, including the move off the pre-sessions layout.
 *
 * Run through `verify-local.sh`, which points DATA_DIR at a throwaway copy of a real installation.
 * The thing being proved is that someone who was already using the console locally keeps their
 * authorization and their advertisers — a silent reset there would look exactly like data loss.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/verify-local.mjs
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { isHosted } from "../lib/db.ts";
import { accessStateFor } from "../lib/x/accounts.ts";
import {
  consumerCredentials,
  listUsers,
  readSpyGrants,
  resolveCredentials,
} from "../lib/store/index.ts";

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

const DATA_DIR = process.env.DATA_DIR;
const expected = JSON.parse(process.env.EXPECTED_LEGACY ?? "{}");

console.log("== mode ==");
check("no DATABASE_URL means local mode", !isHosted());

console.log("== the pre-sessions layout is carried over ==");
const users = await listUsers();
check("the existing connection is found", users.length === 1, `${users.length} users`);

const user = users[0];
check("under the same X user id", user?.userId === expected.userId, user?.userId);
check("with the same handle", user?.handle === expected.handle, user?.handle);

const credentials = await resolveCredentials(user.userId);
check(
  "the access token still decrypts",
  Boolean(credentials?.accessToken && credentials.accessTokenSecret),
);
check(
  "the app's own keys came across too, so no re-pasting",
  (await consumerCredentials())?.key === expected.consumerKey,
);
check(
  "and they are the pair the token was authorized with",
  credentials?.consumerKey === expected.consumerKey,
);

const grants = await readSpyGrants(user.userId);
check(
  "every advertiser they had added is still there",
  grants.length === expected.spyGrantCount,
  `${grants.length} of ${expected.spyGrantCount}`,
);
check(
  "with their handles intact",
  grants.every((grant) => grant.asUser && grant.accountId && grant.timezone),
);

/*
 * The campaigns call 403s the same way whether a spy grant lapsed or the rep's role is too low, and
 * the two get opposite advice, so the rule that separates them is worth pinning. The permission
 * values are the ones a real account returns: `[]` from a lapsed grant, `["ACCOUNT_ADMIN"]` from a
 * working one.
 */
console.log("== a 403 is read for which kind of 403 it is ==");
check(
  "a readable account is ok whatever its roles say",
  accessStateFor({ accessible: true, campaignsDenied: false, permissions: [] }) === "ok",
);
check(
  "a refusal with no role at all is a lapsed grant",
  accessStateFor({ accessible: false, campaignsDenied: true, permissions: [] }) === "denied",
);
check(
  "a refusal while X still names a role is the role, not the grant",
  accessStateFor({
    accessible: false,
    campaignsDenied: true,
    permissions: ["ORGANIC_ANALYST"],
  }) === "role",
);
check(
  "a failure that was not a refusal blames neither",
  accessStateFor({ accessible: false, campaignsDenied: false, permissions: ["ACCOUNT_ADMIN"] }) ===
    "unavailable",
);

console.log("== it does not run twice ==");
check("a marker records that the move happened", existsSync(join(DATA_DIR, ".migrated")));
// The originals are left alone deliberately, so a mistake here is recoverable by hand.
check("the legacy files are left in place", existsSync(join(DATA_DIR, "connection.json")));

console.log(`\npassed: ${pass}  failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
