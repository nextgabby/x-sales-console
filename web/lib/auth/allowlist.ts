import { isHosted } from "../db";
import { normalizeHandle } from "../store";

/**
 * Who is allowed to use a hosted deployment.
 *
 * `ALLOWED_HANDLES` is a comma-separated list of X handles, with or without the leading `@`, matched
 * case-insensitively. It is checked when someone signs in *and* on every authenticated request, so
 * removing a name takes effect on the next request rather than whenever that person's session
 * happens to expire.
 *
 * It is the only thing standing between a public URL and other companies' advertising data, so the
 * failure mode is chosen accordingly: a hosted deployment with no list configured admits nobody.
 * Defaulting to open would mean one missed environment variable silently publishes everything, and
 * that is not a mistake anyone would notice from the outside.
 */
export function allowedHandles(): string[] {
  return (process.env.ALLOWED_HANDLES ?? "")
    .split(",")
    .map((entry) => normalizeHandle(entry).toLowerCase())
    .filter(Boolean);
}

export type AllowDecision =
  | { allowed: true }
  | { allowed: false; reason: "not-configured" | "not-listed" };

export function checkHandle(handle: string | null | undefined): AllowDecision {
  /**
   * Locally there is no list and no need for one: the only person who can reach the app is whoever
   * is sitting at the machine, and they authorize with their own X account either way.
   */
  if (!isHosted()) return { allowed: true };

  const list = allowedHandles();
  if (list.length === 0) return { allowed: false, reason: "not-configured" };

  const candidate = normalizeHandle(handle ?? "").toLowerCase();
  if (!candidate || !list.includes(candidate)) return { allowed: false, reason: "not-listed" };

  return { allowed: true };
}

/** What to tell someone who was refused. Deliberately specific: the alternative is a silent loop. */
export function denialMessage(reason: "not-configured" | "not-listed", handle?: string | null) {
  if (reason === "not-configured") {
    return (
      "This deployment has no ALLOWED_HANDLES set, so nobody can sign in. " +
      "Whoever runs it needs to add your handle to that list."
    );
  }
  return (
    `@${normalizeHandle(handle ?? "")} is not on this deployment's access list, so nothing was ` +
    `saved and no advertiser data was read. Ask whoever runs it to add your handle.`
  );
}
