import { isDemoAiLive, isDemoMode } from "@/lib/demo/mode";

/**
 * Says, on every page, that none of this is real.
 *
 * Fixed to the top of the viewport rather than placed in the flow, because the figures here look
 * exactly like the ones a live deployment shows, and a reviewer who scrolls past a banner once will
 * screenshot a dashboard of invented spend and send it to someone who never saw the banner at all.
 */
export function DemoBanner() {
  if (!isDemoMode()) return null;

  return (
    <div className="sticky top-0 z-50 border-b border-warn/40 bg-warn/10 px-4 py-2 text-center text-[13px] text-warn backdrop-blur">
      <span className="font-semibold">Demo</span> — every advertiser, campaign and number below is
      generated. No real account is connected and nothing is saved.
      {!isDemoAiLive() && " Grok answers are fixed sample text."}
    </div>
  );
}
