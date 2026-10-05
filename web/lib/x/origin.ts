/**
 * X treats 127.0.0.1 and localhost as different origins, and only the registered callback
 * URL works. Redirects are built from this single value so a rep never gets bounced to the
 * other spelling partway through the handshake.
 */
export function appOrigin(): string {
  return process.env.APP_ORIGIN?.replace(/\/$/, "") || "http://127.0.0.1:3000";
}

export function appUrl(path: string): string {
  return `${appOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}
