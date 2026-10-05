import {
  getAuthMode,
  getOAuth1Credentials,
  getOAuth2AccessToken,
  resolveAsUser,
} from "./config.js";
import { buildOAuth1AuthorizationHeader } from "./oauth1.js";

const API_BASE = process.env.X_ADS_API_BASE?.replace(/\/$/, "") || "https://ads-api.x.com/12";

export type AdsRequestOptions = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  as_user?: string;
  /** When true, omit x-as-user (useful to compare against personal-token behavior). */
  skip_as_user?: boolean;
};

function buildUrl(path: string, query?: AdsRequestOptions["query"]): string {
  const url = new URL(
    path.startsWith("http") ? path : `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`,
  );
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function buildAuthorizationHeader(method: string, url: string): string {
  const oauth1 = getOAuth1Credentials();
  if (oauth1) {
    return buildOAuth1AuthorizationHeader(method, url, oauth1);
  }
  const oauth2 = getOAuth2AccessToken();
  if (oauth2) {
    return `Bearer ${oauth2}`;
  }
  getAuthMode(); // throws with a clear message
  throw new Error("unreachable");
}

export async function adsRequest<T = unknown>(opts: AdsRequestOptions): Promise<T> {
  const asUser = opts.skip_as_user ? null : resolveAsUser(opts.as_user);
  const method = opts.method ?? "GET";
  const url = buildUrl(opts.path, opts.query);

  const headers: Record<string, string> = {
    Authorization: buildAuthorizationHeader(method, url),
    Accept: "application/json",
  };
  if (asUser) {
    headers["x-as-user"] = asUser;
  }

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }

  if (!res.ok) {
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const detail = {
      status: res.status,
      statusText: res.statusText,
      auth_mode: getOAuth1Credentials() ? "oauth1" : "oauth2",
      as_user: asUser,
      body: parsed,
      response_headers: responseHeaders,
    };
    throw new Error(
      `Ads API ${method} ${url} failed (${res.status}): ${JSON.stringify(detail, null, 2)}`,
    );
  }

  return parsed as T;
}

export function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}
