/**
 * Asks whether an insertion order can be paced without summing its campaigns.
 *
 * Summing campaign spend would understate it: the dashboard's flight backfill only covers
 * campaigns that carry a total budget and an open flight, so anything on the IO without one would
 * be missing, and an understated spend makes a fully committed IO look underspent. If the stats
 * endpoint accepts `entity=FUNDING_INSTRUMENT` then the IO's own number is one request and exact.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/probe-funding.mjs <accountId> [handle]
 */
import { buildOAuth1AuthorizationHeader } from "../lib/x/oauth1.ts";
import { listUsers, resolveCredentials } from "../lib/store/index.ts";

const [accountId, handle] = process.argv.slice(2);
const user = (await listUsers())[0];
const credentials = await resolveCredentials(user.userId);

async function get(path, query = {}) {
  const url = new URL(`https://ads-api.x.com/12${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: {
      Authorization: buildOAuth1AuthorizationHeader("GET", url.toString(), {
        consumerKey: credentials.consumerKey,
        consumerSecret: credentials.consumerSecret,
        token: credentials.accessToken,
        tokenSecret: credentials.accessTokenSecret,
      }),
      Accept: "application/json",
      ...(handle ? { "x-as-user": handle } : {}),
    },
  });
  if (!response.ok) {
    return { __error: `${response.status} ${(await response.text()).slice(0, 300)}` };
  }
  return response.json();
}

const instruments = await get(`/accounts/${accountId}/funding_instruments`, { count: 50 });
const rows = (instruments.data ?? []).filter((row) => !row.deleted);

console.log(`\n=== ${accountId} — ${rows.length} funding instruments ===`);
for (const row of rows) {
  console.log(
    `\n  ${row.id}  ${row.type}  ${row.entity_status}` +
      `\n    ${row.description}` +
      `\n    io_header: ${row.io_header ?? "—"}` +
      `\n    funded: ${row.funded_amount_local_micro == null ? "—" : row.funded_amount_local_micro / 1e6} ${row.currency}` +
      `\n    flight: ${row.start_time ?? "—"} → ${row.end_time ?? "open"}` +
      `\n    able_to_fund: ${row.able_to_fund}  ${row.reasons_not_able_to_fund?.join(", ") || ""}`,
  );
}

/**
 * Control. The dashboard already pulls 90 days of CAMPAIGN spend from this same endpoint, so if
 * CAMPAIGN succeeds over a window FUNDING_INSTRUMENT refuses, the cap is a property of the entity
 * rather than of the request — which decides whether IO pacing can be one call or has to be eight.
 */
const campaignList = await get(`/accounts/${accountId}/campaigns`, { count: 5 });
const campaignIds = (campaignList.data ?? []).map((row) => row.id).slice(0, 5);
const day = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 19) + "Z";

/**
 * DAY granularity rejects anything that is not midnight in the *account's* timezone, so UTC
 * midnight is wrong for every account outside UTC. Same trap as the setup checklist's start hour.
 */
const account = await get(`/accounts/${accountId}`);
const timeZone = account.data?.timezone ?? "UTC";
function localMidnight(daysAgo) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now.getTime() - daysAgo * day));
  const date = `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}-${parts.find((p) => p.type === "day").value}`;
  // Find the instant whose local wall time is 00:00 on that date.
  const guess = new Date(`${date}T00:00:00Z`);
  const seen = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(guess);
  const n = (type) => Number(seen.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"));
  return guess.getTime() * 2 - asUtc;
}

console.log(`account timezone: ${timeZone}`);
/**
 * 7 days, because that is the endpoint's hard window for *any* entity — a 30-day request is
 * refused for CAMPAIGN too, which is why `fetchDailyStats` already chunks into windows. The
 * question here is only whether FUNDING_INSTRUMENT is a valid entity at all.
 */
const end = localMidnight(1);
const start = localMidnight(8);

const ids = rows.map((row) => row.id).slice(0, 20);
const sum = (series) => (series ?? []).reduce((total, value) => total + (value ?? 0), 0);

/**
 * `granularity=TOTAL` is capped at 7 days on this endpoint, which is no use for a flight. DAY is
 * what the dashboard already uses to pull 90 days of campaign spend, so the question is whether
 * the same allowance applies when the entity is a funding instrument.
 */
for (const [entity, entityIds] of [
  ["CAMPAIGN", campaignIds],
  ["FUNDING_INSTRUMENT", ids],
]) {
  const stats = await get(`/stats/accounts/${accountId}`, {
    entity,
    entity_ids: entityIds.join(","),
    granularity: "DAY",
    metric_groups: "BILLING",
    start_time: iso(start),
    end_time: iso(end),
    placement: "ALL_ON_TWITTER",
  });

  console.log(`\n=== ${entity}, granularity=DAY, 7 days, ${entityIds.length} ids ===`);
  if (stats.__error) {
    console.log("  rejected:", stats.__error.slice(0, 190));
    continue;
  }
  for (const entry of stats.data ?? []) {
    const metrics = entry.id_data?.[0]?.metrics ?? {};
    const spend = sum(metrics.billed_charge_local_micro);
    const row = rows.find((candidate) => candidate.id === entry.id);
    console.log(`  ${entry.id}  spend ${(spend / 1e6).toFixed(2)}  ${row?.description ?? ""}`);
  }
}

// And can one request cover a whole flight, or does the 90-day cap bite?
const open = rows.find((row) => row.start_time && row.funded_amount_local_micro);
if (open) {
  /**
   * Flight-to-date, walked in 7-day windows the way `fetchDailyStats` does. This is the number IO
   * pacing needs, and the count of requests is what decides whether it is affordable: synchronous
   * analytics is capped at 250 per 15 minutes across the whole category, not per account.
   */
  const span = Math.round((end - new Date(open.start_time).getTime()) / day);
  const spent = new Map(ids.map((id) => [id, 0]));
  let requests = 0;
  let failed = 0;

  for (let offset = span; offset > 0; offset -= 7) {
    const windowStart = localMidnight(offset + 1);
    const windowEnd = localMidnight(Math.max(offset - 7, 0) + 1);
    const chunk = await get(`/stats/accounts/${accountId}`, {
      entity: "FUNDING_INSTRUMENT",
      entity_ids: ids.join(","),
      granularity: "DAY",
      metric_groups: "BILLING",
      start_time: iso(windowStart),
      end_time: iso(windowEnd),
      placement: "ALL_ON_TWITTER",
    });
    requests += 1;
    if (chunk.__error) {
      failed += 1;
      console.log(`  window -${offset}d rejected: ${chunk.__error.slice(0, 120)}`);
      continue;
    }
    for (const entry of chunk.data ?? []) {
      const value = sum(entry.id_data?.[0]?.metrics?.billed_charge_local_micro);
      spent.set(entry.id, (spent.get(entry.id) ?? 0) + value);
    }
  }

  console.log(
    `\n=== flight-to-date (${span} days since ${open.start_time.slice(0, 10)}) ` +
      `in ${requests} requests, ${failed} failed ===`,
  );
  for (const row of rows) {
    const spend = (spent.get(row.id) ?? 0) / 1e6;
    const funded = (row.funded_amount_local_micro ?? 0) / 1e6;
    const share = funded > 0 ? `${((spend / funded) * 100).toFixed(1)}%` : "—";
    console.log(
      `  ${row.id}  ${row.entity_status.padEnd(7)}  spend ${spend.toFixed(2).padStart(11)}` +
        ` of ${String(funded).padStart(7)} = ${share.padStart(7)}  ${row.description}`,
    );
  }
}
