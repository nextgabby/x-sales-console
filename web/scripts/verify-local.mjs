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
import { buildSetupCheck, UNCHECKABLE } from "../lib/x/setup-check.ts";
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

console.log("== the setup checklist judges settings, not the advertiser ==");
// A base campaign that follows both playbooks. Each case below changes one thing, so a verdict
// that moves can only have come from the setting that moved.
const playbookLineItem = {
  id: "li1",
  name: "Ad group 1",
  audienceExpansion: "EXPANDED",
  bidStrategy: "AUTO",
  payBy: "IMPRESSION",
  placements: ["ALL_ON_TWITTER"],
  standardDelivery: true,
  frequencyCap: null,
  targetCpa: null,
  webEventTag: "tag1",
  dailyBudget: 500,
  // Midnight in New York on this date, which is EDT. Writing 05:00Z would be EST and land at 01:00.
  startTime: "2026-09-01T04:00:00Z",
  updatedAt: "2026-09-01T04:00:00Z",
};
const setupInput = (overrides = {}) => ({
  objective: "WEBSITE_CLICKS",
  campaignFrequencyCap: null,
  campaignDailyBudget: 500,
  lineItems: [playbookLineItem],
  targeting: { status: "ok", groups: [], lineItems: 1 },
  copy: ["Book a demo and see the difference."],
  objectiveSiblings: 0,
  timeZone: "America/New_York",
  ...overrides,
});
const statusOf = (input, id) =>
  buildSetupCheck(input).findings.find((finding) => finding.id === id)?.status;

check("a compliant campaign fails nothing", buildSetupCheck(setupInput()).counts.fail === 0);
check(
  "optimized targeting left off is a failure",
  statusOf(
    setupInput({ lineItems: [{ ...playbookLineItem, audienceExpansion: "DEFINED" }] }),
    "optimize-targeting",
  ) === "fail",
);
check(
  "accelerated delivery is a failure",
  statusOf(
    setupInput({ lineItems: [{ ...playbookLineItem, standardDelivery: false }] }),
    "standard-pacing",
  ) === "fail",
);
check(
  "a manual bid is a judgement call, not a failure",
  statusOf(setupInput({ lineItems: [{ ...playbookLineItem, bidStrategy: "MAX" }] }), "autobid") ===
    "review",
);
check(
  "an age restriction is never a failure, because it may be the law",
  statusOf(
    setupInput({
      targeting: {
        status: "ok",
        lineItems: 1,
        groups: [
          {
            type: "AGE",
            included: [{ label: "21 and over", lineItemIds: ["li1"], everywhere: true }],
            excluded: [],
          },
        ],
      },
    }),
    "all-ages",
  ) === "review",
);
check(
  "midnight is read in the account's zone, not the viewer's",
  statusOf(setupInput(), "midnight-start") === "pass" &&
    statusOf(setupInput({ timeZone: "Europe/London" }), "midnight-start") === "review",
);
check(
  "an off-midnight start names the hour rather than calling 05:00 mid-day",
  buildSetupCheck(setupInput({ timeZone: "Europe/London" })).findings.find(
    (finding) => finding.id === "midnight-start",
  ).detail.includes("05:00"),
);
check(
  "with no ad groups, no delivery setting is claimed as a pass",
  (() => {
    const bare = buildSetupCheck(setupInput({ lineItems: [] }));
    // Targeting and copy are still genuinely inspectable without ad groups, so they may pass.
    // Anything that can only be read off an ad group must not.
    const readOffAnAdGroup = ["must-have", "delivery", "hygiene"];
    const delivery = bare.findings.filter((finding) =>
      readOffAnAdGroup.includes(finding.section),
    );
    return (
      bare.findings.find((finding) => finding.id === "no-line-items")?.status === "unchecked" &&
      delivery.every((finding) => finding.status !== "pass")
    );
  })(),
);
check(
  "every finding carries a detail, so the panel never shows a bare verdict",
  buildSetupCheck(setupInput()).findings.every((finding) => finding.detail.trim().length > 0),
);
check(
  "what cannot be checked is listed, not guessed at",
  UNCHECKABLE.length > 0 && UNCHECKABLE.every((entry) => entry.rule && entry.why),
);

console.log("== it does not run twice ==");
check("a marker records that the move happened", existsSync(join(DATA_DIR, ".migrated")));
// The originals are left alone deliberately, so a mistake here is recoverable by hand.
check("the legacy files are left in place", existsSync(join(DATA_DIR, "connection.json")));

console.log(`\npassed: ${pass}  failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
