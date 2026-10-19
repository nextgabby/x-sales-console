/**
 * Asks whether the public Ads API can identify the new Ads Lead Gen product and count its leads.
 *
 * `probe-conversions.mjs` established that WEB_CONVERSION returns 14 `conversion_*` metrics and
 * that none of them is a lead, which left the request blocked on knowing which product was meant.
 * An internal spec answers that: Lead Gen is stored exactly like Sales — objective 5
 * (`WEBSITE_CLICKS`), `optimization_preference` 2 or 14 — and the *only* thing separating the two
 * is an autocreated conversion event whose `initial_conversion_detail` is `lead_gen_form_submit`,
 * bound on the line item as `website_conversion_tag_id`.
 *
 * So the feature rests entirely on two public-API questions, and both are answered here:
 *
 *  1. Does anything in `GET web_event_tags` carry `initial_conversion_detail`, or any other field
 *     that would mark a tag as the autocreated lead-gen one? Every field of every tag is dumped,
 *     because the documented field list has repeatedly been short of what the live API returns.
 *  2. Does `segmentation_type=CONVERSION_TAGS` break conversions out per tag id? Without it,
 *     conversions are reported per event *type*, which pools a lead-form submit with every
 *     ordinary sign-up on the account — a number that must not be labelled "Leads".
 *
 * Neither account we hold runs Lead Gen (the spec names the six that do, and we have none of
 * them), so this can establish what the API is *capable* of and nothing about a real lead count.
 *
 * Findings, as of running this against both reachable accounts:
 *
 *  - `initial_conversion_detail` does not exist publicly. A tag carries exactly twelve fields and
 *    a single-tag fetch adds none. So Lead Gen cannot be told apart from Sales through this API.
 *  - `auto_created` is true for all thirteen default events, so it marks the standard set rather
 *    than anything lead-specific.
 *  - `CONVERSION_TAGS` is a real segmentation type, accepted at both CAMPAIGN and LINE_ITEM grain,
 *    but it refuses every metric group but `WEB_CONVERSION` and the synchronous endpoint ignores it
 *    outright. Per-tag conversions therefore cost a separate async job.
 *  - The segment's shape is still unknown: no reachable account has both tags and spend.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/probe-lead-gen.mjs <accountId> [handle]
 */
import { buildOAuth1AuthorizationHeader } from "../lib/x/oauth1.ts";
import { listUsers, resolveCredentials } from "../lib/store/index.ts";

const [accountId, handle] = process.argv.slice(2);
const user = (await listUsers())[0];
const credentials = await resolveCredentials(user.userId);

async function request(method, path, query = {}) {
  const url = new URL(`https://ads-api.x.com/12${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: buildOAuth1AuthorizationHeader(method, url.toString(), {
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

const get = (path, query) => request("GET", path, query);
const post = (path, query) => request("POST", path, query);

const day = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 19) + "Z";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const account = await get(`/accounts/${accountId}`);
const timeZone = account.data?.timezone ?? "UTC";
console.log(
  `\n=== ${accountId} ${handle ? `as ${handle}` : ""} — ${account.data?.name ?? "?"} (${timeZone}) ===`,
);

/**
 * DAY granularity rejects any boundary that is not midnight in the *account's* timezone, so the
 * two-step offset trick from `probe-funding.mjs` is reused rather than reinvented.
 */
function localMidnight(daysAgo) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() - daysAgo * day));
  const date = `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}-${parts.find((p) => p.type === "day").value}`;
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

// ── 1. Every field of every web event tag ──────────────────────────────────────────────────────
//
// `with_deleted` matters here beyond completeness: the spec is explicit that the autocreated
// lead-gen event may be removed by the advertiser and that a campaign stays classified as Leads
// afterwards, so a filter that drops deleted tags would lose exactly the case being looked for.

const tags = await get(`/accounts/${accountId}/web_event_tags`, {
  count: 200,
  with_deleted: true,
});

if (tags.__error) {
  console.log(`\nweb_event_tags: ${tags.__error}`);
} else {
  const rows = tags.data ?? [];
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  console.log(`\n=== web_event_tags: ${rows.length} tags, union of ${keys.length} fields ===`);
  console.log(keys.join("\n"));

  // Anything that could carry the spec's discriminator, however it might be spelled.
  const discriminators = keys.filter((key) =>
    /initial|detail|auto|lead|source|created_by/i.test(key),
  );
  console.log(
    `\nfields that could mark an autocreated lead-gen event: ${discriminators.length ? discriminators.join(", ") : "NONE"}`,
  );

  console.log("\n=== every tag, in full ===");
  for (const row of rows) {
    console.log(JSON.stringify(row));
  }

  console.log("\n=== distinct values per field ===");
  for (const key of keys) {
    const values = [...new Set(rows.map((row) => JSON.stringify(row[key] ?? null)))];
    console.log(
      `  ${key}: ${values.slice(0, 8).join(" | ")}${values.length > 8 ? ` (+${values.length - 8})` : ""}`,
    );
  }

  // A single-tag fetch sometimes returns more than the list does, and resolving
  // `primary_web_event_tag` would go through it anyway.
  const first = rows[0];
  if (first) {
    const one = await get(`/accounts/${accountId}/web_event_tags/${first.id}`);
    if (one.__error) {
      console.log(`\nsingle tag fetch: ${one.__error}`);
    } else {
      const extra = Object.keys(one.data ?? {}).filter((key) => !keys.includes(key));
      console.log(`\nsingle tag fetch adds: ${extra.length ? extra.join(", ") : "nothing"}`);
      console.log(JSON.stringify(one.data));
    }
  }
}

// ── 2. Every field of every line item, and which of them bind a tag ────────────────────────────
//
// The spec's gate is objective 5 + optimization_preference 2/14 + the bound event. Two of those
// three have to map onto public fields for the gate to be reproducible here at all.

const lineItems = await get(`/accounts/${accountId}/line_items`, {
  count: 1000,
  with_deleted: true,
});

const lineItemIds = (lineItems.data ?? [])
  .filter((row) => !row.deleted)
  .map((row) => row.id)
  .slice(0, 5);

if (lineItems.__error) {
  console.log(`\nline_items: ${lineItems.__error}`);
} else {
  const rows = lineItems.data ?? [];
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  console.log(`\n=== line_items: ${rows.length} rows, union of ${keys.length} fields ===`);
  console.log(keys.join("\n"));

  const optimization = keys.filter((key) =>
    /optim|goal|bid_unit|pay_by|preference|charge/i.test(key),
  );
  console.log(
    `\nfields that could carry optimization_preference: ${optimization.length ? optimization.join(", ") : "NONE"}`,
  );

  console.log("\n=== distinct values on the fields the spec's gate needs ===");
  for (const key of [
    "objective",
    "goal",
    "pay_by",
    "bid_unit",
    "bid_strategy",
    "product_type",
    "primary_web_event_tag",
    "advertiser_domain",
  ]) {
    const values = [...new Set(rows.map((row) => JSON.stringify(row[key] ?? null)))];
    console.log(
      `  ${key}: ${values.slice(0, 10).join(" | ")}${values.length > 10 ? ` (+${values.length - 10})` : ""}`,
    );
  }

  // (objective, goal, pay_by) together, because the mapping question is whether the triple is
  // enough to separate opt_pref 2 from 14 — neither field alone can.
  const shapes = new Map();
  for (const row of rows) {
    const shape = `${row.objective ?? "—"} / goal=${row.goal ?? "—"} / pay_by=${row.pay_by ?? "—"} / bid_unit=${row.bid_unit ?? "—"}`;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  console.log("\n=== objective × goal × pay_by × bid_unit, with counts ===");
  for (const [shape, count] of [...shapes].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${shape}`);
  }

  const bound = rows.filter((row) => row.primary_web_event_tag);
  console.log(`\n=== ${bound.length} of ${rows.length} line items bind a web event tag ===`);
  for (const row of bound.slice(0, 20)) {
    console.log(
      `  ${row.id}  ${row.objective} goal=${row.goal ?? "—"} → tag ${row.primary_web_event_tag}`,
    );
  }
}

// ── 3. Can conversions be broken out per tag id? ───────────────────────────────────────────────
//
// This is the question that decides whether the feature is honest. Conversions in the stats API
// are reported per event *type* — `conversion_sign_ups` and so on — pooled across every tag of
// that type on the account. The spec says the lead-gen event is autocreated and shared by many
// line items, so a per-type figure mixes real sign-ups with lead-form submits and cannot be
// labelled "Leads". Per-tag segmentation would fix that exactly.

let end = localMidnight(1);
let start = localMidnight(8);

/**
 * Entities are chosen by what *spent*, not by what the campaign list returns first. A job over
 * entities that delivered nothing reports zero conversions in a single unsegmented row, which is
 * indistinguishable from segmentation not working — the exact confusion this probe exists to
 * avoid. `active_entities` is the authority, and a year is walked in 90-day windows (its cap) for
 * an account whose recent weeks are quiet.
 */
console.log("\n=== asking active_entities which entities actually spent ===");
let campaignIds = [];
for (let offset = 1; offset <= 365 && campaignIds.length === 0; offset += 90) {
  const windowStart = localMidnight(offset + 90);
  const windowEnd = localMidnight(offset);
  const active = await get(`/stats/accounts/${accountId}/active_entities`, {
    entity: "CAMPAIGN",
    start_time: iso(windowStart),
    end_time: iso(windowEnd),
  });
  if (active.__error) {
    console.log(`  -${offset + 90}d → -${offset}d: ${active.__error.slice(0, 160)}`);
    continue;
  }
  const found = [...new Set((active.data ?? []).map((entry) => entry.entity_id))];
  console.log(`  -${offset + 90}d → -${offset}d: ${found.length} campaigns spent`);
  if (found.length > 0) {
    campaignIds = found;
    /**
     * The job has to cover the days those entities actually delivered on — but a segmented job
     * spans at most 45 days against `active_entities`' 90, so the window is clamped rather than
     * copied, which would be rejected outright.
     */
    end = windowEnd;
    start = Math.max(windowStart, localMidnight(offset + 45));
  }
}

/**
 * Narrowed to the ones bound to a web event tag, because a campaign with no tag has nothing to
 * segment by and would answer the question with a false negative. Line items are preferred over
 * campaigns for the same reason the spec binds at line-item grain: the tag is bound there.
 */
const spentAndTagged = (lineItems.data ?? []).filter(
  (row) => row.primary_web_event_tag && campaignIds.includes(row.campaign_id),
);
const taggedLineItemIds = spentAndTagged.map((row) => row.id).slice(0, 20);
const taggedCampaignIds = [...new Set(spentAndTagged.map((row) => row.campaign_id))].slice(0, 20);

console.log(
  `\n=== of the campaigns that spent, ${taggedCampaignIds.length} carry a tag-bound line item ===`,
);
for (const row of spentAndTagged.slice(0, 10)) {
  console.log(`  ${row.campaign_id} / ${row.id}  ${row.objective} goal=${row.goal} → tag ${row.primary_web_event_tag}`);
}

if (taggedCampaignIds.length > 0) {
  campaignIds = taggedCampaignIds;
}
campaignIds = campaignIds.slice(0, 20);

console.log(`\n=== segmentation, ${campaignIds.length} campaigns, ${iso(start)} → ${iso(end)} ===`);

if (campaignIds.length === 0) {
  console.log("  no live campaigns on this account, so no job can be run against it");
} else {
  /**
   * The controls are the point. `PLATFORMS` is known to work, so it proves the job path itself is
   * sound; `NOT_A_SEGMENT` is nonsense, so if it were accepted then acceptance of `CONVERSION_TAGS`
   * would mean nothing. The sync endpoint is checked too, because it takes `segmentation_type`,
   * ignores it, and echoes back null — which reads like success.
   *
   * `CONVERSION_TAGS` refuses any metric group but `WEB_CONVERSION`, which is itself the first
   * piece of evidence that it is real: a type the API merely tolerated would not have an opinion
   * about which metrics it can be paired with. It also means a lead count cannot ride along in the
   * request the dashboard already makes, the way MOBILE_CONVERSION does.
   */
  const attempts = [
    { segmentation: "PLATFORMS", metricGroups: "ENGAGEMENT,BILLING,WEB_CONVERSION", entity: "CAMPAIGN" },
    { segmentation: "CONVERSION_TAGS", metricGroups: "WEB_CONVERSION", entity: "CAMPAIGN" },
    { segmentation: "CONVERSION_TAGS", metricGroups: "WEB_CONVERSION", entity: "LINE_ITEM" },
    { segmentation: "CONVERSION_TAGS", metricGroups: "ENGAGEMENT,BILLING,WEB_CONVERSION", entity: "CAMPAIGN" },
    { segmentation: "NOT_A_SEGMENT", metricGroups: "WEB_CONVERSION", entity: "CAMPAIGN" },
  ];

  for (const { segmentation, metricGroups, entity } of attempts) {
    const ids =
      entity === "LINE_ITEM"
        ? taggedLineItemIds.length > 0
          ? taggedLineItemIds
          : lineItemIds
        : campaignIds;
    const label = `${segmentation} / ${entity} / ${metricGroups}`;
    if (ids.length === 0) {
      console.log(`\n  ${label}: no ${entity} ids on this account`);
      continue;
    }

    const created = await post(`/stats/jobs/accounts/${accountId}`, {
      entity,
      entity_ids: ids.join(","),
      start_time: iso(start),
      end_time: iso(end),
      granularity: "TOTAL",
      placement: "ALL_ON_TWITTER",
      metric_groups: metricGroups,
      segmentation_type: segmentation,
    });

    if (created.__error) {
      console.log(`\n  ${label}: job REJECTED — ${created.__error.slice(0, 300)}`);
      continue;
    }

    const job = created.data;
    const jobId = String(job?.id_str ?? job?.id ?? "");
    console.log(
      `\n  ${label}: job ${jobId} accepted, echoed segmentation_type=${JSON.stringify(job?.segmentation_type)}`,
    );

    let finished = job;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(1_500);
      const polled = await get(`/stats/jobs/accounts/${accountId}`, { job_ids: jobId });
      if (polled.__error) {
        console.log(`    poll failed: ${polled.__error.slice(0, 160)}`);
        break;
      }
      finished = (polled.data ?? []).find((entry) => String(entry.id_str ?? entry.id) === jobId);
      if (!finished) {
        console.log("    job disappeared");
        break;
      }
      if (finished.status !== "PROCESSING" && finished.status !== "UPLOADING") break;
    }

    console.log(`    status: ${finished?.status}`);
    if (finished?.status !== "SUCCESS" || !finished.url) continue;

    const download = await fetch(finished.url, { cache: "no-store" });
    const raw = Buffer.from(await download.arrayBuffer());
    const { gunzipSync } = await import("node:zlib");
    const text =
      raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b
        ? gunzipSync(raw).toString("utf8")
        : raw.toString("utf8");
    const parsed = JSON.parse(text);

    console.log(`    file params: ${JSON.stringify(parsed.request?.params ?? null)}`);
    for (const entry of parsed.data ?? []) {
      for (const bucket of entry.id_data ?? []) {
        const conversion = Object.entries(bucket.metrics ?? {}).filter(([key]) =>
          key.startsWith("conversion"),
        );
        /**
         * "Present but null" is the shape that matters: a conversion metric comes back as an
         * object keyed by attribution, so anything that merely exists reads as non-null. Only a
         * number somewhere inside it is a real figure.
         */
        const populated = conversion.filter(([, value]) =>
          Object.values(value ?? {}).some(
            (series) => Array.isArray(series) && series.some((n) => n),
          ),
        );
        console.log(
          `    ${entry.id}  segment=${JSON.stringify(bucket.segment ?? null)}` +
            `  spend=${(bucket.metrics?.billed_charge_local_micro ?? [0])[0] / 1e6}` +
            `  conversion keys=${conversion.length} populated=${populated.length}` +
            (populated.length ? ` → ${populated.map(([k]) => k).join(", ")}` : ""),
        );
      }
    }
  }

  /**
   * The synchronous control. If it echoed `CONVERSION_TAGS` back it would be the cheap path, but
   * the documented behaviour on this endpoint is to accept the parameter and ignore it.
   */
  const sync = await get(`/stats/accounts/${accountId}`, {
    entity: "CAMPAIGN",
    entity_ids: campaignIds.join(","),
    granularity: "TOTAL",
    metric_groups: "ENGAGEMENT,BILLING,WEB_CONVERSION",
    start_time: iso(start),
    end_time: iso(end),
    placement: "ALL_ON_TWITTER",
    segmentation_type: "CONVERSION_TAGS",
  });
  console.log(
    `\n  synchronous with segmentation_type=CONVERSION_TAGS: ` +
      (sync.__error ??
        `echoed ${JSON.stringify(sync.request?.params?.segmentation_type ?? null)}, ${sync.data?.length ?? 0} rows`),
  );
}

// ── 4. Is there a lead-gen conversion type at all? ─────────────────────────────────────────────
//
// `auto_created` is the only field on a tag that could mark one, and it is true for the entire
// default event set, so it cannot single out a lead-gen event. That leaves `type`. Rejecting an
// invalid value is how the segmentation enum printed itself above, so the same trick is used here
// rather than guessing — and asking is the only way to find a value the docs do not list.

console.log("\n=== conversion type enum, read off the API's own rejection ===");
for (const [parameter, value] of [
  ["type", "NOT_A_TYPE"],
  ["conversion_type", "NOT_A_TYPE"],
]) {
  const probe = await get(`/accounts/${accountId}/web_event_tags`, { [parameter]: value, count: 1 });
  console.log(`  ${parameter}=${value}: ${probe.__error ?? "accepted and ignored"}`);
}

/**
 * The spec's own table is built on `online_conversion_tracking_pixels`, and the internal name is
 * worth trying directly: an endpoint the docs omit would not be the first one this project found.
 */
for (const path of [
  `/accounts/${accountId}/online_conversion_tracking_pixels`,
  `/accounts/${accountId}/conversion_events`,
  `/accounts/${accountId}/conversion_tags`,
]) {
  const probe = await get(path, { count: 1 });
  console.log(`  GET ${path}: ${probe.__error?.slice(0, 120) ?? JSON.stringify(probe).slice(0, 200)}`);
}
