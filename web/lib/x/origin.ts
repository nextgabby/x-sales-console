/**
 * X treats 127.0.0.1 and localhost as different origins, and only the registered callback
 * URL works. Redirects are built from this single value so a rep never gets bounced to the
 * other spelling partway through the handshake.
 *
 * `RENDER_EXTERNAL_URL` is the host's own idea of where the service lives, which makes it a better
 * default than the local address when deployed. An explicit `APP_ORIGIN` still wins, for a custom
 * domain — but without the fallback, forgetting to set it produces a handshake that redirects to
 * localhost and fails in a way that looks nothing like a missing environment variable.
 */
export function appOrigin(): string {
  const configured = process.env.APP_ORIGIN?.trim() || process.env.RENDER_EXTERNAL_URL?.trim();
  return configured?.replace(/\/$/, "") || "http://127.0.0.1:3000";
}

export function appUrl(path: string): string {
  return `${appOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}
