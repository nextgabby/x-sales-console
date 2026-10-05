import Link from "next/link";
import { Suspense } from "react";

import { isDemoMode } from "@/lib/demo/mode";
import { SetupWizard } from "./setup-wizard";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      {/* Every control in the wizard writes credentials to disk, which a demo deployment has none
          of and cannot accept. Explaining that is more use than a form that refuses to submit. */}
      {isDemoMode() ? (
        <DemoSetupNotice />
      ) : (
        <Suspense fallback={null}>
          <SetupWizard />
        </Suspense>
      )}
    </main>
  );
}

function DemoSetupNotice() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold tracking-tight">This is a demo</h1>
      <p className="text-sm text-muted">
        There is nothing to set up. This deployment is not connected to the X Ads API and holds no
        credentials — the advertisers, campaigns and figures it shows are generated, and nothing you
        do here is saved.
      </p>
      <p className="text-sm text-muted">
        To use the console against real accounts, run it locally. You sign in with your own X
        account, add your own developer app keys, and the data never leaves your machine.
      </p>
      <Link
        href="/accounts"
        className="inline-block rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white"
      >
        Back to the demo
      </Link>
    </div>
  );
}
