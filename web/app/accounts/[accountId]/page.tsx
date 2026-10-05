import { Suspense } from "react";

import { DashboardView } from "./dashboard-view";

export const dynamic = "force-dynamic";

export default async function AccountDashboardPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;

  // DashboardView reads the range and asUser from the query string via useSearchParams.
  return (
    <Suspense fallback={null}>
      <DashboardView accountId={accountId} />
    </Suspense>
  );
}
