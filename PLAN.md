# X Ads Sales Console — build plan

A dashboard for the sales org. Each rep runs it locally, connects their own X account, sees the
advertiser ad accounts they already have access to, opens any one of them for a full campaign
dashboard, compares campaigns side by side, and gets a Grok summary they can ask follow-up
questions about.

No rep uses anyone else's credentials, and nothing in the system routes through the author's keys.

**Decisions locked:** local-first (hosting comes later), Grok for AI, each rep supplies their own
consumer keys and then completes OAuth, roughly under 25 ad accounts per rep.

---

## 1. What exists today, and what has to change

This repo is currently a single-user Cursor MCP server: `src/oauth1.ts` signs OAuth 1.0a requests,
`src/client.ts` calls the Ads API, `src/index.ts` exposes ten read-only tools, and
`src/config.ts` reads one set of keys from `.env` plus one default handle from
`as-user.config.json`.

Two pieces port over essentially unchanged:

- **`src/oauth1.ts`** — the HMAC-SHA1 signing is correct and generic. Becomes `lib/x/oauth1.ts`.
- **The tool surface in `src/index.ts`** — the ten tools are a good inventory of the endpoints the
  dashboard needs, and they become the tool schema for the Grok Q&A layer in Phase 4.

Two pieces must be rewritten, and these are the load-bearing changes:

**Credentials become per-request instead of per-process.** Today `buildAuthorizationHeader` reads
`process.env` at call time, so the whole server shares one identity. The app needs `adsRequest` to
accept the calling rep's credentials as an argument. Everything in the data layer depends on this,
so it is the first task in Phase 0.

**`x-as-user` becomes optional instead of mandatory.** Today every request sends the header, which
is wrong for this app. Per the Ads API docs, `GET /12/accounts` called with a rep's *own* tokens and
*no* `x-as-user` returns exactly the ad accounts that rep has been granted access to — precisely the
"accounts I'm already spied into" list the app opens on. Impersonation stays available as a
per-account override for cases that need it, but it is no longer the default path.

This turned out to be more than a preference. Testing the same account both ways, the request
**with** `x-as-user` failed with `403 FORBIDDEN — "Cannot access spy for account"`, while the request
**without** it succeeded and returned everything. Sending the header unconditionally, as the MCP does
today, breaks access for exactly the accounts a rep holds directly.

## 2. Credentials, identity, and attribution

This is the part you were unsure about, so here is the design and why it gives you both things you
asked for.

**Setup, once per rep:** a first-run wizard asks for their **own** consumer key and secret, from
their own app on developer.x.com. Then they click Connect, which runs the OAuth 1.0a 3-legged flow
locally — `POST oauth/request_token` → `GET oauth/authorize` → `POST oauth/access_token` — and the
app stores the resulting access token and secret. We immediately call `verify_credentials` to
resolve their `@handle` and show "Connected as @them" in the UI.

That is exactly the "OAuth with their account and also put in their keys" shape you described, and
it is the right one. The keys they paste are the *app* credentials; the OAuth step mints the *user*
credentials. Both halves end up belonging to the rep.

**Why nothing comes back to you.** There is no shared consumer app and no shared access token. Every
Ads API request a rep makes is signed with their consumer key and their user token, so on X's side
the call is attributed to their app and their identity. Your credentials are not in the system at
all — so a rep cannot see an account you have access to unless they have their own access to it, and
no activity can be traced to you.

**Why the OAuth step rather than pasting all four values.** A developer app's built-in static access
token is just the app owner's own user token, so pasting all four technically works and we will
accept it as a fallback. But the 3-legged flow is better as the default: it avoids copy-pasting two
long secrets, it confirms the X identity we store for the audit log, and it matches the documented
path for reaching ad accounts owned by other advertisers.

**Setup friction to be aware of.** The callback URL must be registered in the rep's own app settings
before OAuth will work, and X requires `http://127.0.0.1` rather than `localhost` for local
development. So each rep adds `http://127.0.0.1:3000/api/auth/callback` to their app once. PIN-based
`oob` auth does not avoid this — the docs confirm a callback URL is still required in app settings
even for `oob` — so there is no shortcut, and the wizard should just show the exact string to paste
with a link to the right settings page.

**Token storage.** Access token and secret encrypted at rest with AES-256-GCM, in a local SQLite
database. Because this runs on the rep's own machine, the encryption key is derived from a passphrase
they set at setup rather than a shared server secret. Tokens are never logged, never sent to the
browser, and never included in anything sent to Grok. A visible "Disconnect" action wipes them.

### The one real tradeoff of going local-first

You said you want to know who is accessing which accounts. Local-first gives you that only
partially, and it is worth being explicit rather than discovering it later.

What you do get: because every rep uses their own consumer app and their own user token, **X's own
server-side logs already attribute every request to the right person**, and access is hard-scoped to
what each rep is individually entitled to. The app also writes a local audit log of every advertiser
data pull.

What you do not get: a **central** view. Local audit logs live on each rep's laptop and nobody
aggregates them. If "we know who is accessing all accounts" means a dashboard you can open, that
needs either the hosted version or a small opt-in telemetry endpoint the local app posts audit
events to. The telemetry endpoint is a couple of days of work and is the cheap way to get central
attribution without full hosting — worth adding in Phase 5 if central visibility matters to you.

## 3. Stack

Local-first changes the shape here: no hosting, no SSO, no Postgres, and the AI key is the rep's own.

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router), TypeScript | Server routes keep OAuth secrets out of the browser, even locally |
| UI | Tailwind + shadcn/ui | Fast to build, consistent, dark mode by default |
| Charts | Recharts | Enough for time series, bars, scatter; low ceremony |
| Data fetching | TanStack Query | Caching, background refetch, parallel queries |
| Storage | Encrypted files behind a narrow store module | See note below |
| AI | Grok via the xAI API, streaming, tool-calling | OpenAI-compatible, so the provider stays swappable |

**On storage:** this started as Prisma and SQLite and ended up as plain encrypted files. Prisma's
CLI would not install cleanly, `node:sqlite` is still flagged experimental on Node 23, and
`better-sqlite3` needs native compilation. For a single-user app holding one connection record and
an append-only audit log, a database was buying nothing and costing install
reliability — which matters most in exactly the scenario where reps run this themselves. All reads
and writes go through `lib/store.ts`, so a hosted deployment can swap in Postgres by editing one
file.

Node 23 and npm 10 are already installed, so there is no toolchain setup step.

Reps start it with `npm run dev` (or a packaged `npx` one-liner once it stabilizes) and open
`http://127.0.0.1:3000`. **Every** X Ads call happens in a server route handler — the browser talks
only to our own `/api/*` endpoints and never receives a token or an `Authorization` header.

## 4a. How spy access actually works

This took several rounds of testing against the live API to pin down, and every assumption that
seemed reasonable turned out to be wrong. Recording it because it shapes the whole picker.

**Spy access is granted per ad account, not per advertiser handle.** Adding `@barstoolsports` and
listing its accounts returns 7, but only 1 of them can actually be read. The other 6 return
`403 "Cannot access spy for account"` on any sub-resource. So the unit of access is the account ID.

**`GET /accounts` with `x-as-user` is not an entitlement check.** It returns everything the
*impersonated advertiser* can see, which is far broader than what the employee may open. Testing
`x-as-user: nike` returned 41 Nike accounts. Treating that list as usable is what produced cards
full of 403 warnings in the first attempt. Access has to be verified per account against a
sub-resource — `/campaigns` is the cheapest reliable probe.

**Nothing enumerates an employee's spy grants.** The public docs contain no spy endpoint at all.
The list exists only in the internal spy manager at `ads.x.com/manager/spy`. So the console links
out there, and reps paste the rows back in — the paste carries the handle and account ID together,
which is exactly the pair needed.

**The spy manager's "Recently viewed" is history, not entitlement.** Of 7 accounts in that list,
only 3 still granted API access. The other 4 were confirmed dead through two independent code
paths. Grants lapse, so the console verifies before saving and shows a lapsed grant plainly
instead of failing silently.

Consequence for the UI: never show an account the rep cannot open, and treat a failed `/campaigns`
call as "access lapsed" rather than as a missing-data warning.

## 4b. Account picker — "the accounts I'm spied into"

One screen, shown right after connecting, with accounts grouped by how the rep reaches them:
granted directly, or by impersonating a given handle.

- Direct accounts: `GET /12/accounts?count=1000` with the rep's tokens and no `x-as-user`,
  paginating on `next_cursor`.
- Spy accounts: served from locally stored grants that were already verified when added, so they
  cost no API calls on page load.
- Enrichment is **lazy and per account**, through a route that returns one summary at a time:
  `promotable_users` for the advertiser handle, `authenticated_user_access` for permissions,
  `funding_instruments` for budget, campaigns for counts, and the spend sparkline. A client-side
  concurrency cap of 4 keeps a rep with dozens of accounts from stampeding the API, and large
  groups stay collapsed until expanded.
- Card grid: account name, advertiser handle, timezone, approval status, an impersonation badge
  when relevant, 7-day spend sparkline, and live and paused campaign counts.
- Client-side search and per-group removal.

## 5. Account dashboard

Driven by a single date-range control plus a granularity toggle, with every panel reacting to it.

- **Header** — account name, advertiser handle, timezone, approval status, funding instruments with
  remaining budget.
- **KPI row** — spend, impressions, engagements, clicks, CTR, CPE, CPM, video views. Each tile has a
  sparkline and a delta versus the previous equivalent period.
- **Time series** — stacked or overlaid metrics at `DAY` granularity, with metric toggles.
- **Campaign table** — name, status, objective, daily and total budget, pacing, plus derived
  metrics. Sortable and filterable. Only pacing *problems* are badged here; badging the healthy rows
  too would tag most of the table and bury the ones that matter.
- **Budget pacing** — see section 5a. The most actionable panel on the page.
- **Drill-down** — campaign → line items → promoted posts, with creative previews so a rep can see
  the actual post that is performing. See section 5b.
- **Breakdowns** — video completion quartiles, and conversion metrics when the objective implies
  them.

Derived metrics follow the docs rather than our own invention: CTR is `clicks/impressions`,
engagement rate is `engagements/impressions`, CPE is `billed_charge_local_micro/engagements`. Metric
groups are selected per campaign objective — `ENGAGEMENT` and `BILLING` always, `VIDEO` for video
objectives, `WEB_CONVERSION` or `MOBILE_CONVERSION` for conversion objectives.

### API limits the UI has to respect

These come straight from the analytics docs and they shape the design, so they are worth stating up
front rather than hitting later:

- Synchronous `/stats/accounts/:id` allows a **7-day maximum range** and **20 entity IDs** per call.
  The data layer chunks on both axes and fans out.
- Longer ranges are documented as needing the **asynchronous jobs** endpoint: 90 days unsegmented, 45
  segmented, up to 200 IDs, returning a gzipped JSON artifact. **Every unsegmented figure avoids it.**
  Testing showed historical synchronous windows return identical unsegmented data, so the range is
  chunked into 7-day windows instead and stitched back together by account-local date. A 30-day view
  costs five requests per batch of 20 campaigns with no polling, no gzip download, and no job
  orchestration. The async path is used for exactly one thing, because it is the only thing that
  requires it: segmented breakdowns (§5d), where the synchronous endpoint ignores
  `segmentation_type` outright.
- **Spend can belong to campaigns that no longer exist, and the campaigns endpoint will not tell
  you.** Found on a live account: `active_entities` reported campaign `p7mae`, which
  `GET /campaigns` omits and `GET /campaigns/p7mae` 404s even with `with_deleted=true` — yet it held
  $18,908 of real billed spend. Deriving the stats entity list from `/campaigns` therefore
  **under-reported 30-day account spend by 9x** on that account ($304K against a true $2.79M).
  `active_entities` is the authority on what spent; the campaigns list is only metadata.
- **Those undescribed entities are takeover buys, and Ads Manager hides them too.** Initially they
  were labelled "Retired" on the assumption they were deleted campaigns. They are not: each one
  delivered a single 24-hour flat-rate day buy, and what makes them invisible to `GET /campaigns` is
  the same thing that makes them invisible in Ads Manager. So the rule is now precise — an entity
  that spent but which `/campaigns` will not describe is a **takeover**, and one that `/campaigns`
  describes as `deleted` is **retired**. Takeovers are excluded by default and shown only when the
  rep asks, via `?takeovers=1`, matching Ads Manager. On Novig this is the difference between a
  3-row, $320K view and a 9-row, $2.80M one — and the totals reconcile to the rows in both.
  **Their cost metrics are not comparable to an auction campaign's**: the price was negotiated, not
  won. Measured component CPMs ran $0.00 to $37.99 against $3.62–$8.47 for the account's auction
  campaigns, and including them moved account CPM from $6.50 to $9.15. Some components bill at
  nothing, so a near-zero unit cost means the cost sat elsewhere in the package rather than being
  cheap. The Grok prompt is told all of this explicitly.
- Objectives live on line items, and line items must be fetched **scoped by `campaign_ids`**. Paging
  every line item in the account to build the same objective map added roughly 20 seconds to a large
  account's response.
- **Spend is not final immediately** — generally settled within 3 days, but billing processes for up
  to 14 days. The UI labels recent days as provisional. Without this, a rep quotes a number to an
  advertiser and is wrong.
- Rate limits are enforced per user token and per ad account. **Backing off politely on 429 is worse
  than failing fast.** The reset header is usually minutes away, so waiting on it per attempt, across
  stats windows that run in sequence, compounded into a 246-second response that still failed.
  Retrying now happens only when the reset is within a few seconds, and the stats layer abandons the
  remaining windows once rate limiting starts, which yields a sub-second partial result instead.
- **Budgets and flight dates are on line items, not campaigns.** Every campaign-level budget field
  returned `null` on every account tested, so budgets are summed from line items — which are already
  being fetched for objectives, making pacing free in API terms. See section 5a.
- **Account-level spend is not usable.** Verified against a live account: requesting `entity=ACCOUNT`
  with `metric_groups=BILLING` returns `metrics: {}` while the same window at `entity=CAMPAIGN`
  returns full daily spend. Account totals therefore have to be summed from campaigns. The efficient
  path, and the one the docs recommend, is to call `active_entities` first to find which campaigns
  actually ran in the window, then request stats only for those in chunks of 20 — an account with
  hundreds of dormant campaigns then costs one or two calls instead of dozens.

## 5a. Budget pacing

**Built.** The question ads sales is actually asked — is this campaign going to spend what we
committed, by when we said — and the console could not answer it. On the first account checked it
found a campaign tracking to deliver $103,000 of a $300,000 commitment, a $196,677 shortfall with 36
days left to fix it.

The panel sits above the charts because it is the part with something to do about it. Each campaign
shows spend against budget as a bar with a marker at the point the flight has reached; the gap between
the two *is* the pacing problem, which reads faster than any percentage.

Four decisions here were forced by real data and should not be quietly reversed:

**Pacing is measured against flight-to-date spend, never the selected window.** These are unrelated
spans. Measuring a 7-day window against a 54-day flight's total budget reports a healthy campaign as
catastrophically behind. The test that protects this is that pacing figures are **identical at 7, 14,
30 and 90 days**.

**Two bases, because only one account tested set total budgets at all.** With a committed total and a
flight, pacing compares budget consumed against flight elapsed. Without one, it compares recent daily
spend against the daily budget, over the **trailing 7 days** — the daily budget is what is deliverable
now, and a 30-day average compares it against spend from line items that may since have paused, which
produced impossible rates above 2x.

**Overdelivery is only reported against a committed total.** Daily budgets overdeliver routinely; five
campaigns on one account were flagged before this was fixed. Against a total budget, spending too fast
is a real problem because the budget runs out mid-flight.

**Campaigns delivering nothing are split in two.** `dark` was delivering and stopped; `idle` never
delivered in the window. A test-heavy account had 24 idle campaigns at $1/day which, conflated, hid a
live campaign sitting on a $110,000/day budget. Ranking uses money at stake **per day** so that
shortfalls and daily budgets are comparable at all.

When stats are incomplete, pacing is suppressed rather than estimated. Zero spend and spend we failed
to fetch look identical, and announcing that a campaign stopped delivering when the API rate-limited
us is the fastest way to lose a rep's trust.

**Behind-pace campaigns carry a recommended daily budget**, which is remaining budget over remaining
days. The number is trivial to compute and the reason it took care is that a campaign can be behind for
two unrelated reasons, and the figure means opposite things in each. Where the daily cap is what is
holding delivery back — the campaign spends it in full every day — raising it to the required rate
recovers the budget. Where the campaign is not spending the cap it already has, the cap is irrelevant
and the constraint is bid or targeting, so the panel says that instead of quoting a budget.

That second case is not hypothetical: it is the only underpacing flight across the four accounts
tested. Novig's Trend Genius needs $7,856 a day against a $5,456 cap, which presents as a routine 1.4x
raise, while actually spending 36% of the cap it has. A version that always printed the number would
have recommended a budget increase that could not be used, and on a campaign nearer to pace it would
have quoted a figure *below* the current cap — advice to cut the budget of a campaign that is behind.
Past a 3x lift the recommendation is suppressed too, since tripling a spend rate for the days left is a
conversation about the commitment rather than an edit.

## 5b. Creative performance

**Built.** Per-creative metrics in the campaign drawer, from `entity=PROMOTED_TWEET`, which answers
the question a rep gets asked after "how is it going": which post should we make more of. The spread
is large enough to be worth a conversation — two creatives in one Novig line item differed 2.4x on
click-through, and a PrizePicks creative running at 0.92% against its campaign's 0.38% had taken $251
of $58,049.

**Rates need delivery behind them.** A creative must have 1,000 impressions *and* 100 clicks before
it can be called best. On a 187-creative campaign the raw CTR leader had 6,782 impressions and about
93 clicks — a rate that swings on a few stray taps — while a creative with seven times the delivery
sat just behind. The thresholds live in `lib/x/creatives.ts` because the server needs them too, to
guarantee the badged winner is one of the creatives it enriches with text and a preview.

**The winner is listed first, not in spend order.** It ranked #32 of 187 by spend on one campaign and
#56 on another, so ordering purely by spend buried the only row worth acting on.

**Previews use `tweet_previews`, because v2 media does not work for ads.** The v2 media expansion
returns nothing for Promoted-only posts — verified against a creative with two million video views —
and website cards are not v2 media at all. The endpoint hands back an `<iframe>` as a string; the
`src` is extracted and host-checked rather than injecting the HTML, then rendered sandboxed and only
on request.

Creatives are fetched scoped by `line_item_ids` and enriched only for the top 50 by spend plus the
winner. Campaigns with 200 creatives are normal, and creative spend sums exactly to the campaign
total, the same reconciliation check that caught the 9x under-reporting bug.

**Ask Grok about the creatives.** The panel under the creative list takes the questions reps actually
ask — rank by CTR, rank by overall performance, why is the top one winning, how would you fix the
weak ones — and two decisions make the answers trustworthy rather than plausible:

*Rankings are computed, not reasoned.* Sorting a dozen percentages is exactly the arithmetic that
produces a confidently wrong answer, so every creative arrives already carrying `rank 2 of 3` on each
metric, computed in `lib/x/creative-context.ts` with the same direction rules the compare table uses.
The model is told to use the positions as given. Only creatives past the delivery floors get ranked at
all; the rest are marked NOT RANKABLE and can be described but never called best or worst.

*Copy attributes are measured, not eyeballed.* Asking why one creative wins invites the model to guess
at length and tone, so character and word counts (excluding URLs, or a t.co link reads as 23 characters
of copy), link, hashtag, mention and emoji counts, and whether the copy asks a question are all counted
in code. The causal claim stays the model's, and it is instructed to frame it as a pattern worth testing
rather than a proven cause.

The guardrail that needed live data to find: **identical copy promoted through different line items is
common.** Novig's Trend Genius campaign runs the same post twice, at 0.27% and 0.64% CTR. Without
flagging it the model reaches for a copy explanation that cannot exist, so duplicates are detected and
labelled, and the prompt directs the difference to placement, targeting, bid or the line item. Asked
why the top creative was winning, it correctly split the two cases: a copy contrast where the copy
genuinely differed, and line item plus `REJECTED` approval status where it did not.

## 5c. Versus the brand's own history

"How does this campaign compare to what this advertiser normally gets for this objective?" A panel in
the campaign drawer answers it from the account's own campaigns matched on objective — the last 90
days, reaching back up to a year when that window is too thin — with the campaign under review
excluded from its own baseline.

**Leading with the objective's own KPI is the whole feature, because a rates-only benchmark gives the
wrong answer.** Two live PrizePicks app-install campaigns, measured over the same 12 days, invert
depending on which metric leads:

| | Cost per install | CPM | Verdict |
|---|---|---|---|
| `paav2` | $57.36 vs $27.66 (**+107%**) | $8.65 vs $9.18 (−6%) | cheap impressions, expensive installs |
| `pahhs` | $25.28 vs $29.41 (**−14%**) | $12.48 vs $9.05 (+38%) | expensive impressions, cheap installs |

A panel that stopped at CPM would have told a rep `pahhs` was the weaker buy while it was in fact
buying installs 14% below the brand's own norm. So each objective maps to the metric it exists to
achieve — cost per install, per follow, per video view, per engagement, per click — and that row leads,
is labelled `OBJECTIVE KPI`, and the Grok prompt is told it outranks CPM when they disagree.

Design decisions that keep it honest:

- **Statistics are computed from summed numerators and denominators**, never by averaging per-campaign
  rates. A $200 campaign and a $1.8M campaign are not two equal opinions about what a click costs.
- **Concurrent baselines by default.** For `paav2`, 5 cohort campaigns shared at least half its flight
  and others shared none, so the baseline is restricted to exactly the days the campaign delivered;
  otherwise a comparison partly measures how the auction moved. It falls back to the full 90 days and
  says so when too few campaigns overlap.
- **Volume is reported but never compared.** One campaign's install count against a five-campaign
  cohort renders as "94% worse", which is arithmetic rather than a finding. Spend, impressions and
  installs are shown as context with no delta.
- **Benchmarks are quoted as ranges, because that is how sales quotes them.** Each metric carries the
  25th-to-75th percentile across the cohort's campaigns alongside the weighted figure. The two are not
  the same statistic and the panel does not pretend otherwise: the weighted baseline is *what the brand
  pays*, the band is *where a campaign lands*. On PrizePicks, cost per install is $24.17 weighted
  against a $10.48–$25.97 band with a $14.25 median, because one campaign holds 87% of the spend — so a
  campaign at $17.91 is simultaneously 26% better than the brand's weighted cost and worse than its
  typical campaign. Both are true, and the panel says so rather than leaving a rep to pick the number
  that looks broken. Four contributing campaigns minimum, or interpolated quartiles are just the
  extremes in disguise.
- **Band membership differs for costs and rates.** A cost needs money behind it and a denominator to
  divide by, so a campaign with no installs contributes no cost per install — entering it as $0 would
  drag the band toward free. A rate needs only delivery, because no clicks is a real CTR of zero.
  Treating rates like costs hid exactly what a rep needs: on a 17-campaign cohort it reported CTR as
  0.19–0.23% across 9 campaigns when 8 of the 17 got no clicks at all and the range started at 0.00%.
- **Takeovers are never a baseline** and cannot be benchmarked themselves; a negotiated flat rate is
  not a price anyone won at auction. Requesting one returns a refusal naming the reason.
- **A thin 90-day window reaches back up to a year rather than refusing.** The gap is the one sales
  were filling by hand: an advertiser who last ran a video-view campaign five months ago has no
  90-day cohort for the video-view campaign running today, which is why one vertical was still
  quoting benchmarks off last year's deck. **The data was live in the API the whole time** — the
  "90 days" in the docs is the longest span one request may cover, not how far back the figures go.
  Spend was confirmed at 95, 120, 150 and 365 days back, and one account held 23 app-install
  campaigns worth $6.98M in the year *before* the dashboard's window. The fetch is targeted because
  widening the dashboard's own window would be 52 synchronous windows per batch of 20 campaigns,
  enough to exhaust the rate limit: `active_entities` names which campaigns spent in the older
  months, the objective filter narrows them to a handful, and only those are fetched — as
  **asynchronous jobs, which span 90 days each instead of 7**. A year costs about five jobs and ran
  in 20 seconds live. Older campaigns can never be judged concurrent, a dropped window abandons the
  whole lookback rather than understating the campaigns that ran in it, and the badge and a note date
  the baseline, because "versus last October" is a weaker claim than "versus last month".
- **No objective-matched history anywhere means no comparison.** Novig's Video Views campaign has no
  cohort in 90 days and none in the year before either, so the panel says both rather than falling
  back to an all-objective average that would compare a video buy to a reach buy.

Two caveats surfaced from live data rather than smoothed over. The cohort is usually concentrated —
one PrizePicks campaign is 82% of its own objective's spend, so the panel states that the comparison
is close to a head-to-head. And **installs lean on view-through attribution to wildly different
degrees**: 94% for `pahhs` against 79% for its baseline, which means its cost-per-install advantage
rests largely on people who never touched the ad. Both are rendered as notes, not hidden.

Cost: the API publishes **no total** for a conversion metric, only a breakdown by attribution, so
`installs` only exists once we define it as post-engagement plus view-through — which the UI and the
prompt both say out loud. `MOBILE_CONVERSION` rides along in the same request as `ENGAGEMENT,BILLING`,
so the figures cost no extra calls, but the response nests conversion metrics as objects instead of
flat arrays and needed a second parse path in `lib/x/stats.ts`.

## 5d. Where it ran — platform breakdown and Spotlight

The drawer shows the same money split by device, which is the cut an optimization conversation
actually turns on: for Novig's video campaign, iOS buys views at $0.0071 against Android's $0.0100 and
desktop's $0.0131, on 74% of the spend. Alongside it, the share that served in Spotlight.

Five findings shaped the implementation, each of which would have produced a confidently wrong panel
if missed.

- **Segmentation is asynchronous-only.** The synchronous endpoint accepts `segmentation_type`, echoes
  `null` back, and returns unsegmented numbers — a breakdown built on it is four identical rows. The
  real path is create a job, poll it, download a gzipped file. The job response also carries `id`
  rather than the documented `id_str`, and `segment` is a bare string, not an object.
- **The objective lives on line items, not campaigns.** Campaigns report `objective: null`. Inferring
  the yardstick from the data instead made a live *reach* campaign show a 595% cost-per-view gap,
  because desktop autoplay yields few views per impression. On CPM — what reach is actually bought on
  — its platforms sat within 5% of each other. Views are the yardstick only when views were bought.
- **Conversions do not segment.** A segmented job returns all 24 `MOBILE_CONVERSION` metrics present
  and entirely null, SKAdNetwork included. Cost per install by platform, the single most useful cut,
  is unavailable; the panel says so rather than rendering zeros that read as "no installs here".
- **Segments do reconcile, despite the docs.** The docs warn segmented data is not expected to sum to
  the non-segmented total. It matched to the cent on every campaign tested, so the drift is measured
  against the synchronous figure and only mentioned when it is real.
- **Spotlight is inside the total, not additional to it.** The line item's configured placements do
  not settle this — Novig's video line item lists no `SPOTLIGHT` yet a `placement=SPOTLIGHT` query
  returns $2,939. The budget settles it: a $2,830 daily budget and exactly $19,810.00 of 7-day
  `ALL_ON_TWITTER` spend is 7 × $2,830, so `ALL_ON_TWITTER` already holds every dollar the campaign
  could spend. Adding Spotlight would have overstated this campaign by 15%. The remainder is computed
  by subtraction, the panel states the slice is part of the totals above, and the split is dropped if
  it ever exceeds the total.

Two guards against presenting noise as a recommendation: a platform needs 2% of spend before it can be
named cheapest or dearest, and gaps under 15% read as "nothing to shift here" with no badge. Both exist
because live accounts carry an `Other` row worth cents on a dozen impressions whose unit costs swing
wildly.

Fixed along the way: `formatUnitCost` rounded to two decimals, which rendered every platform's cost per
view as `$0.01` and turned the real 83% gap into two identical figures. Sub-cent costs now get four
decimals, which also corrects the benchmark panel's CPV row.

## 5e. Who it reached, and what the numbers already say

Two panels sit either side of the platform breakdown, sharing its single fetch.

**Audience** shows impressions by age band and gender share. Both come from the same async
segmentation machinery as platforms, run as two jobs in parallel because the API permits only one
dimension per job. Age and gender behave differently from platforms in ways the panel has to be
honest about:

- **They are inferred, not declared.** X models a viewer's age and gender; the advertiser never
  supplies them. Measured across eight campaign-windows on three accounts, age reconciles to the
  unsegmented impression count exactly in every case bar one, where it came in two impressions
  *above* it — so the residual is clamped at zero rather than assumed positive.
- **Gender returns no unknown row at all.** The API reports `Male` and `Female` and omits whoever it
  could not classify, so `Unknown` is carried as the residual against the unsegmented total. It is
  genuinely tiny — 617 impressions of 10.3M on Novig, 25,756 of 171M on PrizePicks — but deriving it
  is what keeps the two reported shares from being normalized to 100% and overstating both.
- **Shares are taken against the campaign's own total**, never against the sum of the bands, so a
  dimension that does not fully account for delivery cannot inflate itself to fill the chart.
- **Bands arrive as prose.** Labels come back as `"13 to 17"` and `"over 65"`, not as ranges or
  codes, and bands with no delivery are absent rather than zero. They are mapped to `13–17` … `65+`
  and rendered in canonical order regardless of the order the API returns them in.

**Insights** is the panel a rep reads first, and it is deliberately *not* a model call: every line is
computed from the numbers already on screen — the efficiency verdict restated from the platform panel
so the two can never disagree, delivery concentration, the click-through edge between platforms, the
leading age band, gender skew, and the Spotlight cost delta. The panel renders nothing at all rather
than padding with weak observations.

Each line is gated, because an insight that states a rounding artefact is worse than no insight:

- A platform needs 10% of the spend before it is named, and a click-through "edge" needs the leader
  to beat the laggard by 25% — the same reasoning as the platform badges.
- A gender split under 55/45 is reported as a balanced book rather than dressed up as a skew.
- When one platform carries essentially everything, the sentence says so instead of naming the
  runner-up at "0%", which reads as a comparison when it is really a rounding floor.
- Spotlight needs 1% of the spend before its CPM is quoted. A slice that rounds to zero has a cost
  per thousand too thin to conclude anything from, and "0% of spend, 69% cheaper" invites a
  reallocation the data cannot support. Both of these were real sentences on live accounts before the
  gates went in.

Placing it above the charts rather than below them is the point: the charts justify the sentences,
they are not the conclusion the rep has to reach on their own.

## 6. Compare mode

Multi-select campaigns, then open a comparison view with:

- A side-by-side metric table with the better value per row starred, and percentage deltas against a
  baseline column the rep chooses by clicking a campaign name.
- Overlaid time series, one line per campaign, with a switchable metric.
- An indexed view normalizing each campaign to 100 on its own first active day, plotted against
  days-since-launch rather than the calendar. Without this a campaign that launched last week looks
  like it collapsed when it simply had not started yet.
- A scatter plot of spend against efficiency (CTR, engagement rate, CPE or CPM) to spot outliers.

Comparison sets are encoded in the URL so a rep can paste one into a deal thread — though on
local-first the recipient needs the app running to open it.

Two decisions worth recording. **Spend has no winner.** Outspending another campaign is neither good
nor bad, so the spend row is never starred and its delta is left uncoloured; only metrics with a real
direction get a verdict. And **a zero cost never wins a lower-is-better row** — a campaign that was
never charged would otherwise take first place on CPM, CPE and CPV simultaneously.

The selection is capped at eight, which is where the palette runs out and the chart stops being
readable. Beyond that the view keeps the first eight and says so.

## 7. Grok summary and Q&A

**Built for the compare view.** The rep supplies their own xAI API key in setup, stored encrypted
alongside their X tokens, and the app validates it against xAI before saving. Available models are
listed from the key and the newest `grok-N.N` is picked automatically; the rep can override it. The
xAI API is OpenAI-compatible and the integration is a thin `lib/grok.ts` with no SDK, so the provider
stays swappable.

**Or `XAI_API_KEY` in `web/.env.local`,** which suits anyone who already keeps one there and makes the
key survive a wiped data directory. The environment wins over a stored key, because editing a file on
the machine is the more deliberate act, and a stale stored key quietly taking precedence is how
someone bills the wrong account. Ambiguity is then closed off rather than left to be discovered:
pasting a key while the variable is set is refused with a 409 explaining why, a stored key that is
being shadowed is called out in setup with a one-click way to delete it, and the setup page names the
source of the key it is using instead of just saying "Connected". `XAI_MODEL` optionally pins the
model and hides the picker.

The server assembles a **compact, pre-aggregated numeric context** — computed metrics, not raw API
payloads — and asks Grok for a narrative: what is working, what is underperforming, whether pacing is
on track, and suggested talking points for the advertiser conversation.

Two guardrails came out of actually running this and are worth keeping:

**Send display-formatted figures, not raw ones.** The first version sent `CTR: 0.0053` while the
prompt said rates were percentages — a latent 100x error. Values now go through the same
`spec.format()` the KPI tiles use, so the prompt reads `CTR: 0.56%` and `Spend: $215,023`, and the
prompt tells the model to quote them verbatim and never combine or rescale them.

**Refuse rather than narrate incomplete data.** A failed stats window used to leave zeros and stay
silent, and a captured prompt showed $135,804 where the dashboard showed $215,023. `fetchDailyStats`
now counts failed and total requests, the dashboard carries a `partial` flag that surfaces as a
warning, and the summary endpoint returns 503 instead of summarising understated numbers.

The Q&A chat is scoped to the account currently open and uses **tool-calling** rather than stuffing
everything into the prompt. The tools are the ones this repo already defines — `list_campaigns`,
`get_campaign`, `list_line_items`, `get_active_entities`, `get_account_stats` — so when a rep asks
about a date range or entity that is not loaded, Grok fetches it through the same authenticated,
rate-limited path as the UI instead of guessing.

The guardrail that matters: **numbers are rendered from API data, and the model only writes narrative
around them.** Every claim references an entity ID the UI can link to. This is the difference between
a tool sales trusts and one they abandon after the first hallucinated figure.

One thing to confirm before rollout: advertiser performance data leaves the rep's machine for the
xAI API. Keeping it within X infrastructure was the reason for choosing Grok, but it is still worth a
data-handling sign-off, and the AI panel should be independently disableable for accounts where that
is not cleared.

## 8. Security

Even local-first, this reads other companies' advertising data, so a few things are non-negotiable.

- **Read-only.** No campaign writes. Writes belong on the official Ads MCP where advertiser approval
  flows exist, and staying read-only removes a whole category of risk.
- **Audit log** of every advertiser data access: which rep, which account, which endpoint, when.
  Keyed to the signed-in user id, not just a handle, so it survives a rename and can be joined back
  to the token that signed the request.
- Encrypted token storage, no secrets in the client bundle. The key comes from `ENCRYPTION_KEY` when
  hosted and from `master.key` beside the data locally.
- Any `x-as-user` impersonation is logged distinctly and shown in the UI while active, so it is never
  ambiguous whose identity a request used.
- The setup wizard states plainly that the rep is pasting their own keys and that those keys never
  leave their machine except to X.

## 9. Phases

**Phase 0 — foundation. Built.** Next.js 16 app in `web/`, OAuth 1.0a signing ported and extended to
cover the handshake legs, `adsRequest` taking per-request credentials, AES-256-GCM encrypted file
store, audit logging on every Ads API call, retry with rate-limit-aware backoff, entity-ID chunking,
and timezone-aligned stats ranges.

**Phase 1 — setup wizard and account picker. Built.** Three-step wizard (callback URL, consumer keys,
authorize), the full 3-legged OAuth flow with replay protection, identity resolution, `/accounts`
enrichment with advertiser handles, permissions, funding instruments, campaign counts and a 7-day
spend sparkline, plus search, sort, and disconnect.
*Verified against live accounts — see the status section below.*

**Phase 2 — account dashboard. Built.** 7/14/30/90-day range in the URL, twelve KPI tiles with
period-over-period deltas (cost metrics coloured inverted, so a falling CPM reads as good), an
interactive daily trend chart with a second metric overlaid on its own axis, a sortable campaign table
that hides no-activity campaigns behind a toggle, and a drill-down drawer for line items and promoted
posts with real post text. Provisional days are labelled in both the summary line and the chart
tooltip. Video tiles appear only when the objective produces video metrics.
*Async job polling was dropped in favour of 7-day window chunking — see section 5.*
*Budget pacing was added after the fact — see section 5a. It is the panel a rep acts on.*
*Creative-level performance followed — see section 5b.*

**Phase 3 — compare. Built (within a single account).** Multi-select in the campaign table opens a
comparison view holding the whole selection in the URL: a side-by-side metric table with the better
value per row starred and percentage deltas against a clickable baseline column, an overlaid daily
trend with absolute and indexed modes, and a spend-against-efficiency scatter with a switchable
efficiency axis. Comparing within one account costs **no extra API calls** — the view reuses the
dashboard's cached query — so it opens instantly from the campaign table.
*Cross-account comparison is not built; it is the half that needs new fetching.*

**Phase 4 — Grok. Partly built (compare summaries).** The rep's own xAI key, validated and stored
encrypted, with model auto-discovery; a streaming summary of whatever campaigns are being compared,
grounded in the server's own formatted figures and refused outright when the data is incomplete; and
follow-up questions against the same context.
*Still to build: the account-level summary outside compare mode, and tool-calling so questions can
reach date ranges and entities that are not currently loaded.*

**Phase 5 — rollout.** A one-command install so non-technical reps can run it, a setup guide that
replaces `SETUP.md`, empty and error states, and optionally the central audit telemetry sink or full
hosting if you decide you need the central view.

The first three phases are the product — a rep who can connect, open an account, and compare
campaigns already has something better than what they have today. Phase 4 is what makes it feel
magic, and it is deliberately last because it depends on the data layer being trustworthy first.
That ordering paid off: both Grok bugs worth finding were data-layer bugs the AI merely exposed.

## 10. Current status

Phases 0, 1 and 2 are built in `web/`, plus budget pacing (5a), creative performance (5b), the brand
benchmark (5c), the platform and Spotlight breakdown (5d), audience and computed insights (5e),
Phase 3 for campaigns within a single
account, and the compare-scoped half of Phase 4 — all verified end to end against live ad accounts.
Lint, typecheck, and production build are all clean.

What has been confirmed working with real API data:

- The 3-legged OAuth handshake signs correctly, including `oauth_callback` and `oauth_verifier`
  participating in the signature, which is where OAuth 1.0a implementations usually break.
- Credentials encrypt and decrypt through a real round trip; nothing secret reaches the browser.
- `GET /accounts` without `x-as-user` returns the accounts the token holder actually has, and
  enrichment resolves advertiser handles, permissions, funding instruments and campaign counts.
- Daily spend matches an independent direct query of the API, after the account-versus-campaign
  correction described in section 5.
- Accounts with genuinely no activity correctly show zero rather than an error, confirmed against
  `active_entities`.
- Historical stats windows work synchronously, so 7/14/30/90-day ranges are all real chunked queries.
  Across every account tested, the daily series sums exactly to the headline total and the campaign
  rows sum exactly to the account total — the check that caught the 9x under-reporting bug.
- Ranges were exercised at 7, 14, 30 and 90 days on accounts from zero spend up to $2.79M, including
  one with 112 campaigns of which 6 were active. Worst response after the line-item scoping fix is
  about 3 seconds.
- Compare mode was driven through the actual UI rather than by loading URLs: ticking campaigns in the
  table, clicking Compare, flipping to indexed mode, switching the charted metric and the scatter
  axis, re-baselining by clicking a column header, and re-opening the resulting shared URL cold in a
  fresh browser. Selections of one campaign, and of campaign IDs that do not exist, both fall back to
  guidance instead of rendering an empty comparison.
- Budget pacing returns identical figures at 7, 14, 30 and 90 days, confirming it measures the flight
  rather than the selected window. Checked across an account with committed total budgets, one with
  daily budgets only, one with 112 campaigns, and one with no campaigns at all.
- Creative-level spend sums exactly to the campaign total on every campaign checked, including two
  carrying 187 and 205 creatives. On the campaign whose best creative ranked #56 by spend, that
  creative still arrived with text and a preview, which is the case the enrichment cap would break.
- Rate limiting and incomplete data were forced with a stand-in Ads API rather than reasoned about.
  The 429 path went from a 45-second failure to 0.06 seconds, the dashboard reports which requests
  were skipped, pacing suppresses itself, and the compare summary refuses with a 503.
- The Grok path was exercised against a stand-in xAI server: key validation including rejection and
  too-short keys, model auto-selection of the newest `grok-N.N` while skipping image and vision
  variants, ciphertext on disk with only a masked preview reaching the browser, streaming through a
  deliberately split SSE frame, and Stop, Regenerate and follow-up questions.
- Key precedence was checked by having the stand-in xAI server record the bearer token it received,
  so "the environment wins" is an observation rather than an assumption. Also covered: a pasted key
  refused with a 409, `XAI_MODEL` locking the picker, a model chosen against an environment key still
  persisting, and deleting a shadowed stored key leaving the environment key working.

- The creative AI answers were checked against live campaigns for all four canned questions. Ranked
  output matched the pre-computed positions exactly, video metrics appeared only on the video campaign,
  the identical-copy pair was correctly attributed to the line item rather than the copy, and a
  `REJECTED` creative was named as an explanation for weak delivery without being asked.
- Every aggregate in the payload was audited for takeover leakage, not just the headline: KPI spend
  and impressions, the daily spend series, the trend chart series, the period-over-period baseline,
  the campaign rows and the pacing rollup all exclude takeovers, and no takeover ID appears among the
  default rows. The account card's 7-day figure was reconciled against a 7-day dashboard on the same
  account and agreed exactly. The one figure that still includes takeover money is the funding
  instrument's funded amount, which is the API's own lifetime billing total and is labelled "funded"
  rather than spend.
- Takeover exclusion was checked in both directions on Novig: excluded gives 3 rows, $320,295 and
  $6.50 CPM with the 6 hidden buys reported as $2,484,690; included gives 9 rows and $2,804,985 at
  $9.15 CPM. Rows sum exactly to the account total in both modes, and an account with no takeovers
  reports zero and is otherwise unchanged. Takeover rows are named from their delivery dates, falling
  back to the impression series so a component billed at nothing is still dated.
- The account card sums spend over `active_entities` on its own path, so it was leaking takeover
  spend while the dashboard excluded it — a rep would have watched the figure shrink on click. Its
  campaign list is now fetched `with_deleted` purely to classify that spend, and a stand-in Ads API
  was used to prove the distinction holds: given a live campaign, a deleted campaign and a takeover
  that all spent, the card keeps the deleted campaign's spend and drops only the takeover, and the
  deleted campaign still stays out of the campaign counts.
- The conversion parser was checked against arithmetic done by hand on a recorded live response
  replayed through the real stats layer: 516 installs from 374 view-through plus 142 post-engagement,
  $20,232 spend, $39.21 per install and a 72.5% view-through share all matched exactly, and the
  conversion group is withheld unless the objective is an app objective.
- The benchmark was exercised on four live cases: a rich cohort where the objective KPI and CPM
  disagree in both directions, a thin one-campaign cohort on Novig where both the concentration and
  small-sample caveats fire, a campaign with no objective-matched history that refuses to compare, and
  a takeover that is refused by name. Cutting the previous-period and pacing fetches the benchmark
  never reads took the panel from 25 seconds to 11 on a 112-campaign account with identical output.
- Asked to explain the inverted case, real `grok-4.6` led with the objective KPI, stated plainly that
  "the cheaper-impressions read is the wrong one", and volunteered both caveats unprompted — the 82%
  baseline concentration and that the install advantage "leans more on view-through attribution".
- Asked to compare three takeovers, real `grok-4.6` declined to read their costs as efficiency,
  described them as flat-rate day buys whose price was negotiated rather than won, called an $8,178
  line a billing split rather than a cheap CPM, and ranked them on reach and engagement instead.

- The platform breakdown was proven against live accounts rather than the documentation, which is
  wrong in three places: the job response field is `id` not `id_str`, `segment` is a bare string not an
  object, and segmented data does reconcile — to the cent on every campaign tested, against the
  synchronous figure. Exercised on a video campaign with a genuine three-platform spread, a reach
  campaign that exposed the objective bug, and a PrizePicks campaign that is 100% iOS and therefore
  correctly reports no efficiency comparison at all.
- Spotlight's relationship to the headline total was settled by arithmetic rather than assumed. The
  line item's configured placements say it is not Spotlight-eligible yet the placement query returns
  $2,939, so the budget decided it: $19,810.00 of 7-day `ALL_ON_TWITTER` spend against a $2,830 daily
  budget is exactly 7 × $2,830, leaving no room for Spotlight to be additional. `TREND` returns null
  on the same campaign, confirming the filter is applied rather than ignored.

### Accuracy audit

A line-by-line audit of every calculation found seven defects that would each have put a wrong number
in front of a rep. All are fixed and re-verified. Worth reading before touching the data layer, because
five of the seven were silent — they produced a plausible number with no warning.

- **Daylight saving silently dropped a day from every total.** `localDate` subtracted
  `daysAgo × 24h` from the current instant, but a local day is 23 or 25 hours across a DST
  transition, so two different `daysAgo` values formatted to the same date. The duplicate collapsed
  in the column lookup, one real day was never requested, and — because every window was still a
  valid ≤7-day span — nothing failed and nothing warned. Sweeping a year of load times found 138
  cases per US timezone across the 7/14/30/90-day ranges. Dates are now resolved once in the
  account's timezone and walked back by calendar arithmetic anchored at UTC midnight, which has no
  DST. Re-swept: 70,080 ranges across five zones including southern-hemisphere and 45-minute-offset
  ones, zero defects. `toWindows` now also throws if a range is ever non-contiguous, because the
  alternative is a silently short total.
- **The period-over-period baseline was built from the wrong window's campaigns.**
  `active_entities` was queried only over the current range and its id list reused for the prior
  one, so a campaign that spent last period and has since stopped contributed nothing to the
  baseline. Measured on PrizePicks over 14 days: three campaigns ended before the current window, so
  the baseline was $759,799 instead of $813,991, and the headline change read **+12.5% when the
  truth was +5.0%** — growth overstated 2.5x, in the figure a rep is most likely to quote. The prior
  window now gets its own active-entity query, verified to the cent against an independent sum.
- **The drawer disagreed with the row it was opened from.** Campaign-level stats include deleted
  line items; the drawer's line-item fetch omitted `with_deleted`, and the header total is summed
  from those line items. On PrizePicks 333 of 535 line items are deleted, and several campaigns have
  no surviving ones at all — those showed `$0` and "No line items" against a row with real spend.
  Deleted line items are now fetched so the header reconciles, but only earn a row when they
  actually delivered, badged *Retired* like campaigns.
- **A failed line-item request understated the pacing dollars with no warning.** It was the one
  failure path that recorded nothing, yet budgets and flight dates come only from line items, so a
  dropped chunk stripped the flight from up to 20 campaigns and understated "Committed", "Projected
  to spend" and "Budget at risk" — the dangerous direction, since the shortfall disappears and the
  panel turns reassuring. It now warns.
- **`PREROLL_VIEWS` never got video metrics**, because the objective test was a substring match on
  `"VIDEO"`. Every view figure stayed zero, the benchmark dropped cost per view as unavailable, and
  CPM quietly became the headline metric for a campaign nobody bought impressions for.
- **A campaign that was never charged sorted as the cheapest buy.** A zero denominator yields a zero
  cost, which the table rendered as `$0.00` and sorted to the top of an ascending CPE sort, above
  every real buy. Zero unit costs now render as an em-dash and sort last. `metrics.ts` already had
  this right for the compare view; the table did not.
- **Currency came from whichever funding instrument the API paged back first.** On a multi-currency
  account that formats real figures with the wrong symbol. It now prefers a fundable, live
  instrument and falls back to the most common currency.

Two further gaps closed in the segments route: it trusted a possibly-partial unsegmented figure as
the reconciliation baseline — and would then have blamed our own dropped request on the documented
"segmented data may not sum" caveat — and computed the Spotlight remainder by subtraction from it,
which inflates the "everywhere else" CPM it is compared against. Both now refuse rather than
estimate.

Re-verified after the fixes, across Novig and PrizePicks at 7, 14, 30 and 90 days: campaign rows sum
exactly to the headline spend and impressions, the daily series sums to the headline, ranges hold the
expected number of distinct dates, CPM and CTR agree with their own components, takeovers stay
excluded, and the drawer matches the row with line items and creatives each summing to it. The
baseline was reconciled to the cent against direct unchunked API queries on two accounts, which also
independently validates the 7-day chunking and stitching.

Real Grok output was then checked against the live account: every figure in a `grok-4.6` summary of
Novig's three biggest campaigns — spend, impressions, CTR, engagement rate, CPM, CPC, CPE and the
account pacing totals — matched the API exactly, with nothing invented. The model also handled the
awkward case correctly without being told to, noting the campaigns could only be explained rather
than optimized.

Not yet verified: the interactive browser authorize step, because it needs a human to approve on
x.com.

## 11. Still open

1. **Central attribution** — do you need a dashboard showing which rep pulled which advertiser's
   data? If yes, plan for the telemetry sink in Phase 5, or reconsider hosting now.
2. **Grok data clearance** — sign-off on advertiser performance data reaching the xAI API.
3. ~~**Do reps already have developer apps?**~~ Settled by the hosted build (§12): it uses one
   team-owned app, so a rep signs in with nothing but their X account and the setup wizard
   disappears entirely. The launcher still uses the rep's own app, where pasting keys is reasonable
   because they also control the callback URL.
4. **Confirm the team app's user OAuth token limit before rollout.** Apps approved for Ads API
   access before July 2023 may be capped at five user tokens. The hosted build (§12) issues one per
   rep, so a cap of five would stop a sales team outright, and it is not something the code can work
   around — raising it goes through the X representative. Two related ordering facts: Ads API access
   is approved per App ID and does not inherit from an existing app, and tokens minted before that
   approval must be regenerated, so approval has to land before reps sign in or everyone authorizes
   twice.
5. **Surface each account's ad-account role.** `authenticated_user_access` is already fetched and its
   `permissions` array already reaches the account payload, but nothing displays it. Access is
   decided by probing the campaigns call, which 403s identically whether a spy grant lapsed or the
   rep's role is too low for analytics. Showing the role would separate those two, and needs no new
   API call.
6. **Vertical benchmarks — parked pending input from sales.** Asked for after the account-history
   benchmark shipped: "something more centralized, able to filter by vertical and campaign
   objective", to replace the tooling lost in the adstack migration and the hand-kept spreadsheet
   verticals quote from. Three things have to be settled by sales before this can be built, and two
   of them are not engineering decisions:

   - **Nothing in the Ads API knows an account's vertical.** `industry_type` is advertiser-declared
     and optional: of three accounts in the same internal vertical, PrizePicks reports `MOBILE`,
     Novig and DraftKings-Barstool report `null`. The enum has no sports or betting value at all.
     So the field describes the campaign type at best, and would scatter one vertical across three
     buckets, two unnamed. **Someone has to own the account-to-vertical mapping**, and the official
     vertical names have to come from sales — inventing a taxonomy here would be worse than useless.
   - **"Centralized" collides with the security model.** A figure that genuinely covers a vertical
     needs every rep's accounts pooled somewhere shared, which is the opposite of per-rep keys,
     local storage and "nothing comes back to me" (§2, §8). A cross-account view over the accounts
     one rep can see needs no shared infrastructure and is most of the value, but it is that rep's
     book, not the vertical. That trade is the user's call, not a default to pick quietly.
   - **Whether a vertical range is a percentile or a target.** The account-history band is the
     middle 50% of observed campaigns, which is derivable. Lizzie's team "manually input all campaign
     performance" and then quote ranges, which may be judgment-set good/better targets rather than
     anything measured. Those are different artifacts and only one of them can be computed.

   What is already built and transfers directly: `bandFor`/`percentile` produce the quartile ranges,
   and `fetchEntityTotals` makes the sweep affordable — 90-day totals for a 112-campaign account are
   about 15 requests against the ~260 a daily-series build needs, so a 25-account sweep is feasible
   with caching where it would not have been before.
## 12. The shared hosted deployment

Built after the demo, when the decision changed from "a scrubbed link for feedback" to "the real
thing, restricted to known handles". It is the same app: `DATABASE_URL` is the only switch, and
unset it is still the single-user local tool described everywhere above.

What had to exist first, none of which was a hosting change:

- **A session layer.** The app began with one stored connection per machine, which on a shared
  deployment would have signed everyone in as the same person — one rep's token reading another
  rep's advertisers, and the audit trail naming the wrong individual. Identity now comes from a
  signed cookie carrying only the X user id. The handle is read from storage rather than the cookie,
  so a rename cannot leave a stale name in an audit row.
- **Per-user storage.** One interface, two backends: Postgres when hosted, per-user directories
  under `DATA_DIR` otherwise. Everything is keyed by the rep's user id even in local mode, so
  nothing above that layer branches on deployment.
- **Attribution as a first-class value.** `auditHandle: string | null` became an `Actor` threaded
  through every fetch, because a handle alone cannot be joined back to the record whose token signed
  the request. Audit rows deliberately do not cascade on user deletion: who looked at which
  advertiser has to outlive their access.
- **A migration.** Anyone already using the local tool had a connection and advertisers in the flat
  pre-sessions layout. Without carrying those over, upgrading would have looked exactly
  like data loss.

Two decisions worth recording, both of which cut against the original per-rep instinct in §2:

- **The developer app is team-owned.** OAuth returns to one fixed callback URL, and that URL must be
  registered inside the app whose consumer key is used. Per-rep keys would therefore mean every rep
  registering the hosted callback in their own app before they could log in, and again whenever the
  URL changed — the §11.3 adoption risk, made worse. Sharing the app costs nothing in attribution:
  each rep still completes their own OAuth, holds their own user token, and sees only the advertisers
  granted to them personally.
- **`ENCRYPTION_KEY` moved to the environment.** Locally the key is generated into `master.key`
  beside the data. On an ephemeral filesystem that file is regenerated on every deploy, which would
  have silently made every stored token undecryptable — a failure that would have looked like X
  revoking everyone's access.

Access is an `ALLOWED_HANDLES` list, re-checked on every request against the stored handle rather
than trusted from the cookie, so removing someone takes effect on their next click. An empty list
denies everyone: a half-configured deployment locks itself rather than opening itself.

Verified by three scripts, each against a production build with the Ads API pointed at a dead port:
`verify-hosted.sh` (18 assertions — two reps isolated, a valid cookie for an unlisted handle still
refused, forged cookies rejected, no local fallback when hosted), `verify-local.sh` (18 — the
migration preserves tokens and advertisers, and the cookie-free single-user path still
works), and `verify-demo.sh` (25).

## 13. Demo mode

Built, so the console can go behind a public link and be reviewed without advertiser data on the
internet. `DEMO_MODE=1` makes `adsRequest` return from `lib/demo/api.ts` before it builds a URL, so
there is no code path from a demo deployment to the Ads API; every write in `lib/store.ts` becomes a
no-op, so no credentials exist and no filesystem is needed; and Grok answers are fixed sample text,
each labelled as such, unless `DEMO_AI=live` is set. Blueprint in `render.yaml`.

Two decisions worth recording.

**Faked at the API seam, not at the routes.** Every piece of real computation still runs — the
dashboard rollups, the benchmark cohort rules and quartile bands, the pacing arithmetic, the audience
reconciliation — so the demo exercises the product rather than a parallel set of fixtures that would
drift out of agreement with it the first time a rule changed. It also makes the figures reconcile for
free: metrics are generated per promoted post as a pure function of the post, its campaign and the
date, then summed upward, so a drawer always agrees with the row it was opened from.

**Generated, not anonymised.** Scaled-down real figures stay re-identifiable from spend shape,
campaign counts and naming patterns; generated figures carry no information about anyone. It also
lets the demo contain cases that are hard to find live, which is how it earned its keep: the four
advertisers in `lib/demo/universe.ts` include an objective whose only history is older than 90 days,
and running it surfaced two real bugs that no live account could reach.

- **The longer lookback never fired.** `excludeIds` was built from every row the dashboard lists, so
  campaigns that are merely *listed* — a flight that ended eight months ago is still returned by
  `GET /campaigns` — were excluded along with the ones that actually spent in the window. Those are
  precisely the campaigns the lookback exists to find, so it silently returned nothing for its own
  motivating case. Now scoped to campaigns that delivered inside the window, which is exactly the set
  that can already be in the recent cohort.
- **The panel and its AI summary disagreed.** Only the panel's endpoint attempted the lookback, so a
  campaign whose history was all older than 90 days showed a full comparison on screen with a summary
  beside it refusing to discuss it. Both now go through `buildBenchmarkWithLookback`.
