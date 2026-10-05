import { createHmac, randomBytes } from "node:crypto";

export type OAuth1Credentials = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
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

export function buildOAuth1AuthorizationHeader(
  method: string,
  url: string,
  creds: OAuth1Credentials,
): string {
  const parsed = new URL(url);
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const signParams: Record<string, string> = { ...oauthParams };
  parsed.searchParams.forEach((value, key) => {
    signParams[key] = value;
  });

  const baseString = buildSignatureBaseString(method, baseUrl, signParams);
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");
  oauthParams.oauth_signature = signature;

  const header = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key]!)}"`)
    .join(", ");

  return `OAuth ${header}`;
}
