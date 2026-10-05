import { buildOAuth1AuthorizationHeader } from "./oauth1";
import { recordAudit, type XCredentials } from "../store";
import { ANONYMOUS_ACTOR, type Actor } from "../auth/actor";
import { demoAdsRequest } from "../demo/api";
import { isDemoMode } from "../demo/mode";

export const ADS_API_BASE =
  process.env.X_ADS_API_BASE?.replace(/\/$/, "") || "https://ads-api.x.com/12";

export type QueryValue = string | number | boolean | undefined | null;

export type AdsRequestOptions = {
  path: string;
  credentials: XCredentials;
  query?: Record<string, QueryValue>;
  /**
   * The async analytics endpoints create jobs with POST, and pass their parameters in the query
   * string rather than a body — so the only thing that changes is the OAuth signature base.
   */
  method?: "GET" | "POST";
  /**
   * Impersonation is opt-in. `GET /accounts` with a rep's own token already returns the
   * accounts they were granted, so the default path sends no `x-as-user` at all.
   */
  asUser?: string | null;
  /** Audit context only; does not affect the request. */
  audit?: { actor: Actor; accountId: string | null };
};

export class AdsApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly asUser: string | null;

  constructor(params: { status: number; body: unknown; path: string; asUser: string | null }) {
    super(`X Ads API returned ${params.status} for ${params.path}: ${describe(params.body)}`);
    this.name = "AdsApiError";
    this.status = params.status;
    this.body = params.body;
    this.asUser = params.asUser;
  }
}

function describe(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 400);
  const errors = (body as { errors?: Array<{ message?: string; code?: string }> })?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) => e.message || e.code).filter(Boolean).join("; ");
  }
  return JSON.stringify(body)?.slice(0, 400) ?? "no body";
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(
    path.startsWith("http")
      ? path
      : `${ADS_API_BASE}${path.startsWith("/") ? path : `/${path}`}`,
  );
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const MAX_ATTEMPTS = 4;

/**
 * Longest we will wait for a rate limit window to reset. Beyond this, waiting cannot help within
 * the life of a page load: a reset ten minutes out meant three 15s sleeps per request and a
 * 45-second response that still failed. Returning promptly lets the caller report partial data.
 */
const MAX_RATE_LIMIT_WAIT_MS = 4_000;

/** Delay before the next attempt, or null when retrying is not worth it. */
function retryDelayMs(attempt: number, status: number, headers: Headers): number | null {
  if (status === 429) {
    const reset =
      headers.get("x-account-rate-limit-reset") ?? headers.get("x-rate-limit-reset");
    const waitMs = reset ? Number(reset) * 1000 - Date.now() : NaN;
    if (!Number.isFinite(waitMs) || waitMs <= 0) return 1_000;
    return waitMs > MAX_RATE_LIMIT_WAIT_MS ? null : waitMs;
  }
  // Server errors are usually transient, so these keep the exponential backoff.
  return Math.min(2 ** attempt * 500, 8_000);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function adsRequest<T = unknown>(options: AdsRequestOptions): Promise<T> {
  const asUser = options.asUser?.trim().replace(/^@/, "") || null;
  const method = options.method ?? "GET";
  const actor = options.audit?.actor ?? ANONYMOUS_ACTOR;

  /**
   * The only exit from demo mode, placed before the URL is even built so there is no path by which
   * a demo deployment can reach ads-api.x.com. Everything downstream — the rollups, the benchmark,
   * the pacing arithmetic — runs exactly as it does against the real API. No audit entry is written:
   * nothing was accessed, and `recordAudit` appends synchronously, which would fail outright on a
   * host with a read-only filesystem.
   */
  if (isDemoMode()) {
    return demoAdsRequest({ method, path: options.path, query: options.query ?? {} }) as T;
  }

  const url = buildUrl(options.path, options.query);
  const startedAt = Date.now();
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const headers: Record<string, string> = {
      Authorization: buildOAuth1AuthorizationHeader(method, url, {
        consumerKey: options.credentials.consumerKey,
        consumerSecret: options.credentials.consumerSecret,
        token: options.credentials.accessToken,
        tokenSecret: options.credentials.accessTokenSecret,
      }),
      Accept: "application/json",
    };
    if (asUser) headers["x-as-user"] = asUser;

    const response = await fetch(url, { method, headers, cache: "no-store" });
    lastStatus = response.status;
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Leave as raw text; describe() handles it.
    }

    if (response.ok) {
      recordAudit({
        at: new Date().toISOString(),
        userId: actor.userId,
        handle: actor.handle,
        accountId: options.audit?.accountId ?? null,
        path: options.path,
        asUser,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return parsed as T;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS - 1) {
      const delay = retryDelayMs(attempt, response.status, response.headers);
      if (delay != null) {
        await sleep(delay);
        continue;
      }
    }

    recordAudit({
      at: new Date().toISOString(),
      userId: actor.userId,
      handle: actor.handle,
      accountId: options.audit?.accountId ?? null,
      path: options.path,
      asUser,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    throw new AdsApiError({
      status: response.status,
      body: parsed,
      path: options.path,
      asUser,
    });
  }

  throw new AdsApiError({
    status: lastStatus ?? 0,
    body: "Exhausted retries",
    path: options.path,
    asUser,
  });
}

type Paginated<T> = { data?: T[]; next_cursor?: string | null };

/** Follows `next_cursor` until exhausted, with a page cap so a bad cursor cannot loop forever. */
export async function adsRequestAll<T>(
  options: AdsRequestOptions,
  maxPages = 20,
): Promise<T[]> {
  const collected: T[] = [];
  let cursor: string | null | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await adsRequest<Paginated<T>>({
      ...options,
      query: { count: 1000, ...options.query, ...(cursor ? { cursor } : {}) },
    });
    collected.push(...(response.data ?? []));
    cursor = response.next_cursor;
    if (!cursor) break;
  }

  return collected;
}

/** The synchronous stats endpoint accepts at most 20 entity IDs per call. */
export function chunkEntityIds(ids: string[], size = 20): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}
