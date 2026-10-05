import { NextResponse } from "next/server";

import { parseSpyPaste, type SpyEntry } from "@/lib/handles";
import {
  normalizeHandle,
  readConnection,
  readSpyGrants,
  removeSpyGrant,
  removeSpyHandleGroup,
  resolveCredentials,
  saveSpyGrants,
  type SpyGrant,
} from "@/lib/store";
import { listSpyAccounts, verifySpyAccess } from "@/lib/x/accounts";

export const dynamic = "force-dynamic";

export type VerifyResult = {
  accountId: string;
  asUser: string;
  name: string | null;
  ok: boolean;
  reason: string | null;
};

export async function GET() {
  return NextResponse.json({ spyGrants: readSpyGrants() });
}

/**
 * Takes a block pasted from the spy manager and saves only the accounts that verify.
 *
 * Bare handles are expanded by listing the advertiser's accounts and checking each one,
 * because a handle alone says nothing about which of its accounts the rep may open.
 */
export async function POST(request: Request) {
  const credentials = resolveCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "not-connected" }, { status: 401 });
  }

  let payload: { text?: string; entries?: SpyEntry[] };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const auditHandle = readConnection()?.handle ?? null;
  const parsed = parseSpyPaste(payload.text ?? "");

  const candidates = new Map<string, SpyEntry>();
  for (const entry of [...parsed.entries, ...(payload.entries ?? [])]) {
    candidates.set(entry.accountId, {
      accountId: entry.accountId,
      handle: normalizeHandle(entry.handle),
    });
  }

  const expansionNotes: string[] = [];
  for (const handle of parsed.bareHandles) {
    try {
      const accounts = await listSpyAccounts(credentials, handle, auditHandle);
      for (const account of accounts) {
        if (!candidates.has(account.id)) {
          candidates.set(account.id, { accountId: account.id, handle });
        }
      }
      expansionNotes.push(
        `@${handle}: checking ${accounts.length} account${accounts.length === 1 ? "" : "s"}`,
      );
    } catch {
      expansionNotes.push(`@${handle}: could not list accounts for this advertiser.`);
    }
  }

  if (candidates.size === 0) {
    return NextResponse.json(
      {
        error:
          "No accounts found in that input. Copy the rows from the spy list so each advertiser handle is followed by its account ID.",
      },
      { status: 400 },
    );
  }

  const results: VerifyResult[] = [];
  const verified: SpyGrant[] = [];

  // Sequential: each candidate costs two API calls and a paste can hold dozens.
  for (const candidate of candidates.values()) {
    const outcome = await verifySpyAccess(
      credentials,
      candidate.accountId,
      candidate.handle,
      auditHandle,
    );

    if (!outcome.ok) {
      results.push({
        accountId: candidate.accountId,
        asUser: candidate.handle,
        name: null,
        ok: false,
        reason: outcome.reason,
      });
      continue;
    }

    verified.push({
      accountId: candidate.accountId,
      asUser: candidate.handle,
      name: outcome.account.name,
      timezone: outcome.account.timezone,
      approvalStatus: outcome.account.approval_status ?? null,
      addedAt: new Date().toISOString(),
    });
    results.push({
      accountId: candidate.accountId,
      asUser: candidate.handle,
      name: outcome.account.name,
      ok: true,
      reason: null,
    });
  }

  return NextResponse.json({
    spyGrants: verified.length > 0 ? saveSpyGrants(verified) : readSpyGrants(),
    results,
    notes: expansionNotes,
  });
}

export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  const accountId = params.get("accountId");
  const asUser = params.get("asUser");

  if (accountId) return NextResponse.json({ spyGrants: removeSpyGrant(accountId) });
  if (asUser) return NextResponse.json({ spyGrants: removeSpyHandleGroup(asUser) });

  return NextResponse.json(
    { error: "Provide accountId or asUser." },
    { status: 400 },
  );
}
