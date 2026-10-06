/**
 * Does `x-as-user` accept a numeric user id, or only a handle?
 *
 * Not documented publicly, and it decides whether a rep can paste a spy manager URL — those carry
 * `user_id=` rather than a handle, so if the numeric form works the URL needs no translation at all.
 *
 *   node --import ./scripts/ts-hook.mjs scripts/probe-as-user.mjs <accountId> <userIdOrHandle>...
 */
import { listUsers, resolveCredentials } from "../lib/store/index.ts";
import { buildOAuth1AuthorizationHeader } from "../lib/x/oauth1.ts";

const [accountId, ...subjects] = process.argv.slice(2);
if (!accountId || subjects.length === 0) {
  console.log("usage: probe-as-user.mjs <accountId> <userIdOrHandle>...");
  process.exit(1);
}

const user = (await listUsers())[0];
const credentials = await resolveCredentials(user.userId);

async function signedGet(url, asUser) {
  const headers = {
    Authorization: buildOAuth1AuthorizationHeader("GET", url, {
      consumerKey: credentials.consumerKey,
      consumerSecret: credentials.consumerSecret,
      token: credentials.accessToken,
      tokenSecret: credentials.accessTokenSecret,
    }),
  };
  if (asUser) headers["x-as-user"] = asUser;
  const response = await fetch(url, { headers, cache: "no-store" });
  return { status: response.status, text: await response.text() };
}

for (const subject of subjects) {
  const { status, text } = await signedGet(
    `https://ads-api.x.com/12/accounts/${accountId}`,
    subject,
  );
  let summary = text.slice(0, 160);
  try {
    const body = JSON.parse(text);
    summary = body.data
      ? `name=${JSON.stringify(body.data.name)} timezone=${body.data.timezone}`
      : (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ").slice(0, 200);
  } catch {
    /* keep the raw slice */
  }
  console.log(`x-as-user: ${subject.padEnd(22)} -> ${status}  ${summary}`);
}
