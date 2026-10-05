import { adsRequest, adsRequestAll, chunkEntityIds } from "./ads-client";
import { accountCurrency, type Campaign, type FundingInstrument } from "./accounts";
import { bestByCtr } from "./creatives";
import {
  combineSeries,
  dailySpend,
  fetchDailyStats,
  metricGroupsFor,
  totalsFrom,
  type MetricSeries,
} from "./stats";
import { buildRange, microsToCurrency } from "./time";
import type { XCredentials } from "../store";
import type {
  CampaignDetailPayload,
  LineItemRow,
  PromotedPostRow,
} from "@/app/accounts/[accountId]/types";

export class CampaignNotFoundError extends Error {}

/** Creatives enriched with text, media and a preview, highest spend first. */
const ENRICH_LIMIT = 50;

/** Only this host serves the preview renderer; anything else is not embedded. */
const PREVIEW_HOST = "ton.twimg.com";

type LineItem = {
  id: string;
  name?: string | null;
  campaign_id?: string;
  objective?: string | null;
  product_type?: string | null;
  entity_status?: string | null;
  bid_amount_local_micro?: number | null;
  goal?: string | null;
  deleted?: boolean;
};

type PromotedTweet = {
  id: string;
  tweet_id?: string | null;
  line_item_id?: string | null;
  entity_status?: string | null;
  approval_status?: string | null;
  deleted?: boolean;
};

type TweetLookup = {
  data?: Array<{
    id: string;
    text?: string;
    created_at?: string;
    author_id?: string;
    attachments?: { media_keys?: string[] };
  }>;
  includes?: {
    users?: Array<{ id: string; username?: string }>;
    media?: Array<{
      media_key: string;
      type?: string;
      url?: string;
      preview_image_url?: string;
    }>;
  };
};

/**
 * Assembles everything the campaign drawer shows, including creative-level performance.
 *
 * Lives outside the route handler for the same reason `buildDashboard` does: the creative AI
 * answers are built from these server-fetched numbers rather than figures posted back from the
 * browser, so a narrative can never be grounded in something the client edited.
 */
export async function buildCampaignDetail(options: {
  credentials: XCredentials;
  accountId: string;
  campaignId: string;
  asUser: string | null;
  days: number;
  timezone: string;
  auditHandle: string | null;
  /** Previews are iframes for the browser to mount; the AI path has no use for them. */
  includePreviews?: boolean;
}): Promise<CampaignDetailPayload> {
  const {
    credentials,
    accountId,
    campaignId,
    asUser,
    days,
    timezone,
    auditHandle,
    includePreviews = true,
  } = options;

  const audit = { handle: auditHandle, accountId };
  const warnings: string[] = [];
  const range = buildRange(days, timezone);

  const [campaignResponse, lineItems, fundingInstruments] = await Promise.all([
    adsRequest<{ data?: Campaign }>({
      path: `/accounts/${accountId}/campaigns/${campaignId}`,
      credentials,
      asUser,
      audit,
      // A retired campaign keeps its spend, so it has to be describable to open at all.
      query: { with_deleted: true },
    }),
    /**
     * `with_deleted` is not optional here. The header total is summed from these line items while
     * the table row the rep just clicked comes from campaign-level stats, which include deleted
     * line items — so omitting them makes the drawer disagree with the row it was opened from. On a
     * live account 333 of 535 line items are deleted, and several campaigns have no surviving ones
     * at all, which showed `$0` and "No line items" against a row with real spend.
     */
    adsRequestAll<LineItem>({
      path: `/accounts/${accountId}/line_items`,
      credentials,
      asUser,
      audit,
      query: { campaign_ids: campaignId, with_deleted: true },
    }),
    adsRequestAll<FundingInstrument>({
      path: `/accounts/${accountId}/funding_instruments`,
      credentials,
      asUser,
      audit,
    }).catch(() => [] as FundingInstrument[]),
  ]);

  const campaign = campaignResponse.data;
  if (!campaign) throw new CampaignNotFoundError("Campaign not found.");

  const lineItemIds = lineItems.map((item) => item.id);

  /**
   * Scoped by `line_item_ids`, not fetched wholesale and filtered. Paging every promoted tweet
   * in the account is the same mistake that cost ~20s on the line item lookup, and a large
   * advertiser has far more creatives than campaigns.
   */
  const promotedTweets = (
    await Promise.all(
      chunkEntityIds(lineItemIds).map((chunk) =>
        adsRequestAll<PromotedTweet>({
          path: `/accounts/${accountId}/promoted_tweets`,
          credentials,
          asUser,
          audit,
          query: { line_item_ids: chunk.join(","), with_deleted: true },
        }).catch(() => {
          warnings.push("Some promoted posts could not be loaded.");
          return [] as PromotedTweet[];
        }),
      ),
    )
  ).flat();

  const metricGroups = metricGroupsFor(lineItems.map((item) => item.objective));

  const stats = await fetchDailyStats({
    credentials,
    accountId,
    asUser,
    entity: "LINE_ITEM",
    entityIds: lineItemIds,
    range,
    metricGroups,
    auditHandle,
  });

  const lineItemStats = stats.series;
  if (stats.failedRequests > 0) {
    warnings.push(
      `${stats.failedRequests} stats requests failed, so these figures are understated.`,
    );
  }

  const rows: LineItemRow[] = lineItems
    /**
     * Deleted line items stay in the stats above so the header reconciles with the table row, but
     * they only earn a row of their own when they actually delivered in the window — the same rule
     * the campaign table applies to retired campaigns. Without it a campaign with ten long-deleted
     * line items lists ten rows of zeros.
     */
    .filter(
      (item) =>
        !item.deleted ||
        (lineItemStats[item.id]?.impressions.some(Boolean) ?? false),
    )
    .map((item) => {
      const series = lineItemStats[item.id];
      return {
        id: item.id,
        name: item.name ?? null,
        retired: Boolean(item.deleted),
        objective: item.objective ?? null,
        productType: item.product_type ?? null,
        entityStatus: item.entity_status ?? null,
        bidAmount:
          item.bid_amount_local_micro != null
            ? microsToCurrency(item.bid_amount_local_micro)
            : null,
        goal: item.goal ?? null,
        totals: totalsFrom(series ?? combineSeries([], range.dates.length)),
        spendSeries: series
          ? dailySpend(series)
          : new Array(range.dates.length).fill(0),
      };
    });
  rows.sort((a, b) => b.totals.spend - a.totals.spend);

  // Line items roll up to the campaign, so no extra stats call is needed for the header.
  const campaignSeries = combineSeries(
    Object.values(lineItemStats),
    range.dates.length,
  );

  // Creative-level performance: the same metrics, one level deeper, so a rep can say which post
  // to make more of rather than only which line item won.
  const creativeStats = await fetchDailyStats({
    credentials,
    accountId,
    asUser,
    entity: "PROMOTED_TWEET",
    entityIds: promotedTweets.map((tweet) => tweet.id),
    range,
    metricGroups,
    auditHandle,
  });
  if (creativeStats.failedRequests > 0) {
    warnings.push("Some creative figures are incomplete.");
  }

  const lineItemNames = new Map(
    lineItems.map((item) => [item.id, item.name ?? null]),
  );

  const posts = buildPostRows({
    promoted: promotedTweets,
    series: creativeStats.series,
    dateCount: range.dates.length,
    lineItemNames,
  });
  posts.sort((a, b) => b.totals.spend - a.totals.spend);

  /**
   * Text, media and previews are fetched only for the highest-spending creatives. A real campaign
   * came back with 187 of them, and enriching all of them meant ten preview calls for creatives
   * no one scrolls to. Metrics are already attached for every one.
   */
  const enriched = posts.slice(0, ENRICH_LIMIT);
  // The badged winner can rank well below the top by spend — #32 of 187 on a real campaign — so it
  // is added explicitly rather than left to fall inside the cut.
  const winner = bestByCtr(posts);
  if (winner && !enriched.includes(winner)) enriched.push(winner);

  const tweetIds = [
    ...new Set(enriched.map((post) => post.tweetId).filter(Boolean)),
  ] as string[];

  const [, previews] = await Promise.all([
    hydratePosts({ rows: enriched, credentials }),
    includePreviews
      ? fetchPreviews({ accountId, tweetIds, credentials, asUser, audit })
      : Promise.resolve(new Map<string, string>()),
  ]);

  for (const post of enriched) {
    post.previewUrl = post.tweetId
      ? (previews.get(post.tweetId) ?? null)
      : null;
  }

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      entityStatus: campaign.entity_status ?? null,
      effectiveStatus: campaign.effective_status ?? null,
      objective: lineItems.find((item) => item.objective)?.objective ?? null,
      dailyBudget:
        campaign.daily_budget_amount_local_micro != null
          ? microsToCurrency(campaign.daily_budget_amount_local_micro)
          : null,
      totalBudget:
        campaign.total_budget_amount_local_micro != null
          ? microsToCurrency(campaign.total_budget_amount_local_micro)
          : null,
      startTime: campaign.start_time ?? null,
      endTime: campaign.end_time ?? null,
    },
    currency: accountCurrency(fundingInstruments),
    range: { days, dates: range.dates },
    totals: totalsFrom(campaignSeries),
    spendSeries: dailySpend(campaignSeries),
    lineItems: rows,
    promotedPosts: posts,
    warnings,
  };
}

/**
 * Creative previews, because text alone does not describe an ad. The v2 media expansion returns
 * nothing for Promoted-only posts — verified against a creative with two million video views — and
 * website cards are not v2 media at all, so this endpoint is the only way to see the real thing.
 *
 * The API hands back an `<iframe>` element as a string. Rather than injecting that HTML, the `src`
 * is extracted and its host checked, so what reaches the browser is a URL this code chose.
 */
async function fetchPreviews(options: {
  accountId: string;
  tweetIds: string[];
  credentials: XCredentials;
  asUser: string | null;
  audit: { handle: string | null; accountId: string | null };
}): Promise<Map<string, string>> {
  const { accountId, tweetIds, credentials, asUser, audit } = options;
  const previews = new Map<string, string>();
  if (tweetIds.length === 0) return previews;

  await Promise.all(
    chunkEntityIds(tweetIds).map(async (chunk) => {
      try {
        const response = await adsRequest<{
          data?: Array<{ tweet_id?: string; preview?: string }>;
        }>({
          path: `/accounts/${accountId}/tweet_previews`,
          credentials,
          asUser,
          audit,
          query: { tweet_ids: chunk.join(","), tweet_type: "PUBLISHED" },
        });

        for (const entry of response.data ?? []) {
          const src = /src=['"]([^'"]+)['"]/.exec(entry.preview ?? "")?.[1];
          if (!entry.tweet_id || !src) continue;
          try {
            const url = new URL(src.replace(/&amp;/g, "&"));
            if (url.protocol === "https:" && url.hostname === PREVIEW_HOST) {
              previews.set(entry.tweet_id, url.toString());
            }
          } catch {
            // Unparseable src; skip this preview.
          }
        }
      } catch {
        // Previews are a nicety. The metrics do not depend on them.
      }
    }),
  );

  return previews;
}

function buildPostRows(options: {
  promoted: PromotedTweet[];
  series: Record<string, MetricSeries>;
  dateCount: number;
  lineItemNames: Map<string, string | null>;
}): PromotedPostRow[] {
  const { promoted, series, dateCount, lineItemNames } = options;

  return promoted.map((tweet) => {
    const stats = series[tweet.id];
    return {
      id: tweet.id,
      tweetId: tweet.tweet_id ?? null,
      lineItemId: tweet.line_item_id ?? null,
      lineItemName: tweet.line_item_id
        ? (lineItemNames.get(tweet.line_item_id) ?? null)
        : null,
      text: null,
      authorHandle: null,
      createdAt: null,
      mediaUrl: null,
      mediaType: null,
      previewUrl: null,
      entityStatus: tweet.entity_status ?? null,
      approvalStatus: tweet.approval_status ?? null,
      totals: totalsFrom(stats ?? combineSeries([], dateCount)),
      spendSeries: stats ? dailySpend(stats) : new Array(dateCount).fill(0),
    };
  });
}

/**
 * Fills in post text and media from the v2 lookup, mutating the rows in place. Best-effort: the
 * performance numbers are attached before this runs, so a failed lookup costs the preview text
 * but never the metrics.
 */
async function hydratePosts(options: {
  rows: PromotedPostRow[];
  credentials: XCredentials;
}): Promise<void> {
  const { rows, credentials } = options;

  // The v2 lookup takes at most 100 IDs per call.
  const ids = [
    ...new Set(rows.map((row) => row.tweetId).filter(Boolean)),
  ].slice(0, 100) as string[];
  if (ids.length === 0) return;

  try {
    const lookup = await adsRequest<TweetLookup>({
      path: "https://api.x.com/2/tweets",
      credentials,
      query: {
        ids: ids.join(","),
        "tweet.fields": "created_at,text,attachments",
        expansions: "author_id,attachments.media_keys",
        "user.fields": "username",
        "media.fields": "type,url,preview_image_url",
      },
    });

    const usersById = new Map(
      (lookup.includes?.users ?? []).map((user) => [
        user.id,
        user.username ?? null,
      ]),
    );
    const mediaByKey = new Map(
      (lookup.includes?.media ?? []).map((item) => [item.media_key, item]),
    );
    const byId = new Map((lookup.data ?? []).map((tweet) => [tweet.id, tweet]));

    for (const row of rows) {
      const tweet = row.tweetId ? byId.get(row.tweetId) : undefined;
      if (!tweet) continue;
      row.text = tweet.text ?? null;
      row.createdAt = tweet.created_at ?? null;
      row.authorHandle = tweet.author_id
        ? (usersById.get(tweet.author_id) ?? null)
        : null;

      const media = tweet.attachments?.media_keys
        ?.map((key) => mediaByKey.get(key))
        .find(Boolean);
      if (media) {
        // Video and GIF carry no `url`, only a poster frame.
        row.mediaUrl = media.url ?? media.preview_image_url ?? null;
        row.mediaType = media.type ?? null;
      }
    }
  } catch {
    // Leave the IDs unhydrated; the metrics are already attached.
  }
}
