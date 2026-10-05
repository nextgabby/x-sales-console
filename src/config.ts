import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import type { OAuth1Credentials } from "./oauth1.js";

export type AsUserConfig = {
  as_user: string;
  account_id?: string;
  notes?: string;
};

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = join(rootDir, "as-user.config.json");
export const ENV_PATH = join(rootDir, ".env");

// Load project .env once at import time (does not override existing process.env).
loadDotenv({ path: ENV_PATH });

const DEFAULTS: AsUserConfig = {
  as_user: "CoyoteACMEMovie",
  account_id: "18ce55vdy8s",
};

export function loadConfig(): AsUserConfig {
  if (!existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULTS);
    return { ...DEFAULTS };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<AsUserConfig>;
    return {
      as_user: String(raw.as_user || DEFAULTS.as_user),
      account_id: raw.account_id ? String(raw.account_id) : undefined,
      notes: raw.notes,
    };
  } catch (err) {
    throw new Error(`Failed to read ${CONFIG_PATH}: ${String(err)}`);
  }
}

export function saveConfig(next: AsUserConfig): AsUserConfig {
  const cleaned: AsUserConfig = {
    as_user: next.as_user.trim().replace(/^@/, ""),
    ...(next.account_id ? { account_id: next.account_id.trim() } : {}),
    ...(next.notes ? { notes: next.notes } : {}),
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
  return cleaned;
}

export function resolveAsUser(override?: string): string {
  const value = (override ?? loadConfig().as_user ?? "").trim().replace(/^@/, "");
  if (!value) {
    throw new Error(
      "No as_user set. Call set_as_user, edit as-user.config.json, or pass as_user on the tool call.",
    );
  }
  return value;
}

export function resolveAccountId(override?: string): string {
  const value = (override ?? loadConfig().account_id ?? "").trim();
  if (!value) {
    throw new Error(
      "No account_id set. Call set_account, edit as-user.config.json, or pass account_id on the tool call.",
    );
  }
  return value;
}

export function getOAuth1Credentials(): OAuth1Credentials | null {
  const consumerKey = (process.env.X_API_KEY || process.env.TWITTER_CONSUMER_KEY || "").trim();
  const consumerSecret = (
    process.env.X_API_SECRET ||
    process.env.TWITTER_CONSUMER_SECRET ||
    ""
  ).trim();
  const accessToken = (
    process.env.X_ACCESS_TOKEN ||
    process.env.TWITTER_ACCESS_TOKEN ||
    ""
  ).trim();
  const accessTokenSecret = (
    process.env.X_ACCESS_TOKEN_SECRET ||
    process.env.TWITTER_ACCESS_TOKEN_SECRET ||
    ""
  ).trim();

  if (!consumerKey && !consumerSecret && !accessToken && !accessTokenSecret) {
    return null;
  }
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    throw new Error(
      "Incomplete OAuth 1.0a credentials in .env. Need all four: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.",
    );
  }
  return { consumerKey, consumerSecret, accessToken, accessTokenSecret };
}

export function getOAuth2AccessToken(): string | null {
  const token = (process.env.X_ADS_ACCESS_TOKEN || "").trim();
  return token || null;
}

export function getAuthMode(): "oauth1" | "oauth2" {
  if (getOAuth1Credentials()) return "oauth1";
  if (getOAuth2AccessToken()) return "oauth2";
  throw new Error(
    `No auth configured. Add OAuth 1.0a keys to ${ENV_PATH} (see .env.example).`,
  );
}
