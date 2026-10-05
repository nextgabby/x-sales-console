/**
 * Demo mode: the console runs against a generated advertiser universe instead of the X Ads API.
 *
 * This exists so the tool can be put behind a URL for people to click without any of the things
 * that make a hosted copy risky — no advertiser data leaves X, no rep pastes app secrets into a
 * server somebody else operates, and there is nothing stored to be stolen. Anyone who needs real
 * figures runs the local launcher, where their credentials never leave their own machine.
 *
 * The data is **generated, not anonymised real data**. Scaling down a real account still leaves
 * its fingerprints: campaign counts, naming conventions, the shape of a spend curve and the ratio
 * between objectives are all recognisable to anyone who knows the advertiser. Generated figures
 * carry no information about any real brand at all, which is a stronger guarantee than scrubbing.
 */
export function isDemoMode(): boolean {
  const flag = process.env.DEMO_MODE?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

/**
 * Whether demo mode calls xAI for real.
 *
 * Off by default, and deliberately so: the demo URL is open, the xAI key belongs to whoever
 * deployed it, and a model call is the one thing in this app that costs money per request. Canned
 * answers show the feature without handing an open URL a billable endpoint. Set `DEMO_AI=live`
 * to turn it on once there is a reason to.
 */
export function isDemoAiLive(): boolean {
  return isDemoMode() && process.env.DEMO_AI?.trim().toLowerCase() === "live";
}
