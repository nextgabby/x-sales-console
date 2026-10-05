import { buildOAuth1AuthorizationHeader } from "./oauth1";
import { appUrl } from "./origin";

const OAUTH_BASE = "https://api.x.com/oauth";

export type RequestTokenResult = { token: string; tokenSecret: string };

export type AccessTokenResult = {
  accessToken: string;
  accessTokenSecret: string;
  userId: string;
  handle: string;
};

/**
 * The callback must be registered verbatim in the rep's own app settings, and X requires
 * 127.0.0.1 rather than localhost for local development.
 */
export function callbackUrl(): string {
  return appUrl("/api/auth/callback");
}

function parseFormEncoded(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  new URLSearchParams(body).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function postOAuth(
  path: string,
  consumer: { key: string; secret: string },
  extraOAuthParams: Record<string, string>,
  token?: { value: string; secret: string },
): Promise<Record<string, string>> {
  const url = `${OAUTH_BASE}/${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: buildOAuth1AuthorizationHeader(
        "POST",
        url,
        {
          consumerKey: consumer.key,
          consumerSecret: consumer.secret,
          token: token?.value,
          tokenSecret: token?.secret,
        },
        extraOAuthParams,
      ),
    },
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`X rejected ${path} (${response.status}): ${text.slice(0, 300)}`);
  }
  return parseFormEncoded(text);
}

export async function fetchRequestToken(consumer: {
  key: string;
  secret: string;
}): Promise<RequestTokenResult> {
  const parsed = await postOAuth("request_token", consumer, {
    oauth_callback: callbackUrl(),
  });

  if (parsed.oauth_callback_confirmed !== "true" || !parsed.oauth_token) {
    throw new Error(
      `X did not confirm the callback URL. Add ${callbackUrl()} to your app's callback URLs on developer.x.com, then try again.`,
    );
  }

  return { token: parsed.oauth_token, tokenSecret: parsed.oauth_token_secret ?? "" };
}

export function authorizeUrl(requestToken: string): string {
  return `${OAUTH_BASE}/authorize?oauth_token=${encodeURIComponent(requestToken)}`;
}

export async function exchangeVerifier(params: {
  consumer: { key: string; secret: string };
  requestToken: string;
  requestTokenSecret: string;
  verifier: string;
}): Promise<AccessTokenResult> {
  const parsed = await postOAuth(
    "access_token",
    params.consumer,
    { oauth_verifier: params.verifier },
    { value: params.requestToken, secret: params.requestTokenSecret },
  );

  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error("X did not return an access token. Restart the connection flow.");
  }

  return {
    accessToken: parsed.oauth_token,
    accessTokenSecret: parsed.oauth_token_secret,
    // X returns these alongside the token, so identity needs no extra API call.
    userId: parsed.user_id ?? "",
    handle: parsed.screen_name ?? "",
  };
}

export type XProfile = { displayName?: string; avatarUrl?: string; handle?: string };

/** Display-only enrichment. Failure here must not block a successful connection. */
export async function fetchProfile(credentials: {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}): Promise<XProfile> {
  const url = "https://api.x.com/2/users/me?user.fields=profile_image_url";
  try {
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
    if (!response.ok) return {};
    const payload = (await response.json()) as {
      data?: { name?: string; username?: string; profile_image_url?: string };
    };
    return {
      displayName: payload.data?.name,
      handle: payload.data?.username,
      avatarUrl: payload.data?.profile_image_url?.replace("_normal", "_bigger"),
    };
  } catch {
    return {};
  }
}
