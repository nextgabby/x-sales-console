# ATS Ads Sales Console

Campaign performance for the advertiser accounts you already have access to, in one place, with the
comparisons you would otherwise build by hand. It signs in as you, so you see exactly the accounts
you have been granted and nothing else.

**→ https://x-ads-sales-console.onrender.com**

---

## Getting in — about five minutes

**1. Get your handle approved.** Sign-in is limited to an approved list. Send your work X handle (the
one you use for Ads Manager) to IYKYK first, or the sign-in will refuse you.

**2. Click "Authorize with X."** That is the whole of it. There are no keys to create, nothing to
paste, no developer account, no install. X will ask you to approve read access to your ad accounts.

**3. Add the advertisers you can spy into.** The Ads API has no way to answer "which accounts am I
spied into," so the list has to be entered once. Enter the advertiser's handle — the ad account ID is
optional, and if you leave it out, every account under that handle is checked and the ones you can
open are kept. There is a link through to your spy list if you need to look an account up, and a
paste box if you are adding several at once.

Granting yourself spy access in the spy manager does **not** make an account appear here. You have to
add it. Spy access is per ad account, so if you have just been granted it, give it a moment.

That is it. Everything after this is reading.

---

## What you get

**Account dashboard.** Spend, impressions, engagements, engagement rate, clicks, CTR, CPM, CPE and
CPC, each against the prior period, over 7, 14, 30 or 90 days. Every campaign in a sortable table
below it.

**Budget pacing.** What the advertiser has committed, what they are on track to actually spend, and
what is projected to go unspent. Per campaign: how much of the budget is gone against how much of the
flight is gone, and a recommended daily budget to deliver in full by the end date. Campaigns that
have stopped delivering, or never started, are called out separately — that is the conversation worth
having before the flight ends rather than after.

**Versus the brand's own history.** Open any campaign and it is compared against the advertiser's
other campaigns on the same objective: the weighted figure, the usual range across individual
campaigns, and where this one sits in it. When the last 90 days are too thin to say anything, it
reaches back up to a year and tells you it has done so. This is the number to quote — it is the
brand's own track record, not an industry average.

**Creative performance.** Every promoted post with its actual render, its spend and its rates, so you
can see which creative carried the campaign. Rejected creative is flagged, which is usually the
explanation for a campaign that looks broken.

**Where and who it reached.** Device and placement breakdown, delivered age and gender bands as X
measured them rather than as the campaign declared them, and what the campaign was actually set to
target.

**Compare mode.** Tick several campaigns and put them side by side.

**Grok.** On any panel, a written summary and a question box. It only ever gets the figures already
on your screen, pre-computed, and is told to use them as given rather than do its own arithmetic or
eyeball a creative and guess — and to say when a comparison has too little behind it to support a
conclusion instead of producing one anyway.

---

## Label your custom buys

Two kinds of campaign do not behave like an ordinary auction buy, and nothing in the Ads API marks
them, so the console cannot know unless you say. Open a campaign and set its label once.

**Trend Genius** — delivers only when a matching trend fires. Labelling it stops the console calling
it "behind pace" for gaps that are how the buy works, while still tracking budget at risk, because a
commitment that is not being triggered may genuinely go unspent.

**L4R** and **Custom** — anything Creative Strategy built. These deliver continuously and are paced
normally, but labelling one changes what it is measured against, and gives you two readings:

- **Against the brand's standard buys** on the same objective — did bespoke creative beat a regular
  campaign? This is the number for the advertiser.
- **Against the brand's other campaigns with the same label** — L4R against L4R, Custom against
  Custom. Is this particular execution the good one? This is the number for Creative Strategy.

Those two often disagree, and both are shown. Labelled campaigns also get cost per like and cost per
repost, which cost per engagement hides — a like, a link click and a card expand all count as one
engagement, so it cannot tell an amplification unit from a traffic one.

---

## Worth knowing

**The last three days of spend are provisional**, and X can revise billing for up to 14 days. The
dashboard says so where it matters. Worth a beat before you quote a very recent number.

**It only reads.** There are no write paths in it at all — nothing in here can change a campaign, a
budget or a creative, by design.

**It is your access, not shared access.** Every request is signed with your own token. You cannot see
an account you have not been granted, and nobody sees yours.

---

Tell us what is wrong, missing, or not worth the screen space — particularly anything you still have
to leave the tool to work out.
