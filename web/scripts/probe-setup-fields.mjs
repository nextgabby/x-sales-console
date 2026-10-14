/**
 * Prints the raw campaign and line item objects a live account returns, so the campaign-setup
 * checker can be designed against the fields that actually exist rather than the ones the Ads API
 * reference implies. Written for the same reason as `probe-targeting.mjs`: the shape of the data
 * decides which checklist items are checkable at all.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/probe-setup-fields.mjs <accountId> [handle]
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
    throw new Error(`${response.status} ${path} ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

const campaigns = await get(`/accounts/${accountId}/campaigns`, { count: 200 });
const live = (campaigns.data ?? []).filter((c) => c.entity_status === "ACTIVE");
const campaign = live[0] ?? campaigns.data?.[0];
if (!campaign) throw new Error("no campaigns on this account");

console.log("=== campaign keys ===");
console.log(Object.keys(campaign).sort().join("\n"));
console.log("\n=== campaign ===");
console.log(JSON.stringify(campaign, null, 1));

const lineItems = await get(`/accounts/${accountId}/line_items`, {
  campaign_ids: campaign.id,
  count: 200,
});
const item = lineItems.data?.[0];
if (!item) {
  console.log("\nno line items on that campaign");
  process.exit(0);
}

console.log("\n=== line item keys ===");
console.log(Object.keys(item).sort().join("\n"));
console.log("\n=== line item ===");
console.log(JSON.stringify(item, null, 1));

/*
 * Which of these vary across the account is the real question: a field that is the same on every
 * line item everywhere is either not configurable or not configured, and either way a check on it
 * would always read the same.
 */
const all = await get(`/accounts/${accountId}/line_items`, { count: 1000 });
const interesting = [
  "standard_delivery",
  "placements",
  "bid_type",
  "bid_unit",
  "automatically_select_bid",
  "goal",
  "product_type",
  "advertiser_domain",
  "frequency_cap",
  "audience_expansion",
  "optimization",
];
console.log(`\n=== spread across ${all.data?.length ?? 0} line items on the account ===`);
for (const key of interesting) {
  const values = new Set((all.data ?? []).map((row) => JSON.stringify(row[key])));
  console.log(`${key}: ${[...values].slice(0, 6).join(" | ")}`);
}
