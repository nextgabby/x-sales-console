/** Where a rep can see which ad accounts they currently have spy access to. */
export const SPY_MANAGER_URL = "https://ads.x.com/manager/spy";

const HANDLE_IN_LINE = /@([A-Za-z0-9_]{1,15})/;
const ACCOUNT_ID = /^[0-9a-z]{4,12}$/;

export type SpyEntry = { accountId: string; handle: string };

export type ParsedPaste = {
  /** Account-scoped entries, the only ones that can be verified precisely. */
  entries: SpyEntry[];
  /** Handles seen without an adjacent account ID. */
  bareHandles: string[];
};

/**
 * Parses a block copied from the spy manager, which lists each account as
 * "Display Name @handle" on one line and the account ID on the next.
 *
 * Spy access is granted per ad account rather than per advertiser, so pairing each handle
 * with its account ID matters: adding a handle alone would pull in every account that
 * advertiser can see, most of which the rep is not authorized to open.
 */
export function parseSpyPaste(input: string): ParsedPaste {
  const entries = new Map<string, SpyEntry>();
  const pairedHandles = new Set<string>();
  const seenHandles: string[] = [];
  let currentHandle: string | null = null;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const handleMatch = HANDLE_IN_LINE.exec(line);
    if (handleMatch?.[1]) {
      currentHandle = handleMatch[1];
      if (!seenHandles.includes(currentHandle)) seenHandles.push(currentHandle);

      // Handle and ID sometimes land on the same line depending on how it was copied.
      const trailing = line.slice(handleMatch.index + handleMatch[0].length).trim();
      if (ACCOUNT_ID.test(trailing)) {
        entries.set(trailing, { accountId: trailing, handle: currentHandle });
        pairedHandles.add(currentHandle);
        continue;
      }
      continue;
    }

    if (currentHandle && ACCOUNT_ID.test(line)) {
      entries.set(line, { accountId: line, handle: currentHandle });
      pairedHandles.add(currentHandle);
    }
  }

  return {
    entries: [...entries.values()],
    bareHandles: seenHandles.filter((handle) => !pairedHandles.has(handle)),
  };
}
