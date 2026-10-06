/**
 * Prints exactly what the Ads API says when GET /accounts is refused.
 *
 * The accounts route maps 401 and 403 to "not-connected" so the UI can offer to re-authorize, which
 * is right for the common case but throws away X's own explanation — and that explanation is the
 * only thing that distinguishes "your token is stale" from "this app is not approved for the Ads
 * API" from "this app is read-only". This asks once, directly, and prints the body.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/diagnose-access.mjs
 */
import { listUsers, resolveCredentials } from "../lib/store/index.ts";
import { buildOAuth1AuthorizationHeader } from "../lib/x/oauth1.ts";

const users = await listUsers();
if (users.length === 0) {
  console.log("No stored authorization. Sign in first.");
  process.exit(1);
}

const user = users[0];
const credentials = await resolveCredentials(user.userId);
if (!credentials) {
  console.log("Could not resolve credentials. Are X_CONSUMER_KEY and X_CONSUMER_SECRET set?");
  process.exit(1);
}

// Masked: enough to tell which app is in play without putting a key on screen.
const mask = (value) => `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
console.log(`signed in as   @${user.handle} (${user.userId})`);
console.log(`consumer key   ${mask(credentials.consumerKey)}`);
console.log(`access token   ${mask(credentials.accessToken)}`);
console.log();

for (const url of [
  "https://ads-api.x.com/12/accounts",
  // The plain API, as a control: it answers for any valid token regardless of Ads API approval, so
  // if this succeeds while the one above fails, the token is fine and the app's access is not.
  "https://api.x.com/1.1/account/verify_credentials.json",
]) {
  const response = await fetch(url, {
    headers: {
      Authorization: buildOAuth1AuthorizationHeader("GET", url, {
        consumerKey: credentials.consumerKey,
        consumerSecret: credentials.consumerSecret,
        token: credentials.accessToken,
        tokenSecret: credentials.accessTokenSecret,
      }),
    },
    cache: "no-store",
  });

  const text = await response.text();
  console.log(`${response.status}  GET ${url}`);
  console.log(text.slice(0, 600).replace(/^/gm, "      "));
  console.log();
}
