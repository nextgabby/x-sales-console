import { Suspense } from "react";

import { CompareView } from "./compare-view";

export const dynamic = "force-dynamic";

export default async function ComparePage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;

  // CompareView reads the selection, range and asUser from the query string.
  return (
    <Suspense fallback={null}>
      <CompareView accountId={accountId} />
    </Suspense>
  );
}
