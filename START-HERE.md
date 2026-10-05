# X Ads Sales Console — setup

Campaign performance for the advertiser accounts you already have access to. It runs on your own
laptop and signs in as you, so you see exactly the accounts you have been granted and nothing more.

Setting up takes about ten minutes, almost all of it on X's developer site. You only do it once.

There is no terminal work and nothing to configure in a file. If you have been sent here to install
the Cursor MCP server instead, that is a different thing — see `SETUP.md`.

---

## Before you start

**Install Node.js** if you do not already have it. Go to [nodejs.org](https://nodejs.org), download
the version it offers you, and run the installer taking every default. Nothing else is needed; it
does not change how your Mac works and you will never have to open it.

**Keep this folder somewhere permanent** — your home folder or Documents is fine. Do not leave it in
Downloads, where it is easy to delete by accident.

---

## Part 1 — Create your own X app

This is the longest part. The console never uses anyone else's credentials, so every person needs
their own app. It is free and takes a few minutes.

Why: the app is what lets the console talk to the Ads API as you. Access to advertiser accounts still
comes from the permissions you already have — the app does not grant any.

1. Go to **[console.x.com](https://console.x.com)** and sign in with your work X account — the same
   one you use for Ads Manager. (The older address, developer.x.com, leads to the same place.)

2. **Create an app.** It asks for a name, a description and a use case. Any unique name is fine;
   "Ads Console" is clear enough. For the use case, something like "internal reporting on advertiser
   campaigns I have access to" is accurate and sufficient. If it asks you to create a *project*
   first, do that and put the app inside it.

3. In the app's settings, set **App permissions** to **Read**. The console never writes, and nothing
   in it can change a campaign.

4. In the same settings, add this **callback URL** exactly, including the `http://`:

   ```
   http://127.0.0.1:3000/api/auth/callback
   ```

   Two things X is strict about here, and both are easy to trip over:

   - It must be **`127.0.0.1`, not `localhost`**. X treats them as different addresses and only
     accepts the first for local use.
   - It must **match exactly**, down to the trailing slash, which there isn't one of.

   If there is a Website URL field, anything real works — `https://x.com` is fine. It is not used.

   Save.

5. Open the app's **Keys and tokens** and copy the two values under **Consumer Keys**:

   - **API Key**
   - **API Key Secret**

   Keep that page open, or paste them somewhere safe for a minute — **X shows a secret only once**,
   and if you lose it you have to regenerate the pair and start this step again.

   These identify the app, not you. They are not a password, and on their own they do not give
   anyone access to any ad account.

> **You do not need the Access Token and Secret** further down that page. The console gets its own
> when you sign in, which is what ties the audit trail to you rather than to a shared token.

---

## Part 2 — Start the console

Double-click **`start-console.command`** in this folder.

A black window opens and prints what it is doing. The first run installs what it needs and takes a
minute or two; after that it is a few seconds. When it is ready it opens your browser automatically.

**Leave the black window open while you use the console.** Closing it stops the console — that is
also how you quit it when you are done.

<details>
<summary>If double-clicking does not work</summary>

**"Cannot be opened because it is from an unidentified developer."** macOS quarantined the file
because it arrived in a download. **Right-click `start-console.command` → Open**, then confirm. You
only have to do this once.

**It opens in a text editor, or nothing happens at all.** The file lost permission to run, which
happens to files that travel inside a zip. Open Terminal, type `chmod +x ` (with the trailing space),
drag `start-console.command` into the window, and press return. Then double-click it again.

</details>

---

## Part 3 — Connect your account

The console opens on a three-step page.

1. **Add the callback URL.** It shows the URL and a Copy button. If you already pasted it in Part 1,
   step 4, this is done — just check it matches.

2. **Paste your API Key and API Key Secret** from the Keys and tokens page. They are encrypted on
   your machine and are only ever sent to X.

3. **Authorize with X.** This opens X, asks you to approve your own app, and comes back. This is the
   step that signs you in as you.

You will land on your accounts list. Every advertiser account you have access to is there, including
the ones you have [spy access](https://ads.x.com/manager/spy) to.

Once you are connected, the setup page gains a field for an **xAI API key**. Add one to turn on the
Grok summaries and the ask-anything box. It is optional, and everything else works without it.

---

## Using it day to day

Double-click `start-console.command`. That is all. It reuses everything from the first run and opens
the browser.

If the console is already running, double-clicking again just opens the browser rather than starting
a second copy.

---

## If something goes wrong

**The page loads but stays empty, with no campaigns.** You are probably at `localhost:3000`. Use
**`http://127.0.0.1:3000`** instead. They look interchangeable and are not.

**"Callback URL not approved" when you click Authorize.** The URL in your app settings does not match
exactly. It has to be `http://127.0.0.1:3000/api/auth/callback` — no trailing slash, `http` not
`https`, `127.0.0.1` not `localhost`.

**"Something else is already using port 3000."** Another program has the address the console needs.
The console cannot move, because that address is the one registered with X. Quit the other program,
or restart your laptop, and try again.

**An account you expect is missing.** The console only shows what your own X account can reach. If
you have not been granted access to an advertiser yet, request it at
[ads.x.com/manager/spy](https://ads.x.com/manager/spy) — it will appear here once approved.

**Numbers look wrong.** Every figure comes straight from the Ads API for the range selected at the
top of the page. Two things that are deliberate and surprise people: spend excludes takeovers unless
you ask to see them, matching Ads Manager, and budget pacing is measured against each campaign's own
flight rather than the range you have selected, so it does not change when you switch between 7 and
30 days.

---

## What the console stores, and where

Everything stays on your laptop, in `~/.x-ads-sales-console`:

| File | What it holds |
| --- | --- |
| `connection.json` | Your API key, secret and access token, all encrypted |
| `audit.jsonl` | One line per Ads API request: when, which account, as which advertiser |
| `favorites.json`, `spy-handles.json`, `ai.json` | Your pinned accounts, handles and AI settings |

Nothing is sent anywhere except to X and, if you enable summaries, to xAI. There is no shared server
and no shared credential. The audit file is the record of which accounts you looked at.

To disconnect, click **Disconnect** on the setup page, or delete the folder above.
