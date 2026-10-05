#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { adsRequest, errorResult, jsonResult } from "./client.js";
import {
  CONFIG_PATH,
  ENV_PATH,
  getAuthMode,
  getOAuth1Credentials,
  getOAuth2AccessToken,
  loadConfig,
  resolveAccountId,
  resolveAsUser,
  saveConfig,
} from "./config.js";

const asUserOpt = z
  .string()
  .optional()
  .describe("Override x-as-user handle for this call only (e.g. CoyoteACMEMovie).");

const accountIdOpt = z
  .string()
  .optional()
  .describe("Ads account id override for this call only (e.g. 18ce55vdy8s).");

const server = new McpServer({
  name: "x-ads-as-user",
  version: "1.0.0",
});

server.registerTool(
  "get_context",
  {
    description:
      "Show the current editable defaults (as_user, account_id), config path, and whether an access token is loaded.",
    inputSchema: {},
  },
  async () => {
    try {
      const cfg = loadConfig();
      let authMode: "oauth1" | "oauth2" | null = null;
      try {
        authMode = getAuthMode();
      } catch {
        authMode = null;
      }
      return jsonResult({
        config_path: CONFIG_PATH,
        env_path: ENV_PATH,
        as_user: cfg.as_user,
        account_id: cfg.account_id ?? null,
        auth_mode: authMode,
        oauth1_ready: Boolean(getOAuth1Credentials()),
        oauth2_ready: Boolean(getOAuth2AccessToken()),
        how_to_auth:
          "Put OAuth 1.0a keys in .env (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET), then refresh the MCP server.",
        how_to_switch:
          "Call set_as_user / set_account, edit as-user.config.json, or pass as_user/account_id on any tool call.",
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "set_as_user",
  {
    description:
      "Persist the default x-as-user handle (and optional account_id) to as-user.config.json so later tools use it until you switch again.",
    inputSchema: {
      as_user: z.string().describe("Handle to impersonate via x-as-user (without @)."),
      account_id: z
        .string()
        .optional()
        .describe("Optional ads account id to save as the new default."),
    },
  },
  async ({ as_user, account_id }) => {
    try {
      const current = loadConfig();
      const saved = saveConfig({
        as_user,
        account_id: account_id ?? current.account_id,
        notes: current.notes,
      });
      return jsonResult({ ok: true, saved, config_path: CONFIG_PATH });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "set_account",
  {
    description: "Persist the default ads account_id in as-user.config.json.",
    inputSchema: {
      account_id: z.string().describe("Ads account id, e.g. 18ce55vdy8s"),
    },
  },
  async ({ account_id }) => {
    try {
      const current = loadConfig();
      const saved = saveConfig({
        as_user: current.as_user,
        account_id,
        notes: current.notes,
      });
      return jsonResult({ ok: true, saved, config_path: CONFIG_PATH });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "list_ads_accounts",
  {
    description:
      "List ads accounts visible as the current (or overridden) x-as-user.",
    inputSchema: {
      as_user: asUserOpt,
      count: z.number().int().min(1).max(1000).optional(),
      cursor: z.string().optional(),
    },
  },
  async ({ as_user, count, cursor }) => {
    try {
      const data = await adsRequest({
        path: "/accounts",
        as_user,
        query: { count, cursor },
      });
      return jsonResult({
        as_user: resolveAsUser(as_user),
        ...((data as object) ?? {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "list_campaigns",
  {
    description:
      "List campaigns for an ads account using employee x-as-user impersonation.",
    inputSchema: {
      account_id: accountIdOpt,
      as_user: asUserOpt,
      campaign_ids: z.string().optional().describe("Comma-separated campaign IDs."),
      count: z.number().int().min(1).max(1000).optional(),
      cursor: z.string().optional(),
      with_deleted: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const accountId = resolveAccountId(args.account_id);
      const data = await adsRequest({
        path: `/accounts/${accountId}/campaigns`,
        as_user: args.as_user,
        query: {
          campaign_ids: args.campaign_ids,
          count: args.count,
          cursor: args.cursor,
          with_deleted: args.with_deleted,
        },
      });
      return jsonResult({
        as_user: resolveAsUser(args.as_user),
        account_id: accountId,
        ...((data as object) ?? {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_campaign",
  {
    description: "Get one campaign by id.",
    inputSchema: {
      campaign_id: z.string(),
      account_id: accountIdOpt,
      as_user: asUserOpt,
      with_deleted: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const accountId = resolveAccountId(args.account_id);
      const data = await adsRequest({
        path: `/accounts/${accountId}/campaigns/${args.campaign_id}`,
        as_user: args.as_user,
        query: { with_deleted: args.with_deleted },
      });
      return jsonResult({
        as_user: resolveAsUser(args.as_user),
        account_id: accountId,
        ...((data as object) ?? {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "list_line_items",
  {
    description: "List line items for an ads account (optionally scoped to a campaign).",
    inputSchema: {
      account_id: accountIdOpt,
      as_user: asUserOpt,
      campaign_ids: z.string().optional().describe("Comma-separated campaign IDs."),
      line_item_ids: z.string().optional().describe("Comma-separated line item IDs."),
      count: z.number().int().min(1).max(1000).optional(),
      cursor: z.string().optional(),
      with_deleted: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const accountId = resolveAccountId(args.account_id);
      const data = await adsRequest({
        path: `/accounts/${accountId}/line_items`,
        as_user: args.as_user,
        query: {
          campaign_ids: args.campaign_ids,
          line_item_ids: args.line_item_ids,
          count: args.count,
          cursor: args.cursor,
          with_deleted: args.with_deleted,
        },
      });
      return jsonResult({
        as_user: resolveAsUser(args.as_user),
        account_id: accountId,
        ...((data as object) ?? {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_active_entities",
  {
    description:
      "List which ads entities had metrics activity in a time window (useful before stats).",
    inputSchema: {
      entity: z.enum([
        "CAMPAIGN",
        "FUNDING_INSTRUMENT",
        "LINE_ITEM",
        "MEDIA_CREATIVE",
        "PROMOTED_ACCOUNT",
        "PROMOTED_TWEET",
      ]),
      start_time: z.string().describe("ISO 8601 start, e.g. 2026-08-01T00:00:00Z"),
      end_time: z.string().describe("ISO 8601 end (exclusive)"),
      account_id: accountIdOpt,
      as_user: asUserOpt,
      entity_ids: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const accountId = resolveAccountId(args.account_id);
      const data = await adsRequest({
        path: `/stats/accounts/${accountId}/active_entities`,
        as_user: args.as_user,
        query: {
          entity: args.entity,
          start_time: args.start_time,
          end_time: args.end_time,
          entity_ids: args.entity_ids,
        },
      });
      return jsonResult({
        as_user: resolveAsUser(args.as_user),
        account_id: accountId,
        ...((data as object) ?? {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_account_stats",
  {
    description: "Synchronous analytics (impressions, engagements, spend, etc.).",
    inputSchema: {
      entity: z.enum([
        "ACCOUNT",
        "CAMPAIGN",
        "FUNDING_INSTRUMENT",
        "LINE_ITEM",
        "MEDIA_CREATIVE",
        "PROMOTED_ACCOUNT",
        "PROMOTED_TWEET",
        "ORGANIC_TWEET",
      ]),
      entity_ids: z.string().describe("Comma-separated entity IDs (max 20)."),
      start_time: z.string(),
      end_time: z.string(),
      granularity: z.enum(["DAY", "HOUR", "TOTAL"]),
      metric_groups: z
        .string()
        .describe("Comma-separated groups, e.g. ENGAGEMENT,BILLING,VIDEO"),
      placement: z.enum(["ALL_ON_TWITTER", "PUBLISHER_NETWORK"]),
      account_id: accountIdOpt,
      as_user: asUserOpt,
    },
  },
  async (args) => {
    try {
      const accountId = resolveAccountId(args.account_id);
      const data = await adsRequest({
        path: `/stats/accounts/${accountId}`,
        as_user: args.as_user,
        query: {
          entity: args.entity,
          entity_ids: args.entity_ids,
          start_time: args.start_time,
          end_time: args.end_time,
          granularity: args.granularity,
          metric_groups: args.metric_groups,
          placement: args.placement,
        },
      });
      return jsonResult({
        as_user: resolveAsUser(args.as_user),
        account_id: accountId,
        ...((data as object) ?? {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "ads_api_get",
  {
    description:
      "Escape hatch: GET any Ads API v12 path (e.g. /accounts/{id}/funding_instruments) with the current x-as-user.",
    inputSchema: {
      path: z
        .string()
        .describe("Path under /12, starting with /, e.g. /accounts/18ce55vdy8s/funding_instruments"),
      as_user: asUserOpt,
      skip_as_user: z
        .boolean()
        .optional()
        .describe("If true, do not send x-as-user (debug / compare with personal token)."),
      query_json: z
        .string()
        .optional()
        .describe('Optional JSON object of query params, e.g. {"count":10}'),
    },
  },
  async ({ path, as_user, skip_as_user, query_json }) => {
    try {
      let query: Record<string, string | number | boolean> | undefined;
      if (query_json) {
        query = JSON.parse(query_json) as Record<string, string | number | boolean>;
      }
      const data = await adsRequest({
        path,
        as_user,
        skip_as_user: Boolean(skip_as_user),
        query,
      });
      return jsonResult({
        as_user: skip_as_user ? null : resolveAsUser(as_user),
        path,
        ...((typeof data === "object" && data !== null ? data : { data }) as object),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
