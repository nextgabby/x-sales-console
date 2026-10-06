/**
 * Prints X's rate limit headers for one analytics request and one entity read.
 *
 * Which scope the limit is reported against decides whether the hosted deployment is viable: a
 * limit per user token means each rep brings their own budget, while an application-wide one means
 * every rep shares it and the console gets slower as the team grows.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/probe-rate-limits.mjs <accountId> <handle>
 */
import { buildOAuth1AuthorizationHeader } from "../lib/x/oauth1.ts";
import { listUsers, resolveCredentials } from "../lib/store/index.ts";

const [accountId, handle] = process.argv.slice(2);
const user = (await listUsers())[0];
const credentials = await resolveCredentials(user.userId);

async function probe(label, path, query = {}) {
  const url = new URL(`https://ads-api.x.com/12${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

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

  console.log(`\n== ${label} -> ${response.status} ==`);
  const interesting = [...response.headers.entries()].filter(([key]) => key.includes("rate-limit"));
  if (interesting.length === 0) console.log("   (no rate limit headers)");
  for (const [key, value] of interesting.sort()) {
    const shown = key.endsWith("reset")
      ? `${value}  (${Math.round((Number(value) * 1000 - Date.now()) / 1000)}s from now)`
      : value;
    console.log(`   ${key}: ${shown}`);
  }
}

const now = new Date();
const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const start = new Date(end.getTime() - 2 * 86_400_000);

await probe("analytics: GET /stats/accounts/:id", `/stats/accounts/${accountId}`, {
  entity: "ACCOUNT",
  entity_ids: accountId,
  metric_groups: "BILLING",
  granularity: "TOTAL",
  placement: "ALL_ON_TWITTER",
  start_time: start.toISOString(),
  end_time: end.toISOString(),
});

await probe("entity read: GET /accounts/:id/campaigns", `/accounts/${accountId}/campaigns`, {
  count: "1",
});
