import { redirect } from "next/navigation";

import { currentSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Resolving the session rather than merely checking for a token: an expired or revoked
  // connection, or a handle since taken off the allowlist, has to land on setup, not on accounts.
  redirect((await currentSession()) ? "/accounts" : "/setup");
}
