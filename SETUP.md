# x-ads-as-user — install from the zip

Internal only. This is the employee impersonation MCP (OAuth 1.0a + `x-as-user`), not the official advertiser Ads MCP.

## 1. Unzip

Put the folder somewhere permanent, e.g. `~/x-ads-as-user`. Don’t leave it in Downloads.

You need **Node.js** and **Cursor**.

## 2. Add your own credentials

```bash
cp .env.example .env
cp as-user.config.example.json as-user.config.json
```

Edit `.env` with **your** OAuth 1.0a values from developer.x.com → your app → Keys and tokens:

- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`

Do not reuse someone else’s `.env`. OAuth 2 bearer tokens usually will not impersonate.

Optional: set a default handle / ads account in `as-user.config.json`, or skip it and switch in chat.

## 3. Build

In the unzipped folder:

```bash
npm install --registry https://registry.npmjs.org
npm run build
```

## 4. Wire Cursor (merge, don’t replace)

Cursor Settings → Tools & MCP → **New MCP Server**. That opens `~/.cursor/mcp.json`. It is one file for **all** MCP servers.

Do **not** paste a whole new file. Do **not** copy the official Ads MCP block (`url` + `Authorization: Bearer …`). That is a different server.

Add **one object** inside the existing `"mcpServers": { … }` object. Put a comma after the previous server.

```json
"x-ads-as-user": {
  "type": "stdio",
  "command": "node",
  "args": ["/ABSOLUTE/PATH/x-ads-as-user/dist/index.js"]
}
```

Replace `/ABSOLUTE/PATH/...` with the real path on **your** machine, e.g. `/Users/you/x-ads-as-user/dist/index.js`. After `npm run build`, that file must exist.

If the file is empty, wrap it:

```json
{
  "mcpServers": {
    "x-ads-as-user": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/x-ads-as-user/dist/index.js"]
    }
  }
}
```

Two different shapes, both valid, both can live in the same file:

| Server | What it is | Looks like |
|---|---|---|
| `x-ads` | Official advertiser MCP (remote) | `"url": "https://ads-api.x.com/mcp"` + Bearer header |
| `x-ads-as-user` | This zip (local) | `"command": "node"` + path to `dist/index.js` |

If Cursor’s editor already added `"type": "stdio"`, leave it. If yours has only `command` / `args` and it is green, that is also fine.

If the server stays red, `node` may not be on PATH for the Cursor app — use the full Node path from `which node` (often `/opt/homebrew/bin/node` or `/usr/local/bin/node`).

Toggle the server off/on until it is green. After any `.env` change, toggle it again.

## 5. Try it

In chat:

> Set as-user to pixelsattack and list all ads accounts.

Handle has no `@`. `get_context` shows the current user, account, and whether OAuth 1 is loaded.

Writes (create campaign, etc.) belong on the **official Ads MCP**, not this one.
