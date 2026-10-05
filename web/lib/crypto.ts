import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./paths";

const KEY_PATH = join(DATA_DIR, "master.key");
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

let cachedKey: Buffer | null = null;

/**
 * Hosted deployments must supply the key here. A container filesystem does not survive a redeploy,
 * so the generated file below would be replaced by a fresh key on every deploy and every stored
 * token would become permanently undecryptable — reps silently logged out, with a corrupt-secret
 * error as the only clue. Generate one with `openssl rand -base64 32`.
 *
 * Changing it has the same effect as losing it: everyone re-authorizes. It is the one secret in the
 * deployment that cannot be rotated casually.
 */
function envKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY?.trim();
  if (!raw) return null;

  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must be 32 bytes, base64 encoded. Generate one with `openssl rand -base64 32`.",
    );
  }
  return key;
}

/**
 * Falls back to a 0600 file next to the encrypted data rather than a passphrase the rep types on
 * every start. That protects a copied data directory but not a compromised machine account, which
 * is the documented limit of this design — and the reason the hosted path uses the environment.
 */
function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = envKey();
  if (fromEnv) {
    cachedKey = fromEnv;
    return fromEnv;
  }

  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  if (!existsSync(KEY_PATH)) {
    const generated = randomBytes(32);
    writeFileSync(KEY_PATH, generated.toString("base64"), { mode: 0o600 });
    cachedKey = generated;
    return generated;
  }

  const key = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "base64");
  if (key.length !== 32) {
    throw new Error(
      `Master key at ${KEY_PATH} is not 32 bytes. Delete it and reconnect to generate a new one (this invalidates stored tokens).`,
    );
  }
  chmodSync(KEY_PATH, 0o600);
  cachedKey = key;
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, loadMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [ivPart, tagPart, dataPart] = payload.split(".");
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error("Stored secret is malformed. Disconnect and reconnect to re-authorize.");
  }
  const decipher = createDecipheriv(ALGORITHM, loadMasterKey(), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Shown in the UI so a rep can confirm a key is stored without revealing it. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
