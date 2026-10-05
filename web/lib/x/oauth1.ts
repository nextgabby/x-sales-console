import { createHmac, randomBytes } from "node:crypto";

export type OAuth1Signer = {
  consumerKey: string;
  consumerSecret: string;
  /** Absent during the first leg of the handshake, where no token exists yet. */
  token?: string;
  tokenSecret?: string;
};

export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildSignatureBaseString(
  method: string,
  baseUrl: string,
  params: Record<string, string>,
): string {
  const normalized = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key]!)}`)
    .join("&");
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(normalized)}`;
}

/**
 * Signs a request per OAuth 1.0a HMAC-SHA1.
 *
 * `extraOAuthParams` carries handshake-only values such as `oauth_callback` and
 * `oauth_verifier`, which must be part of the signature but are not query parameters.
 */
export function buildOAuth1AuthorizationHeader(
  method: string,
  url: string,
  signer: OAuth1Signer,
  extraOAuthParams: Record<string, string> = {},
): string {
  const parsed = new URL(url);
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: signer.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
    ...(signer.token ? { oauth_token: signer.token } : {}),
    ...extraOAuthParams,
  };

  const signParams: Record<string, string> = { ...oauthParams };
  parsed.searchParams.forEach((value, key) => {
    signParams[key] = value;
  });

  const baseString = buildSignatureBaseString(method, baseUrl, signParams);
  const signingKey = `${percentEncode(signer.consumerSecret)}&${percentEncode(
    signer.tokenSecret ?? "",
  )}`;
  oauthParams.oauth_signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  return `OAuth ${Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key]!)}"`)
    .join(", ")}`;
}
