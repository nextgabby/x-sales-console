/**
 * Reads the funding panel's payload off a real account, through `buildDashboard` rather than the
 * HTTP route, so the pacing verdicts are exercised against live insertion orders without needing a
 * signed-in browser session.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/probe-funding-live.mjs <accountId> [asUser]
 */
import { ANONYMOUS_ACTOR } from "../lib/auth/actor.ts";
import { buildDashboard } from "../lib/x/dashboard.ts";
import { listUsers, resolveCredentials } from "../lib/store/index.ts";

const [accountId, asUser] = process.argv.slice(2);
const user = (await listUsers())[0];
const credentials = await resolveCredentials(user.userId);

const data = await buildDashboard({
  credentials,
  accountId,
  asUser: asUser ?? null,
  days: 30,
  actor: ANONYMOUS_ACTOR,
});

console.log("partial:", data.partial, "| warnings:", data.warnings);
const money = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

for (const row of data.fundingInstruments) {
  const head = [
    (row.description ?? "").slice(0, 34).padEnd(36),
    String(row.type).padEnd(16),
    String(row.entityStatus).padEnd(7),
    `io=${row.ioHeader}`,
    `camps=${row.campaigns}`,
    `${row.startTime ?? "?"}..${row.endTime ?? "open"}`,
  ];
  console.log(head.join(" "));
  const p = row.pacing;
  if (!p) {
    console.log("   pacing: not fetched");
    continue;
  }
  console.log(
    `   ${p.status.padEnd(12)} $${money(p.spendToDate)} of $${money(p.fundedAmount)}` +
      ` (${(p.shareSpent * 100).toFixed(1)}% spent / ${(p.shareElapsed * 100).toFixed(1)}% elapsed)` +
      ` atRisk $${money(p.atRisk)} ${p.daysRemaining}d left` +
      (p.blockedReason ? ` blocked=${p.blockedReason}` : ""),
  );
}
