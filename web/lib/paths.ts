import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Data lives outside the repo by default so a `git clean` or a re-clone cannot wipe a
 * rep's stored authorization. Override with DATA_DIR when running throwaway instances.
 */
export const DATA_DIR =
  process.env.DATA_DIR?.trim() || join(homedir(), ".x-ads-sales-console");

export const CACHE_DIR = join(DATA_DIR, "cache");
