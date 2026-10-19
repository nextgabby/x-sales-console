/**
 * Asks whether the Ads API can answer "how many leads, and at what cost" for a live account.
 *
 * Written before designing anything, because the answer decides whether the feature is a metric
 * definition or a dead end. Three things have to be true: WEB_CONVERSION has to be requestable
 * alongside the groups already fetched, something in it has to be non-null on a real campaign, and
 * whichever metric holds leads has to be distinguishable from the other four conversion events.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/probe-conversions.mjs <accountId> [handle]
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
    return { __error: `${response.status} ${(await response.text()).slice(0, 400)}` };
  }
  return response.json();
}

const day = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 19) + "Z";
const end = Math.floor(Date.now() / day) * day;
const start = end - 7 * day;

console.log(`\n=== ${accountId} ${handle ? `as ${handle}` : ""} ===`);

// Which conversion events the advertiser has even defined. If there is no LEAD-ish web event tag,
// no metric group will invent one.
const tags = await get(`/accounts/${accountId}/web_event_tags`, { count: 200 });
if (tags.__error) {
  console.log("web_event_tags:", tags.__error);
} else {
  const rows = tags.data ?? [];
  console.log(`web event tags: ${rows.length}`);
  for (const tag of rows) {
    console.log(`  ${tag.conversion_type ?? tag.type ?? "?"}  ${tag.name}  (id ${tag.id})`);
  }
}

const campaigns = await get(`/accounts/${accountId}/campaigns`, { count: 200 });
const live = (campaigns.data ?? []).filter((c) => !c.deleted).slice(0, 40);
const items = await get(`/accounts/${accountId}/line_items`, { count: 200 });
const objectives = new Map();
for (const item of items.data ?? []) {
  if (!objectives.has(item.campaign_id)) objectives.set(item.campaign_id, item.objective);
}
console.log("\nobjectives in play:", [...new Set(objectives.values())].join(", "));

// Does WEB_CONVERSION even come back alongside the groups already requested?
for (const campaign of live.slice(0, 6)) {
  const stats = await get(`/stats/accounts/${accountId}`, {
    entity: "CAMPAIGN",
    entity_ids: campaign.id,
    granularity: "TOTAL",
    metric_groups: "ENGAGEMENT,BILLING,WEB_CONVERSION",
    start_time: iso(start),
    end_time: iso(end),
    placement: "ALL_ON_TWITTER",
  });
  if (stats.__error) {
    console.log(`\n${campaign.id} ${campaign.name}: ${stats.__error}`);
    continue;
  }
  const metrics = stats.data?.[0]?.id_data?.[0]?.metrics ?? {};
  const conversion = Object.entries(metrics).filter(([key]) => key.startsWith("conversion"));
  const nonNull = conversion.filter(([, value]) => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.some((entry) => entry);
    return Object.values(value).some((arr) => Array.isArray(arr) && arr.some((e) => e));
  });
  console.log(
    `\n${campaign.id} ${campaign.name}  [${objectives.get(campaign.id) ?? "?"}]` +
      `\n  spend: ${(metrics.billed_charge_local_micro ?? [0])[0] / 1e6}` +
      `\n  conversion keys returned: ${conversion.length}` +
      `\n  non-null: ${nonNull.length ? nonNull.map(([k]) => k).join(", ") : "none"}`,
  );
  for (const [key, value] of nonNull) {
    console.log(`    ${key} = ${JSON.stringify(value)}`);
  }
  if (conversion.length) {
    console.log(`    all keys: ${conversion.map(([k]) => k).join(", ")}`);
  }
}
