/**
 * Prints the targeting criteria actually set on a live account's line items.
 *
 * Written before designing the panel, because the shape of this data decides the design: how many
 * criteria a real campaign carries, which types advertisers actually use, whether `name` is
 * populated enough to render without a lookup table, and whether negation is common.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/probe-targeting.mjs <accountId> [handle]
 */
import { buildOAuth1AuthorizationHeader } from "../lib/x/oauth1.ts";
import { listUsers, resolveCredentials } from "../lib/store/index.ts";

const [accountId, handle] = process.argv.slice(2);
const user = (await listUsers())[0];
const credentials = await resolveCredentials(user.userId);

let calls = 0;
let lastHeaders = null;

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
  calls += 1;
  lastHeaders = [...response.headers.entries()].filter(([k]) => k.includes("rate-limit"));
  if (!response.ok) {
    throw new Error(`${response.status} ${path} ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

const campaigns = await get(`/accounts/${accountId}/campaigns`, { count: 200 });
const live = (campaigns.data ?? []).filter((c) => c.entity_status === "ACTIVE");
console.log(`campaigns: ${campaigns.data?.length ?? 0} total, ${live.length} ACTIVE`);

const sample = live.slice(0, 3);
for (const campaign of sample) {
  const items = await get(`/accounts/${accountId}/line_items`, {
    campaign_ids: campaign.id,
    count: 200,
  });
  const ids = (items.data ?? []).map((i) => i.id);
  console.log(`\n=== ${campaign.name} (${campaign.id}) — ${ids.length} line items ===`);
  if (ids.length === 0) continue;

  // One request covers every line item in the campaign: the endpoint takes up to 200 ids.
  const criteria = await get(`/accounts/${accountId}/targeting_criteria`, {
    line_item_ids: ids.slice(0, 200).join(","),
    count: 1000,
  });
  const rows = criteria.data ?? [];
  console.log(`  criteria returned: ${rows.length}  (next_cursor: ${criteria.next_cursor})`);

  const byType = new Map();
  for (const row of rows) {
    const key = `${row.targeting_type}${row.operator_type === "NE" ? " (negated)" : ""}`;
    const list = byType.get(key) ?? [];
    list.push(row);
    byType.set(key, list);
  }
  for (const [type, list] of [...byType.entries()].sort()) {
    const named = list.filter((r) => r.name != null).length;
    const examples = list
      .slice(0, 4)
      .map((r) => (r.name != null ? `${r.name}` : `<no name: ${r.targeting_value}>`))
      .join(", ");
    console.log(
      `  ${type.padEnd(34)} n=${String(list.length).padStart(3)}  named=${named}/${list.length}  ${examples}`,
    );
  }
  // Which line items carry nothing at all: a line item with no criteria is untargeted.
  const withCriteria = new Set(rows.map((r) => r.line_item_id));
  const bare = ids.filter((id) => !withCriteria.has(id));
  if (bare.length) console.log(`  line items with NO criteria: ${bare.length}/${ids.length}`);

  /**
   * Custom audiences are the one type whose `name` is useless — every criterion comes back as
   * "Custom audience targeting" — so they need a second call. Two things about it were only
   * learnable by trying: `custom_audience_ids` does scope the list endpoint, and without
   * `with_deleted` it answers 200 with zero rows, which looks exactly like an ignored parameter.
   */
  const audienceIds = [
    ...new Set(
      rows.filter((r) => r.targeting_type === "CUSTOM_AUDIENCE").map((r) => r.targeting_value),
    ),
  ];
  if (audienceIds.length > 0) {
    for (const withDeleted of [false, true]) {
      const audiences = await get(`/accounts/${accountId}/custom_audiences`, {
        custom_audience_ids: audienceIds.join(","),
        ...(withDeleted ? { with_deleted: true } : {}),
      });
      const got = audiences.data ?? [];
      console.log(
        `  custom_audience_ids with_deleted=${withDeleted}: ${got.length}/${audienceIds.length} resolved`,
      );
      for (const audience of got) {
        console.log(`    ${audience.id}  ${audience.deleted ? "[DELETED] " : ""}${audience.name}`);
      }
    }
  }
}

console.log(`\nrequests made: ${calls}`);
console.log("rate limit headers on the last call:");
for (const [key, value] of (lastHeaders ?? []).sort()) console.log(`  ${key}: ${value}`);
