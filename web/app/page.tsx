import { redirect } from "next/navigation";

import { readConnection } from "@/lib/store";

export const dynamic = "force-dynamic";

export default function Home() {
  const connection = readConnection();
  const isConnected = Boolean(connection?.accessToken && connection?.accessTokenSecret);
  redirect(isConnected ? "/accounts" : "/setup");
}
