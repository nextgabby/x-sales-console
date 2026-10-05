import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { isHosted } from "../db";
import { listUsers, getUser, resolveCredentials, type XCredentials } from "../store";
import { checkHandle } from "./allowlist";
import type { Actor } from "./actor";

/**
 * Who is making this request.
 *
 * The app began as a single-user local tool with one stored connection, which is exactly what makes
 * a shared deployment dangerous without this: every request would resolve the same credentials, so
 * one rep's token would read another rep's advertisers and the audit trail would name the wrong
 * person. Identity has to come from the request, which means a cookie.
 *
 * The cookie carries only the X user id, signed. The handle is read from storage rather than from the
 * cookie, so a rename cannot leave a stale name in an audit entry, and the allowlist is re-checked
 * against the stored handle on every request rather than trusted from the client.
 */

const COOKIE = "x_ads_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export type Session = {
  userId: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  credentials: XCredentials;
  /** Passed straight to every data fetch, so each Ads API call is attributed to this rep. */
  actor: Actor;
};

/**
 * Hosted deployments must set `SESSION_SECRET`; without it anyone could mint a cookie naming any
 * user id and read that rep's advertisers. Locally a random per-process secret is enough, because
 * the single-user fallback below means the cookie is a convenience rather than the security boundary.
 */
let fallbackSecret: string | null = null;

function secret(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters.");
    }
    return configured;
  }
  if (isHosted()) {
    throw new Error(
      "SESSION_SECRET is required when DATABASE_URL is set. Generate one with `openssl rand -base64 32`.",
    );
  }
  fallbackSecret ??= randomBytes(32).toString("base64");
  return fallbackSecret;
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function verify(value: string, signature: string): boolean {
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(signature);
  // Lengths must match before timingSafeEqual, which throws on a mismatch rather than returning false.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The signed cookie value: `<userId>.<signature>`. */
function encode(userId: string): string {
  return `${Buffer.from(userId).toString("base64url")}.${sign(userId)}`;
}

function decode(raw: string): string | null {
  const [encoded, signature] = raw.split(".");
  if (!encoded || !signature) return null;

  let userId: string;
  try {
    userId = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  return userId && verify(userId, signature) ? userId : null;
}

export async function startSession(userId: string): Promise<void> {
  (await cookies()).set(COOKIE, encode(userId), {
    httpOnly: true,
    sameSite: "lax",
    // Render terminates TLS, so the cookie must be marked secure there and must not be locally,
    // where the app is served over plain http and a secure cookie would simply never be sent.
    secure: isHosted(),
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** The signed-in user id, or null. Does not check the allowlist or load credentials. */
export async function sessionUserId(): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (raw) {
    const userId = decode(raw);
    if (userId) return userId;
  }

  /**
   * Local single-user fallback: with one stored connection and no database, the person at the
   * keyboard is unambiguously that user, so the local tool keeps working exactly as it did before
   * sessions existed — no cookie needed, and clearing cookies does not log anyone out.
   *
   * Gated on the file backend, so it can never apply to a hosted deployment where a missing cookie
   * must mean "not signed in" rather than "whoever happens to be in the database".
   */
  if (!isHosted()) {
    const users = await listUsers();
    if (users.length === 1) return users[0]!.userId;
  }

  return null;
}

/**
 * The full session, or null when the request is not authenticated, the rep is no longer stored, or
 * their handle is no longer on the allowlist.
 */
export async function currentSession(): Promise<Session | null> {
  const userId = await sessionUserId();
  if (!userId) return null;

  const user = await getUser(userId);
  if (!user) return null;

  // Re-checked per request, so removing a handle takes effect immediately rather than at expiry.
  if (!checkHandle(user.handle).allowed) return null;

  const credentials = await resolveCredentials(userId);
  if (!credentials) return null;

  return {
    userId: user.userId,
    handle: user.handle,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    credentials,
    actor: { userId: user.userId, handle: user.handle },
  };
}
