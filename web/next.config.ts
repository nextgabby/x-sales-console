import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The MCP server at the repo root has its own lockfile, so pin the root to this app.
  turbopack: {
    root: path.resolve(__dirname),
  },
  /**
   * The OAuth callback is registered against 127.0.0.1, so that is the host people actually browse.
   * Next treats it as a different origin from its own `localhost` dev server and blocks hot-reload
   * resources, which leaves the page shell rendered but never hydrated — the dashboard sits empty
   * with nothing in the console to explain why.
   */
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
