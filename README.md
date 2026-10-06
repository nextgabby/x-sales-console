# x-ads-as-user

Two things live in this folder, for two different audiences:

| If you want to | Read | Who it is for |
| --- | --- | --- |
| **See campaign dashboards in a browser** | **[START-HERE.md](START-HERE.md)** | Sales. No terminal, no config files. |
| Query the Ads API from Cursor | [SETUP.md](SETUP.md) | Anyone comfortable with an MCP server |

The rest of this file is about the MCP server. For the sales console, start with
[START-HERE.md](START-HERE.md) — or just double-click `start-console.command`.

---

Local Cursor MCP for X Ads that signs with **OAuth 1.0a** and sends `x-as-user` on every request (employee LDAP / Postman-style access).

Got this as a zip? Follow **SETUP.md**.

## 1. Add credentials

Copy `.env.example` to `.env` in this folder, then paste your keys.

```bash
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_TOKEN_SECRET=...
```

Copy from `.env.example` if needed. These are the same four OAuth 1.0a values from the X developer portal (API Key/Secret + Access Token/Secret).

## 2. Switch advertisers often

Defaults live in `as-user.config.json` (gitignored):

```json
{
  "as_user": "CoyoteACMEMovie",
  "account_id": "18ce55vdy8s"
}
```

Or in chat:
- `set_as_user` / `set_account`
- pass `as_user` / `account_id` on any tool for a one-off

## Tools

`get_context`, `set_as_user`, `set_account`, `list_ads_accounts`, `list_campaigns`, `get_campaign`, `list_line_items`, `get_active_entities`, `get_account_stats`, `ads_api_get`

## Cursor MCP

Add a **stdio** block named `x-ads-as-user` inside the existing `"mcpServers"` object in `~/.cursor/mcp.json`. Do not replace the whole file (you may already have `x-ads` as a `url` server). After editing `.env`, toggle that MCP in Cursor settings.

```bash
npm install --registry https://registry.npmjs.org
npm run build
```
# x-sales-console
