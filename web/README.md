# X Ads Sales Console

Campaign performance for the advertiser ad accounts you already have access to. Runs locally on
your own machine, signed in with your own X credentials.

See `../PLAN.md` for the full design and roadmap.

## Getting started

This is the developer path. Anyone who is not going to edit the code should use
[`../START-HERE.md`](../START-HERE.md) and double-click `start-console.command`, which installs,
builds and launches on its own.

```bash
npm install
npm run dev
```

Then open **http://127.0.0.1:3000** — use `127.0.0.1`, not `localhost`, because X only accepts
`127.0.0.1` as a local callback URL and the two are different origins.

Next considers those two different origins as well, and blocks its own hot-reload resources across
them. The failure is quiet and misleading: the page renders its header and date tabs, then stays empty
forever with nothing in the browser console, because the client bundle never hydrates and so no data is
ever requested. `allowedDevOrigins` in `next.config.ts` permits `127.0.0.1` to fix it. If you ever see
a page shell with no table, that is the first thing to check.

The setup wizard walks through three steps:

1. Add `http://127.0.0.1:3000/api/auth/callback` to the callback URLs of your own app on
   developer.x.com.
2. Paste your app's **API Key** and **API Key Secret** (the Consumer Keys section, not an access
   token).
3. Click **Authorize with X**, which mints an access token belonging to you.

Nobody shares credentials. Every Ads API request is signed with your own consumer key and your own
user token, so you see exactly the accounts you have been granted and nothing else.

## Setting up the developer app

Create the app at [console.x.com](https://console.x.com). Whether it is one rep's own app for the
launcher or the team app for the hosted build, the settings are the same:

| Setting | Value |
|---|---|
| App permissions (OAuth 1.0a) | **Read and write** |
| Type of app | **Web App** — confidential client |
| Ads API access tier | **Standard Access** |
| Callback URL | `https://<your-service>/api/auth/callback`, or `http://127.0.0.1:3000/api/auth/callback` locally |

**Read and write, even though this console only reads.** The one read-only Ads tier is the legacy
*Analytics (Read-only)* level, and it cannot reach Campaign Management or Creative endpoints. This app
needs both: `campaigns`, `line_items`, `funding_instruments`, `promotable_users`, `promoted_tweets` and
`tweet_previews`, alongside the analytics endpoints. So Standard Access is the tier, and it is read &
write.

The consequence is worth stating plainly rather than discovering later: every rep's token is
*capable* of posting and of editing campaigns. This app never does — there are no write paths in it
at all, by design (`PLAN.md` §8) — but the capability is in the token, so the audit log is what makes
that claim checkable rather than merely stated.

**The "type of app" field is an OAuth 2.0 setting.** The Ads REST API requires OAuth 1.0a
three-legged, which is what this app implements, so that selector does not govern sign-in here. Web
App is still the right answer: this is a server-side app that can hold a secret.

### Ads API access is a separate approval, per app

Creating the app only grants basic X API access. Ads API access is then requested for that specific
App ID through the [Ads API Access Form](https://docs.x.com/forms/ads-api-access). An existing app's
approval does not extend to a newly created one, so the team app needs its own.

Two things about ordering, both of which cost real time if missed:

- **Get approved before anyone signs in.** Access tokens minted before the app is approved do not
  work against the Ads API and have to be regenerated, meaning everyone authorizes twice.
- **Check the user token limit.** Apps that requested Ads API access before July 2023 may be capped
  at five user OAuth tokens. The hosted build issues one token per rep, so a cap of five would stop a
  sales team outright. Raising it goes through your X representative; confirm it before rollout
  rather than after.

### When sign-in works but no accounts load

X returns `403 UNAUTHORIZED_CLIENT_APPLICATION`, naming the client application id:

```
The client application with id NNNNNNNN making this request does not have
access to Twitter Ads API. Ensure your application has advertiser-api access.
```

This means the app, not the person, is being refused — so re-authorizing cannot fix it, and the
console says so rather than offering a sign-in link that would loop. Quote that application id when
requesting access.

To see exactly what X says for a stored authorization, including whether the token itself is good:

```bash
node --import ./scripts/ts-hook.mjs scripts/diagnose-access.mjs
```

It calls `GET /accounts` and, as a control, `verify_credentials` on the regular API. The control
succeeding while the Ads API call fails is the signature of an unapproved app: the token is valid and
the app's access is what is missing. Keys are printed masked.

### Callback URLs

They must match exactly, including any trailing slash, and X accepts `127.0.0.1` but not `localhost`.
An app allows up to ten, so one app can serve both the hosted deployment and local development — add
the Render URL and `http://127.0.0.1:3000/api/auth/callback` together.

When one is missing or misspelled, the handshake fails with `code 415`,
`"Callback URL not approved for this client application."`

### What each rep can actually see

The app permission sets the ceiling; the rep's role on each ad account sets what they really get.
Roles are granted at **business.x.com** — Account administrator, Ad manager, Campaign analyst,
Organic analyst, Creative Manager — and `Campaign analyst` is sufficient for read-only analytics.

The console fetches each account's role from `authenticated_user_access`, which is the documented way
to determine it, and carries the `permissions` array through to the account payload. Nothing displays
it yet: whether an account opens is decided by probing the campaigns call, which is what actually
403s on a lapsed grant or an insufficient role. That works, but it cannot distinguish "your grant
expired" from "your role is too low" — so showing the role would be a genuine improvement, and the
data is already there to do it.

Adding an advertiser by handle is the pattern X documents as *obtaining your developer access token*:
the advertiser grants the rep's @username access to their ad account, and the rep's own OAuth token
then reads it. It is the supported route, not a workaround.

## Where your data lives

Everything is written to `~/.x-ads-sales-console/` with `0600` permissions:

| File | Contents |
|---|---|
| `master.key` | Random 32-byte AES-256-GCM key |
| `app-keys.json` | The developer app's consumer key, secret encrypted |
| `users/<id>/connection.json` | Your tokens, secrets encrypted |
| `users/<id>/spy-handles.json` | The advertisers you have added |
| `users/<id>/ai.json` | Your xAI API key, encrypted, and the chosen model |
| `campaign-labels.json` | How campaigns are bought, per advertiser — shared, not per rep |
| `audit.jsonl` | Every advertiser data access: who, account, endpoint, timestamp |

Set `DATA_DIR` to relocate it. **Disconnect** in Settings deletes the stored credentials; revoking
the app itself happens in your X account settings.

Installations that predate sessions kept one connection flat in `DATA_DIR`. They are moved into the
layout above automatically on first launch — tokens and advertisers carry over, and
the originals are copied rather than deleted, so nothing is lost if the move gets something wrong.
A `.migrated` marker stops it happening twice.

The master key sits next to the encrypted data rather than behind a passphrase you retype on every
launch. That protects a copied data directory, not a compromised machine account.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `APP_ORIGIN` | `http://127.0.0.1:3000` | Origin used to build the callback and all redirects |
| `DATA_DIR` | `~/.x-ads-sales-console` | Where credentials and the audit log are stored |
| `X_ADS_API_BASE` | `https://ads-api.x.com/12` | Ads API base URL |
| `XAI_API_BASE` | `https://api.x.ai/v1` | xAI API base URL, for the optional Grok summaries |
| `XAI_API_KEY` | unset | xAI key for Grok summaries, instead of pasting one into the setup page |
| `XAI_MODEL` | picked from your key | Pins the Grok model and hides the picker |
| `DEMO_MODE` | unset | Serves a generated advertiser universe instead of the Ads API. See below |
| `DEMO_AI` | unset | `live` lets Grok answer for real in demo mode, instead of sample text |
| `DATABASE_URL` | unset | Set it to run the shared hosted build on Postgres. See below |
| `ALLOWED_HANDLES` | unset | Hosted only: the handles permitted to sign in |
| `SESSION_SECRET` | random per process | Hosted only, required: signs the session cookie |
| `ENCRYPTION_KEY` | `master.key` on disk | Hosted only, required: 32 bytes base64, encrypts stored tokens |
| `X_CONSUMER_KEY` | from the setup page | The developer app's key. Required when hosted |
| `X_CONSUMER_SECRET` | from the setup page | The developer app's secret. Required when hosted |

If you run on a different port, set `APP_ORIGIN` to match and register that callback URL too.

Put these in `web/.env.local`, which is gitignored:

```
XAI_API_KEY=xai-…
```

`XAI_API_KEY` takes precedence over a key pasted into the setup page, and the setup page says so —
a saved key that is being shadowed is flagged rather than left to look active. Restart the dev
server after changing it, since Next.js reads `.env.local` at boot.

## The shared hosted deployment

Setting `DATABASE_URL` switches the console from the local single-user tool to a shared one that
several reps sign into. That one variable is the whole switch: storage moves to Postgres, identity
comes from a signed cookie instead of the single stored connection, and the handle allowlist starts
being enforced. `render.yaml` deploys it; see the comments there for the secrets it needs.

**One app, many reps.** The consumer keys are team-owned and come from the environment, because
OAuth returns to one fixed callback URL and that URL has to be registered inside the app the keys
belong to. Per-rep keys would mean every rep registering the hosted callback in their own developer
app before they could log in. Nothing is given up by sharing the app: each rep still completes their
own OAuth and gets their own user token, so what they can open is still decided by the advertiser
grants they personally hold, and the audit log still names the individual.

**Who gets in.** `ALLOWED_HANDLES` is a comma-separated list, checked at sign-in *and* again on
every request against the handle stored for that session. Taking someone off the list therefore
takes effect on their next click rather than whenever their cookie expires. An empty list denies
everyone, so a half-configured deployment locks itself rather than opening itself.

**`ENCRYPTION_KEY` is not optional here.** Locally the key is generated into `master.key` beside the
data. A hosted filesystem is ephemeral, so that file would be regenerated on every deploy and every
token already in the database would become permanently undecryptable. Generate one with
`openssl rand -base64 32` and keep it somewhere you will not lose it; losing it means everyone
reauthorizes.

Rotating `SESSION_SECRET` invalidates every cookie, which is the fastest way to sign everyone out.

Three scripts cover the modes, each against a production build with the Ads API pointed at a dead
port so an escaped call fails loudly:

```
zsh scripts/verify-hosted.sh   # needs Postgres; two reps, allowlist, forged cookies, isolation
zsh scripts/verify-local.sh    # single-user mode and the move off the old layout
zsh scripts/verify-demo.sh     # demo mode
```

## Demo mode

`DEMO_MODE=1` turns the console into something that can sit behind a public link. It exists to
collect feedback on the product without putting advertiser data on the internet.

```
DEMO_MODE=1 npm run dev
```

What changes, and what does not:

- **No outbound requests.** `adsRequest` returns from `lib/demo/api.ts` before it builds a URL, so
  there is no code path from a demo deployment to `ads-api.x.com`.
- **Nothing is stored.** Every write in `lib/store.ts` is a no-op, the connection and spy grants are
  fixed constants, and no `master.key` is created. The app therefore runs on a host with a read-only
  or ephemeral filesystem.
- **Grok answers are fixed sample text**, each labelled as such, unless `DEMO_AI=live` is set.
  Defaulting to live would mean an open URL billing someone's key for every question asked of it.
- **Everything else is the real product.** Faking at the API seam rather than at the route handlers
  means the dashboard rollups, the benchmark cohorts and bands, the pacing arithmetic and the
  audience reconciliation all run exactly as they do against live data.

### Why the data is generated rather than anonymised

Scaled-down real figures stay re-identifiable: spend shape, campaign counts and naming patterns are
enough to recognise an advertiser. Generated figures carry no information about anyone.

It also lets the demo contain cases that are hard to find in live accounts. `lib/demo/universe.ts`
holds four advertisers chosen to cover: an app-install book deep enough for quartile bands and the
spend-concentration caveat; a campaign behind pace with its cap binding, beside one behind pace with
headroom to spare, so the two opposite budget verdicts appear together; a takeover day buy, which
delivers and appears in `active_entities` but which `GET /campaigns` will not describe; an objective
whose only history is older than 90 days, which exercises the longer lookback; and an account with
no delivery at all.

Figures are a pure function of an entity id and a date, so two requests agree and a redeploy changes
nothing. They are generated per promoted post and summed upward — a line item is the sum of its
posts, a campaign the sum of its line items — so a drawer always reconciles with the row it was
opened from. Deploying it is `render.yaml` in the repository root.

`scripts/verify-demo.sh` checks the whole of it against a production build, with the Ads API and xAI
base URLs pointed at a dead port — so a clean run is evidence that nothing left the process, rather
than an absence of log lines. It also checks that every level reconciles, that both pacing verdicts
appear, and that the longer lookback fires.

## Layout

```
app/
  api/            Route handlers; the only place credentials are ever used
  setup/          Connection wizard
  accounts/       Account picker
lib/
  crypto.ts       AES-256-GCM encrypt/decrypt
  store.ts        All persistence — swap this file to move to a database
  x/oauth1.ts     OAuth 1.0a HMAC-SHA1 signing
  x/auth.ts       3-legged handshake
  x/ads-client.ts Ads API client: per-request credentials, retry, chunking
  x/accounts.ts   Account discovery and enrichment
  x/time.ts       Timezone-aligned reporting ranges and window chunking
  x/stats.ts      Stats fetching, stitching, and derived metrics
  x/pacing.ts     Budget and flight rollup from line items, and the pacing verdicts
  x/creatives.ts  When a creative has delivered enough for its rates to be comparable
  x/dashboard.ts  Builds the dashboard payload, shared by the API route and the summary endpoint
  x/campaign-detail.ts  Builds the drawer payload, shared with the creative AI endpoint
  x/benchmark.ts  Compares one campaign to the brand's own history on the same objective
  x/async-stats.ts Asynchronous stats jobs: the only source of segmented data
  x/segments.ts   Builds the platform breakdown and picks the metric it is judged on
  x/audience.ts   Age and gender breakdowns, with the unknown share computed as a residual
  x/insights.ts   Computed findings from the breakdowns: arithmetic, not a model call
  x/summary-context.ts  Turns a dashboard into the prompt sent to Grok
  x/creative-context.ts Turns one campaign's creatives into a prompt, ranks pre-computed
  x/benchmark-context.ts Turns a benchmark into a prompt, verdicts pre-computed
  grok.ts         xAI client: model discovery and streaming chat
```

`app/accounts/[accountId]/metrics.ts` is the single definition of every metric — its label, formatting
and whether higher or lower is better. Both the dashboard tiles and the compare table read from it, so
the two views cannot drift apart on what CPM means or which direction is good.

The compare view reuses the **same TanStack Query key** as the dashboard, so comparing campaigns inside
one account costs no additional API calls and opens instantly. The dashboard response carries a daily
series per campaign for exactly this reason, omitted for campaigns with no activity so a
hundred-campaign account does not pay for a hundred series of zeros.

## Date handling, and why it is not obvious

**Never derive an account-local date by subtracting `daysAgo × 86_400_000` from now.** A local day is
23 or 25 hours across a daylight-saving transition, so two different `daysAgo` values format to the
same calendar date. The duplicate collapses in the column lookup in `stats.ts`, one real day is never
requested, and because every window is still a valid ≤7-day span nothing fails and nothing warns — the
total is simply short by a day. A year-long sweep found 138 such load times per US timezone across the
7/14/30/90-day ranges.

`localDate` therefore resolves today's date once in the account's timezone and then walks back by
calendar arithmetic anchored at UTC midnight, which has no DST. `toWindows` additionally throws if a
date list is ever non-contiguous, because its windows are bounded by the first and last date, so a gap
would silently ask for a longer span than the slice holds.

`currentUtcOffset` deliberately uses *today's* offset even for historical days. That is the documented
rule: "the offset to be used will be the offset of the current day, not the offset of the day in
question."

## Budget pacing

Whether each campaign is tracking to spend what the advertiser committed, by the date they committed
to spend it. Four things here are easy to get wrong and are worth knowing before changing this code.

**Budgets live on the line item, not the campaign.** Every budget and flight field on a campaign
object came back `null` on every account tested. A campaign's budget is the sum of its line items',
and since line items are already fetched for objectives, this costs no extra API calls.

**Pacing must use flight-to-date spend, never the selected window.** A 7-day window measured against
a 54-day flight's total budget reads as catastrophic underpacing on a campaign that is perfectly on
track. When the selected range does not reach back to the flight start, `lib/x/dashboard.ts` fetches
the missing days separately; when it does reach back, it reuses what is already loaded. The invariant
to preserve is that **pacing is identical at 7, 14, 30 and 90 days.**

**Two bases, because most accounts set no total budget.** Only one account tested had total budgets.
Without one there is no flight to measure, so pacing falls back to comparing recent daily spend
against the daily budget. That comparison uses the **trailing 7 days**: the daily budget is whatever
is deliverable now, and averaging over 30 days compares today's budget against spend from line items
that may since have paused, which produced rates above 2x on a real account.

**Overdelivery is only a problem against a total budget.** Daily budgets routinely overdeliver, so
flagging it produced five false alarms on one account. On the delivery basis only underdelivery is
reported. Against a committed total, spending too fast is real — the budget runs out mid-flight.

Live campaigns that spend nothing get their own statuses, split because conflating them buries the
urgent case: `dark` was delivering and stopped, `idle` never delivered in the window at all. A
test-heavy account had 24 idle campaigns at $1/day, which would otherwise have hidden a live campaign
sitting on a $110,000/day budget. Everything is ranked by `dailyStake()`, which puts flight shortfalls
and daily budgets into the same unit — dollars per day — so the ranking is meaningful across bases.

When the dashboard is `partial`, pacing is suppressed entirely rather than computed from incomplete
spend. Zero spend and spend-we-failed-to-fetch are indistinguishable, and reporting "this campaign
stopped delivering" when the API merely rate-limited is the fastest way to lose a rep's trust.

### The recommended daily budget

Behind-pace campaigns get a suggested daily budget: remaining budget over remaining days. Since
`flightSpend` covers whole days only and `daysRemaining` counts the days it does not cover, the
division lines up with no day counted twice or missed.

The arithmetic is the easy part. What matters is that **being behind pace has two unrelated causes,
and the same number means opposite things in each**, so `adviseBudget()` picks a `lever` rather than
always quoting a figure:

| Lever | When | What it says |
| --- | --- | --- |
| `raise-budget` | Spending ≥90% of the cap, and the required rate is ≤3× it | Raise the daily budget to $X |
| `fix-delivery` | Cap already permits the required rate | Budget is not the constraint; check bid and targeting |
| `unrecoverable` | Cap is binding but the required rate is >3× it | Too far behind for a budget edit; revisit the end date or the commitment |
| `coverage` | The campaign is labelled a Trend Genius buy | Budget is not the lever; the question is how often it is triggered |

The `fix-delivery` case is the one that makes this worth guarding, and it is the only underpacing
flight across the four accounts tested. Novig's Trend Genius has $259,254 left over 33 days, so it
needs $7,856 a day — a 1.44× lift on its $5,456 cap, which looks like a textbook budget raise. But it
is only spending 36% of the cap it already has. Raising it would change nothing. Worse, the same
arithmetic on a campaign closer to pace returns a figure *below* the current cap, so a version that
always printed the number would tell a rep to cut the budget of a campaign that is behind.

`MAX_PLAUSIBLE_LIFT` is 3 because beyond that the recommendation is not an edit anybody can make
work: tripling a spend rate for the days remaining is a conversation with the advertiser about the
commitment, not a field in Ads Manager.

The recommendation is passed to Grok through `summary-context.ts` as a pre-computed verdict, like the
pacing status itself. In the `fix-delivery` case the context explicitly tells the model not to
recommend raising the budget, because "how do I optimize this?" otherwise reliably produces exactly
that advice.

### How a campaign is bought, which the API will not tell you

One control in the campaign drawer, `POST /api/accounts/:id/labels`, and `CampaignLabelKind` with
three values. They do **two unrelated jobs**, and conflating them is the mistake to avoid when
changing this code — `isBursty()` and `isCustomCreative()` in `lib/store/types.ts` exist so that no
caller has to remember which is which.

| Label | What it is | What it changes |
|---|---|---|
| `trend-genius` | Fires when a matching trend does, so it delivers in bursts | Pacing: no alarm, `coverage` lever |
| `l4r` | A custom unit, delivering continuously | The benchmark cohort. Pacing untouched |
| `custom` | Any other Creative Strategy unit | The benchmark cohort. Pacing untouched |

**Nothing in the API names any of them.** Novig's Trend Genius returns
`product_type: PROMOTED_TWEETS`, `objective: REACH`, `placements: ALL_ON_TWITTER`, identical to an
ordinary reach buy; the custom units are plain promoted posts, with no marker on the campaign, the
line item or the card type. For trend buys, intermittent delivery is the only observable difference,
and it is also precisely what a genuinely broken campaign looks like, so auto-detecting it would
trade a false alarm for a silent failure. Names do not help either, since the campaigns most likely
to be misread are the unrenamed ones.

**Labels are keyed by ad account, not by rep** — the only thing in the store that is. How a campaign
is bought is a fact about the advertiser, so one rep labelling a Trend Genius buy fixes the verdict
for everyone looking at that advertiser. They are also not cascaded from `users`: `set_by` is a plain
column rather than a foreign key, because a rep leaving must not silently delete the labels that stop
their accounts' trend buys being reported as behind pace. That inversion is what the hosted store
suite's "campaign labels, shared on purpose" section exists to pin down.

Because this is the one write a rep makes that other reps read, it is the one route that needs its own
authorization. Everywhere else the Ads API is the gate — a rep without access gets a 403 from X and
sees nothing — but nothing here touches the Ads API for its own sake, so the route first spends one
`GET /accounts/:id/campaigns?campaign_ids=…&count=1` to apply exactly the gate X would have applied
to a data read.

`parseCampaignLabelKind()` reads stored rows, and exists for one retired value: `notification` was an
earlier second label, for subscription-notification buys, and it suppressed the pacing alarm. It was
replaced once it turned out those campaigns do not actually switch on and off — the thing worth
recording about them is the custom unit they are built on — so stored rows are read back as `l4r`
rather than dropped, which would discard a rep's work. Unknown values are dropped, so a label written
by a newer build cannot make an older one report a verdict it does not understand.

#### What the trend label changes

`computePacing()` skips the `dark`/`idle` short-circuit, swaps the lever to `coverage`, and the row
shows how the campaign is bought instead of a status; the bar loses its colour and the row drops below
everything still worth acting on. The spend share, the shortfall and **Budget at risk** all stay
exactly as they were, because a commitment that is not being triggered often enough really may go
unspent. Demo mode seeds the same bursty shape twice — labelled on Harborline, unlabelled on Lumen —
so both verdicts are visible, and the demo suite asserts both.

#### What the custom labels change

Nothing about pacing, deliberately. A custom unit that stops spending keeps its red badge, its budget
advice and its place in the list of things to check, and shows its label *beside* the verdict rather
than instead of it. Somebody paid to build that unit, which makes a pacing problem on it worse rather
than more forgivable. Lumen's "Launch Thread — Custom Unit" is behind pace with a binding cap for
exactly this reason, so the demo carries the case and the suite asserts it still reads
`raise-budget`.

What they change is in `buildBenchmark()`: when the campaign under review is custom, the brand's
other custom campaigns on the objective are held out of the cohort, so the comparison answers "is
this unit better than our regular buys" rather than a mixture of that and "better than our other
custom units". See the benchmark section below.

## Versus the brand's own history

The drawer compares a campaign to the advertiser's other campaigns on the same objective over 90 days,
excluding the campaign itself and all takeovers.

**Each objective is judged on its own KPI, and this is not cosmetic.** Two live app-install campaigns
over the same 12 days: one ran 6% below the cohort CPM but paid +107% per install, the other ran 38%
above the cohort CPM and paid 14% *less* per install. Ranking on CPM would recommend the worse buy, so
`OBJECTIVE_METRICS` in `lib/x/benchmark.ts` maps each objective to the metric it exists to achieve and
that row leads the panel.

Every statistic sums numerators and denominators rather than averaging per-campaign rates, because a
$200 campaign is not an equal opinion to a $1.8M one. Baselines are restricted to the days the campaign
actually delivered when enough cohort campaigns overlap it, and fall back to the full window with a
note when they do not. Volume is shown without a delta on purpose: one campaign against a cohort of
five renders as "94% worse", which is arithmetic, not a finding.

### Custom creative against regular buys

When the campaign under review carries an `l4r` or `custom` label, the cohort is narrowed to the
brand's **standard** campaigns on the objective. That is the comparison the label exists to make: a
baseline containing the brand's other custom units answers a mixture of "is custom better than
regular" and "is this custom unit better than our other custom units", and only the first is a
question anybody asked.

The narrowing is **one-directional**. A standard campaign's baseline is still everything the brand ran
on the objective, custom units included, which is what it was before labels existed — so adding a
label changes the campaign you labelled and nothing else.

`customComparison` carries the kind and a count of what was held out, counted across both the recent
window and the lookback so the number is the real one. The panel renders it as a `L4R vs standard`
badge on the figures and a note naming the count: a rep repeating "50% cheaper per engagement" to an
advertiser needs to know it is cheaper than the brand's *regular* buys, and how many campaigns stand
behind that. The note is rendered with a `no-cohort` failure too, since "no comparable campaign" and
"no comparable standard campaign, and here is how many custom ones we set aside" send a rep looking
in different places.

### The same label against itself

`peerComparison` is a second baseline built from the campaigns carrying the *same* label — L4R
against L4R, Custom against Custom. The campaigns held out of the standard cohort are not thrown
away: those sharing the label become a cohort of their own, and every metric gains `peer` and
`peerDelta` beside the existing `baseline` and `delta`, so each row answers both questions at once.

They often disagree, which is the point. The demo account's `Drop Alerts` is 50% cheaper per
engagement than Lumen's standard buys and 25% dearer than Lumen's other L4R. The first figure is what
a rep quotes to the advertiser, the second is what Creative Strategy needs to hear, and neither is a
correction of the other.

Three things the peer cohort deliberately does *not* do:

- **No bands.** A usual range across one or two campaigns is noise with error bars. `peer` is a
  single weighted figure, and the panel and prompt both say how many campaigns are behind it.
- **No promotion.** A custom campaign whose only siblings on the objective are other custom campaigns
  still returns `no-cohort`; the peer cohort never becomes the primary baseline. `peerComparison` is
  carried into that return anyway, so the panel can say the peers exist without implying they are a
  norm.
- **No cross-label mixing.** An `l4r` campaign's peers are `l4r` only. A `custom` sibling is held out
  of the standard baseline *and* left out of the peer one, because "bespoke" is not a format.

The peer series is restricted to the campaign's own days whenever the main basis is `concurrent`, so
the two percentages on a row describe the same stretch of auction conditions rather than one being
same-days and the other all-time. A peer value is `null`, not zero, when that cohort has no
denominator for the metric.

### Cost per like and cost per repost

Two metrics appended only for custom-labelled campaigns, in `metricsFor(objective, custom)`, which
dedupes against the objective's own list. Cost per engagement cannot distinguish these buys from any
other, because `engagements` counts a link click, a card expand and a like as one each. A like is the
whole mechanic of an L4R and reposts are the earned reach a bespoke unit is commissioned to produce,
so these are what the units are sold on. `likes` and `retweets` were already in `RAW_METRICS` and
ride along in the `ENGAGEMENT` group, so the two figures cost no extra calls. They are left off a
standard buy, which is not sold on them.

### How labels get in

Labels reach `buildBenchmark()` as a map rather than off each row's pacing verdict, because the
lookback's older campaigns never get a verdict and have to be filtered by the same rule. A failure to
read them is not fatal: the cohort falls back to every campaign on the objective, so a database blip
costs precision rather than the panel.

### Ranges, and why there are two baseline numbers

Sales quote benchmarks as ranges, so each metric also carries a **quartile band** — the 25th to 75th
percentile across the cohort's individual campaigns, via `PERCENTILE.INC` interpolation so the figures
match what the team computes in a spreadsheet. Quartiles rather than lowest-to-highest because the
extremes on a real account are a $200 test and an end-of-quarter push, and a range stretched across
both describes nothing.

The band and the weighted baseline answer **different questions and are not interchangeable**:

- `baseline` pools numerators and denominators, so it is weighted by volume: *what this brand pays on
  this objective.*
- `band` is unweighted across campaigns: *where an individual campaign on this objective lands.*

It is therefore normal and informative for the weighted figure to sit outside the band, and the panel
says so when it happens rather than leaving a rep to decide which number is broken. A live example on
PrizePicks: cost per install came to $24.17 weighted against a band of $10.48–$25.97 with a median of
$14.25, because one campaign holds 87% of the spend. A campaign at $17.91 reads as 26% *better* than
the weighted figure and clearly *worse* than the typical campaign. Both readings are true.

Because of that, two things are said per metric rather than one. The delta badge stays measured against
the weighted baseline, and the row appends *above* or *below the usual range* only when the campaign
falls outside the band — the case where the two readings can point opposite ways. `skewNote()` covers
the other direction, naming any metric whose *weighted* figure escapes its own band. On a second live
PrizePicks campaign, CPM was $5.60 against $8.21 weighted, a flattering −32%, while $8.21 itself sits
above the $3.38–$7.57 band: the comparison is against a brand average that no typical campaign achieves.

Bands need four contributing campaigns (`MIN_BAND_SAMPLE`). Below that, interpolated quartiles are the
extremes wearing a statistic's clothes.

Which campaigns contribute depends on whether the metric is a cost or a rate, and conflating the two
biases the band. A cost needs money behind it and a denominator to divide by: a campaign with no
installs has no cost per install, and entering it as $0 would drag the band toward free. A rate needs
only delivery, because a campaign with no clicks has a perfectly real CTR of zero. Treating rates like
costs is a mistake that hides exactly what a rep needs to see — on a live 17-campaign cohort it
reported a CTR range of 0.19–0.23% across 9 campaigns, when the truth was that 8 of the 17 got no
clicks at all and the range ran from 0.00%. `format` separates the two exactly: every cost is
currency, every rate a percent.

### Reaching back past 90 days

An advertiser who last ran a video-view campaign five months ago has no 90-day cohort for the
video-view campaign running today, and the panel's only honest answer was to refuse. That gap is why
sales kept a shared spreadsheet of campaign performance by hand, and why at least one vertical was
still quoting benchmarks off last year's deck after that spreadsheet stopped being maintained.

**The data was live in the API the whole time.** The "90 days" in the analytics docs is the longest span
a single request may cover, not how far back the figures exist — spend was confirmed at 95, 120, 150 and
365 days back on a live account, and a probe pulled 23 app-install campaigns worth $6.98M from the year
*before* the dashboard's window on one account.

So when the recent window yields no cohort, or fewer than `SMALL_COHORT` campaigns, `fetchExtendedHistory`
reaches back up to a year. What makes it affordable is being targeted: widening the dashboard's own window
would mean 52 synchronous windows for every batch of 20 campaigns, which on a hundred-campaign account is
enough requests to exhaust the 250-per-15-minutes limit and hand the rep a partial build. Instead it asks
`active_entities` which campaigns spent in the older months, narrows to the ones on the objective in
question, and fetches only those — as **asynchronous jobs, which span 90 days each instead of 7**. A year
of history for a handful of campaigns is about five jobs. The live fetch took 20 seconds.

Three things keep it honest:

- **Older campaigns can never be judged concurrent.** They carry a single-column total rather than a daily
  series, so a campaign that delivered on one or two days could otherwise share column zero by coincidence
  and be called concurrent with a campaign from last autumn. Once any older campaign is in the cohort the
  basis is historical, full stop.
- **A dropped window abandons the whole lookback.** A missing stats window understates whichever campaigns
  ran in it, and that does not look like missing data on screen — it looks like those campaigns were cheap.
- **`baselineDays` counts window columns only.** An older member's total stands for months; adding it would
  report a year of history as one day. `lookback` is what describes the older period's extent.

The panel labels the baseline's age in the badge (`Back to Oct 2025`, in amber rather than grey) and says
in a note how many older campaigns were added and that prices from that far back reflect a different
auction. "Versus last October" is a weaker claim than "versus last month", and a rep quoting it to an
advertiser needs to know which they are holding. Both facts also go into the Grok prompt.

Where the older period is searched and comes back empty, the refusal says so — otherwise it reads as a
90-day limitation a rep would reasonably expect someone to work around.

**Conversion metrics do not come back as flat arrays.** Each is an object keyed by attribution
(`post_view`, `post_engagement`, `assisted`) with **no total published**, so `installs` only exists
because we define it as post-engagement plus view-through — stated in both the UI and the prompt.
`MOBILE_CONVERSION` rides along in the same request as `ENGAGEMENT,BILLING` so it costs no extra calls,
and is requested only for `APP_` objectives because it returns 30 metrics that are null for everyone
else. The view-through share is carried alongside, because a cost per install built 94% from
view-through is a weaker claim than the same number built from engagement, and two live campaigns
differed exactly that much.

The benchmark routes pass `skipComparisons` to `buildDashboard`, which drops the previous-period and
flight-spend fetches that only the dashboard's deltas and pacing verdicts need. That halved the request
count and took the panel from 25 seconds to 11 on a 112-campaign account.

## Where it ran: platform breakdown and Spotlight

**Segmented data is asynchronous-only.** The synchronous stats endpoint accepts `segmentation_type`
and silently ignores it — it echoes `null` back in `request.params` and returns the unsegmented
numbers, so a breakdown built on it would be four identical rows. Real segmentation means
`POST /stats/jobs/accounts/:id`, polling for the job, then downloading a gzipped file from
`ton.twimg.com`. `lib/x/async-stats.ts` does all three. Two things the docs get wrong: the job
response carries `id`, not the documented `id_str`, and the `segment` field is a bare string
(`"ios"`), not an object.

**Segmented windows cap at 45 days**, against 90 non-segmented, and the docs warn segmented data is
not expected to roll up to the non-segmented totals. In practice platform rows reconcile exactly — to
the cent on every campaign tested — so rather than caveat every breakdown, `buildPlatformBreakdown`
measures the drift against the synchronous figure and only says something when it is real.

**The objective has to come from the line items, and getting this wrong is not subtle.** Campaigns
report `objective: null`; only line items carry it. Without it, the obvious move is to judge a
campaign on cost per view whenever views exist — which made a live *reach* campaign look like it had a
595% platform efficiency gap, because desktop autoplay produces very few views per impression. Reach
is bought on CPM, where the same campaign's platforms sat within 5% of each other. Views are the
yardstick only when views were what was bought.

**Conversions do not segment.** A segmented job accepts `MOBILE_CONVERSION` and returns all 24 metrics
structurally present and entirely null, SKAdNetwork attributions included. So the most useful cut —
cost per install by platform — is not available, and the panel says so rather than rendering zeros
that read as "this platform drove no installs".

Gaps below 15% are reported as "nothing to shift here" and suppress the *Cheapest* badge, and a
platform must carry 2% of spend before it can be called cheapest or dearest. Live accounts carry an
`Other` row worth a few cents on a dozen impressions whose cost per view swings wildly, and it would
otherwise be presented as the platform to move budget into.

**Spotlight is a slice of the total, not an addition to it.** This matters because adding it would
overstate spend by around 15%, and the placement list on a line item does not settle it: Novig's video
line item is configured for `TWITTER_TIMELINE`, `TWITTER_MEDIA_VIEWER`, `TWITTER_SEARCH` and
`TWITTER_PROFILE` — no `SPOTLIGHT` — yet a `placement=SPOTLIGHT` query returns $2,939 of real spend.
What settles it is the budget: the line item's daily budget is $2,830 and its 7-day `ALL_ON_TWITTER`
spend is exactly $19,810.00, or 7 × $2,830. `ALL_ON_TWITTER` already accounts for every dollar the
campaign was allowed to spend, so the Spotlight figure is inside it. The remainder is therefore
computed by subtraction rather than a second query, the panel states it is part of the totals above,
and the split is dropped entirely if it ever exceeds the total. `TREND` returns null on the same
campaign, which confirms the placement filter is applied rather than ignored.

## Audience, and why it does not add up

`lib/x/audience.ts` runs `AGE` and `GENDER` as two parallel jobs, because a job accepts exactly one
segmentation dimension. Everything the platform breakdown relies on is different here, and each
difference is a way to be confidently wrong:

**Age and gender are inferred by X, not declared by the advertiser.** Measured across eight
campaign-windows on three accounts, age reconciles to the unsegmented impression count exactly in all
but one, where it landed two impressions *above* it. So the residual is clamped at zero rather than
assumed positive — a dimension that overshoots must not produce a negative band.

**Gender omits unclassified viewers rather than bucketing them.** There is no `unknown` row: the API
returns `Male` and `Female` and the rest is simply missing. The gap is small — 617 impressions of
10.3M on Novig, 25,756 of 171M on PrizePicks — and it is carried as an explicit `Unknown` band rather
than rescaled away. Rescaling the two reported shares to sum to 100% would be the tempting fix and the
wrong one: it overstates both, and it hides the fact that the dimension is a model's guess.

**Shares are taken against the campaign's own impression total**, never against the sum of the bands.
That is what stops any single dimension from inflating itself to fill the chart, and it is why the
`Unknown` legend row can honestly read `0.0%` instead of disappearing.

**Labels arrive as prose and are sparse.** Segments come back as `"13 to 17"`, `"25 to 34"`,
`"over 65"`, and bands with no delivery are absent rather than zero. `AGE_BANDS` maps them to `13–17`
… `65+` and renders the canonical order regardless of what order the API returns, so two campaigns'
charts are readable side by side.

`lib/x/insights.ts` turns those numbers into sentences without a model call — the drawer's Insights
panel is arithmetic, not narration. It restates the platform panel's efficiency verdict rather than
recomputing it, so the two cannot drift apart, and every other line is gated so it cannot state a
rounding artefact as a finding:

| Gate | Threshold | Why |
| --- | --- | --- |
| Platform worth naming | 10% of spend | Live accounts carry an `Other` row worth cents |
| Click-through "edge" | leader beats laggard by 25% | Below that it is the same rate |
| Gender "skew" | 55% | Anything closer is a balanced book |
| Spotlight CPM quoted | 1% of spend | A slice rounding to 0% has too thin a CPM to act on |

The last two gates exist because live data produced the sentences "100% of delivery ran on iOS, against
0% on Other" and "0% of spend served in Spotlight at $3.73 per thousand impressions, 69% cheaper than
the rest of the buy" — both arithmetically true, both an invitation to move money that does not exist.
A single platform carrying everything now says so directly. With nothing to say the panel renders
nothing.

## Targeting, and the four things the API does not tell you plainly

`lib/x/targeting.ts` reads back what a campaign is set to target, which is the declared counterpart to
the inferred audience above. Targeting lives on the line item, so a campaign's targeting is the union
of its line items' — and `TargetingValue` carries the line item ids rather than a count, because the
panel needs the count and the Grok prompt needs to invert it.

**It is cheap, despite the documented rate limit.** `GET /targeting_criteria` takes up to 200
`line_item_ids` in one call, so a campaign is one request. The docs put targeting criteria in a
400-per-15-minutes *category*, but a live probe showed it billing against `x-account-rate-limit-limit:
10000` instead. `with_total_count` is deliberately never sent: it drops the limit to 200 and the total
is not needed.

**Custom audience criteria are all named the same thing.** Every one comes back as `"Custom audience
targeting"` — nine identical placeholders on one Call of Duty campaign. Resolving them needs
`GET /custom_audiences`, and listing the account's audiences does not work: that account has over 200
and the ones the campaign used were not on the first page. `custom_audience_ids` scopes it to exactly
the ones referenced, but **only with `with_deleted=true`** — scoped without it the call returns HTTP
200 and zero rows, which reads as an unsupported parameter rather than what it is. All nine of those
lists had been deleted, which is the finding the panel now leads with: a campaign targeting a list
that no longer exists looks fully configured from every other angle.

**Two types hide their meaning in `targeting_value`.** `ENGAGEMENT_TYPE` has `name:
"RETARGETING_ENGAGEMENT_TYPE"` and `targeting_value: "IMPRESSION"`; `USER_ENGAGEMENT` has `name:
"USER_ENGAGER_RETARGETING"` and an account id for a value. Taking the `name`, as every other type
requires, printed the group's own label back at the reader twice over.

**Exclusions are not errors.** `operator_type: "NE"` renders on its own row under "except", in the
same neutral pill as everything else — red is the house signal for something wrong, and Novig excludes
Arizona, Maryland, Michigan and Nevada because that is where it may not take bets. The Grok prompt in
`lib/x/targeting-context.ts` is forbidden outright from recommending their removal, from inferring who
is inside a custom audience from its name, and from producing audience sizes or reach estimates, none
of which this tool can see. Verified live: on Novig it recommended nothing; on the Call of Duty
pipeline test it suggested *restoring* the dead exclusion rather than dropping it.

## Comparisons, baselines and zero

Three rules the audit established, each of which had been got wrong somewhere:

**A period-over-period baseline needs the prior window's own `active_entities`.** Reusing the current
window's id list asks for stats only on campaigns spending *now*, so a flight that ended just before
the window contributes nothing and the delta reads as growth that never happened. Measured live, this
turned a true +5.0% into +12.5%.

**A zero cost means "never charged", not "cheapest".** Any `spend / events` metric returns zero when
the denominator is zero, and rendering that as `$0.00` puts a campaign that was never billed at the top
of an ascending CPE sort. Zero unit costs render as an em-dash and sort last, and `bestIndex` in
`metrics.ts` refuses to let one win a lower-is-better row.

**The drawer must reconcile with the row it was opened from.** The row uses campaign-level stats, which
include deleted line items, while the drawer sums its own line items — so the line-item fetch needs
`with_deleted: true` or the two disagree. On a live account 333 of 535 line items are deleted. Deleted
line items are fetched for the total but only shown when they delivered, badged *Retired*.

## Creative performance

Open a campaign and each promoted post carries its own spend, impressions, CTR, CPM and video
metrics, from `entity=PROMOTED_TWEET` on the same stats endpoint. This is what answers "which post
should we make more of", and the numbers land hard: two creatives in one Novig line item differed by
2.4x on click-through, and a PrizePicks creative running at 0.92% CTR against its campaign's 0.38%
had received $251 of $58,049.

**A rate needs delivery behind it before it means anything.** `lib/x/creatives.ts` requires 1,000
impressions *and* 100 clicks before a creative can be called best. Impressions alone were not enough:
on a 187-creative campaign the CTR leader had 6,782 impressions and roughly 93 clicks, a rate that
swings on a few stray taps, while a creative with seven times the delivery sat just behind it.

**The best performer is listed first, not in spend order.** It ranked #32 of 187 by spend on one
campaign and #56 on another, so in spend order the one creative worth acting on sat far below the
fold. Those thresholds live in one module because the server uses them too — it guarantees the badged
winner is among the creatives it enriches, otherwise a campaign whose winner ranked #56 would show
"Best CTR" with no text or preview at all.

**Creatives are fetched scoped, and enriched sparingly.** `promoted_tweets` is queried by
`line_item_ids`, not paged wholesale — campaigns routinely carry 200 creatives. Text, media and
previews are fetched only for the top 50 by spend plus the winner; metrics are attached for all of
them, and a campaign's creative spend sums exactly to the campaign total.

**Previews come from `tweet_previews`, not v2 media.** The v2 media expansion returns nothing for
Promoted-only posts — verified against a creative with two million video views — and website cards are
not v2 media at all. The Ads API returns an `<iframe>` element as a string; rather than injecting that
HTML, the `src` is extracted and its host checked against `ton.twimg.com`, so only a URL this code
chose reaches the browser, rendered sandboxed and only when the rep asks for it.

**Ask Grok about the creatives.** Below the list, with your xAI key configured: rank by CTR, rank by
overall performance, ask why the top one is winning, ask how to fix the weak ones. `lib/x/creative-
context.ts` does two things before the model sees anything. It computes every rank position itself, so
"rank these by CTR" is a lookup rather than arithmetic the model might get wrong, and only creatives
past the delivery floors are ranked — the rest are marked NOT RANKABLE and cannot be called best or
worst. It also measures the copy: character and word counts excluding URLs, link, hashtag, mention and
emoji counts, whether it asks a question. So "shorter copy wins" is grounded in counted characters
rather than the model's impression of the text, and it is instructed to call such a finding a pattern
worth testing rather than a proven cause.

Creatives sharing identical copy are detected and labelled, because that turned out to be common —
Novig's Trend Genius campaign runs the same post twice, at 0.27% and 0.64% CTR. Where the copy is
identical the prompt directs the explanation to placement, targeting, bid or the line item instead.

## Grok summaries

Optional, and off until you add your own xAI key at `/setup#grok`. The key is validated against xAI
before it is stored, the newest available `grok-N.N` model is selected automatically, and only a
masked preview is ever returned to the browser. Summaries run on the compare view: pick the campaigns
you want, press **Summarize**, and the narrative streams in. Nothing is sent to xAI until you press it.

Two things about `lib/x/summary-context.ts` are load-bearing, both learned the hard way:

**Figures are formatted before they go in the prompt.** They pass through the same `spec.format()` the
KPI tiles use, so the model receives `CTR: 0.56%` and `Spend: $215,023` rather than raw ratios and
micros. An earlier version sent `0.0053` alongside a prompt claiming rates were already percentages,
which is a 100x error waiting to be quoted at an advertiser. The prompt tells the model to quote the
strings verbatim and never to combine or rescale them.

**Incomplete data is refused, not narrated.** `fetchDailyStats` counts failed windows instead of
silently leaving zeros, `buildDashboard` sets `partial` and adds a warning, and the summary endpoint
returns 503. This came from a real case where a failed window produced a summary of $135,804 in spend
against a true $215,023, with nothing in the audit log to show for it.

## Adding accounts you can spy into

Spy access is granted **per ad account**, and no API endpoint lists it. Open
[the spy manager](https://ads.x.com/manager/spy), copy the rows you want, and paste them into the
console. The paste keeps each advertiser handle next to its account ID, which is the pair needed,
and every account is verified against the API before it is saved — only accounts you can actually
open are kept.

Grants lapse. The spy manager's "Recently viewed" is browsing history, not current access, so
expect some entries to be rejected. A card whose access has since lapsed says so directly.

## API behaviors worth knowing

**Do not send `x-as-user` by default.** For an account you hold directly, adding the header fails
with `403 "Cannot access spy for account"`. Without it, the same request succeeds. Impersonation is
opt-in per account, not global.

**`GET /accounts` with `x-as-user` is not an access check.** It returns every account the
*impersonated advertiser* can see, which is much broader than what you may open — `x-as-user: nike`
returns 41 accounts. Verify each account against a sub-resource such as `/campaigns` before
treating it as usable.

**Account-level spend comes back empty.** Requesting `entity=ACCOUNT` with `metric_groups=BILLING`
returns `metrics: {}` even while campaigns are spending. Totals are summed from campaign-level
stats, narrowed by `active_entities` first and chunked 20 IDs at a time.

**`active_entities` is the authority on what spent, not `GET /campaigns`.** Some campaigns hold real
billed spend while being absent from the campaigns list entirely — not merely flagged `deleted`, but
404 on direct fetch even with `with_deleted=true`. Building the stats list from `/campaigns`
under-reported one account's 30-day spend by 9x. Stats are requested for every ID `active_entities`
returns. If campaign rows ever stop summing to the account total, that is the bug to look for.

**An entity that spent but that `/campaigns` will not describe is a takeover, not a deleted
campaign.** These are flat-rate 24-hour day buys, and the reason they are missing from the API is the
same reason they are missing from Ads Manager, so `buildDashboard` excludes them by default and
includes them only for `?takeovers=1`. `deleted` campaigns are a separate case and keep the "Retired"
label. Account totals are summed from the rows actually shown, so the table always reconciles; the
excluded spend is reported separately in `takeovers` on the payload and surfaced as a notice. The
account picker's `spend7d` applies the same rule via its own stats path in `lib/x/accounts.ts`, which
is why that file fetches campaigns `with_deleted` — it needs to tell a takeover apart from a deleted
campaign that spent, and only the former is dropped. Their
CPM, CPE and CPC are **not** comparable to an auction campaign's — the price was negotiated, not won,
and some components bill at nothing — which is why the Grok prompt forbids that comparison.

**Ranges longer than 7 days do not need the async jobs endpoint.** Historical synchronous windows
work, so `lib/x/time.ts` splits a range into 7-day windows and `lib/x/stats.ts` stitches the results
back together by account-local date. Async jobs only pay for themselves if segmentation is added.

**Fetch line items scoped by `campaign_ids`.** Objectives come from line items, but paging every line
item in a large account to build that map cost about 20 seconds per request.

**Give up quickly on `429`, do not back off politely.** The rate limit reset header is often minutes
away, and the client used to wait up to 15 seconds per attempt. Because stats windows are fetched in
sequence, that compounded into a **246-second** response that still failed. Retrying now happens only
when the reset is within a few seconds, and `fetchDailyStats` abandons the remaining windows once the
API starts rate limiting, which turns that case into a sub-second partial result with a clear warning.

Reporting ranges must land on midnight in the *account's* timezone. Getting that wrong does not
error, it silently shifts the window, so all ranges are built in `lib/x/time.ts`.
