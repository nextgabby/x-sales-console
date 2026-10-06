#!/bin/zsh
# Verification of the hosted multi-rep deployment, against the production build and a real Postgres.
#
# What it is really checking is that a shared link cannot leak one rep's access to another. Two reps
# are seeded, only one is on the allowlist, and the X Ads API base points at a dead port so any call
# that escapes the auth checks fails loudly instead of quietly succeeding.
#
# Needs a Postgres to talk to. With Homebrew:
#   brew install postgresql@16
#   pg_ctl -D /opt/homebrew/var/postgresql@16 -o "-p 5433" start
#
# Usage: zsh scripts/verify-hosted.sh
set -u

PORT=3991
PGPORT=${PGPORT:-5433}
DB=${DB:-xads_verify}
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}
export PATH="$PGBIN:$PATH"

command -v createdb >/dev/null 2>&1 || {
  print -r -- "No createdb on PATH. Set PGBIN, or install postgresql@16."
  exit 1
}

dropdb -p "$PGPORT" "$DB" 2>/dev/null
createdb -p "$PGPORT" "$DB" || { print -r -- "Could not create $DB on port $PGPORT."; exit 1 }

# Only alice is allowed. Bob is stored and has a perfectly valid cookie, which is the point: the
# allowlist has to stop him on every request, not just at the door.
export DATABASE_URL="postgres://localhost:$PGPORT/$DB"
export DATABASE_SSL=disable
export ENCRYPTION_KEY="$(openssl rand -base64 32)"
export SESSION_SECRET="verify-hosted-session-secret-32-chars-min"
export ALLOWED_HANDLES="alice_sales"
export X_CONSUMER_KEY="verify-consumer-key"
export X_CONSUMER_SECRET="verify-consumer-secret"
export APP_ORIGIN="http://127.0.0.1:$PORT"

FIXTURE=$(node --import ./scripts/ts-hook.mjs scripts/hosted-fixture.mjs 2>/dev/null)
ALICE_COOKIE=$(print -r -- "$FIXTURE" | awk '$1=="alice_sales" {print $3}')
BOB_COOKIE=$(print -r -- "$FIXTURE" | awk '$1=="bob_sales" {print $3}')
FORGED_COOKIE=$(print -r -- "$FIXTURE" | awk '$1=="forged" {print $3}')

[[ -n "$ALICE_COOKIE" && -n "$BOB_COOKIE" ]] || { print -r -- "Could not seed fixtures."; exit 1 }

X_ADS_API_BASE="http://127.0.0.1:1" XAI_API_BASE="http://127.0.0.1:1" \
  npx next start -p $PORT >/tmp/hosted-verify.log 2>&1 &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/connection" >/dev/null 2>&1 && break; sleep 1; done

B="http://127.0.0.1:$PORT"
PASS=0
FAIL=0
check() {
  if [[ "$2" == "True" ]]; then print -r -- "  PASS  $1"; PASS=$((PASS+1))
  else print -r -- "  FAIL  $1 ($2)"; FAIL=$((FAIL+1)); fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@" }
as_alice() { curl -s -H "Cookie: x_ads_session=$ALICE_COOKIE" "$@" }
code_as() { curl -s -o /dev/null -w '%{http_code}' -H "Cookie: x_ads_session=$1" "${@:2}" }

print -r -- '{"consumerKey":"x","consumerSecret":"y"}' > /tmp/h-keys.json

echo "== the deployment reports itself correctly =="
as_alice "$B/api/connection" > /tmp/h-conn.json
check "hosted mode, allowlist in force, sign-in available" "$(python3 -c "
import json
d=json.load(open('/tmp/h-conn.json'))
print(d['hosted'] is True and d['allowlistConfigured'] is True and d['canSignIn'] is True)
")"
# The requester's own handle is needed by the header; anyone else's would let a visitor enumerate
# the sales team from an endpoint that answers without a session.
check "the status payload names the requester and nobody else" "$(python3 -c "
body=open('/tmp/h-conn.json').read()
print('alice_sales' in body and 'bob_sales' not in body)
")"
curl -s "$B/api/connection" > /tmp/h-conn-anon.json
check "an anonymous caller learns no handle and no app key" "$(python3 -c "
import json
d=json.load(open('/tmp/h-conn-anon.json'))
print(d['handle'] is None and d['consumerKeyPreview'] is None and d['allowlistConfigured'] is True)
")"
check "no secret material in the status payload" "$(python3 -c "
body=open('/tmp/h-conn.json').read() + open('/tmp/h-conn-anon.json').read()
print('verify-consumer-secret' not in body and 'alice_sales-secret' not in body)
")"

echo "== without a session, nothing is readable =="
for ROUTE in /api/accounts /api/spy /api/ai/key; do
  check "$ROUTE refuses an anonymous request" "$(python3 -c "print('$(status "$B$ROUTE")' == '401')")"
done
# The local tool signs the only stored user in automatically. On a shared host that would hand the
# first visitor someone else's advertisers, so the fallback must not apply here.
check "the local single-user fallback does not apply when hosted" "$(python3 -c "
print('$(status "$B/api/accounts")' == '401')
")"

echo "== a forged cookie is rejected =="
check "a bad signature does not authenticate" "$(python3 -c "
print('$(code_as "$FORGED_COOKIE" "$B/api/spy")' == '401')
")"
check "neither does a truncated cookie" "$(python3 -c "
print('$(code_as 'bm90aGluZw' "$B/api/spy")' == '401')
")"

echo "== the allowlist is enforced on every request, not just at login =="
check "alice, who is listed, is allowed through" "$(python3 -c "
print('$(code_as "$ALICE_COOKIE" "$B/api/spy")' == '200')
")"
# Bob's cookie is genuinely signed and his record is in the database. Only the allowlist stops him.
check "bob, with a valid cookie but no listing, is refused" "$(python3 -c "
print('$(code_as "$BOB_COOKIE" "$B/api/spy")' == '401')
")"

echo "== per-rep data stays separate over http =="
check "alice's advertiser is hers alone" "$(
as_alice "$B/api/spy" > /tmp/h-spy-alice.json
python3 -c "
import json
d=json.load(open('/tmp/h-spy-alice.json'))
print(any(g['accountId'] == '18ce0000777' for g in d['spyGrants']))
"
)"
check "and is invisible to the other rep's record in the database" "$(python3 -c "
import subprocess
out=subprocess.run(['psql','-p','$PGPORT','-d','$DB','-tAc',
  \"select coalesce(string_agg(account_id,','),'') from spy_grants where user_id='222222222222'\"],
  capture_output=True,text=True).stdout.strip()
print(out == '')
")"

echo "== app keys cannot be changed on a shared deployment =="
check "/api/setup refuses to store consumer keys" "$(python3 -c "
print('$(status -X POST "$B/api/setup" -H 'content-type: application/json' --data @/tmp/h-keys.json)' == '409')
")"

echo "== signing out ends the session =="
check "disconnect clears the cookie" "$(
HDRS=$(curl -s -D - -o /dev/null -H "Cookie: x_ads_session=$ALICE_COOKIE" -X POST "$B/api/auth/disconnect")
python3 -c "
h='''$HDRS'''.lower()
print('x_ads_session=;' in h.replace(' ','') or 'max-age=0' in h or 'expires=thu, 01 jan 1970' in h)
"
)"
# Disconnect deletes the stored user, so the same cookie must no longer resolve to anyone.
check "the same cookie no longer authenticates afterwards" "$(python3 -c "
print('$(code_as "$ALICE_COOKIE" "$B/api/spy")' == '401')
")"

echo "== nothing reached the network =="
check "no connection attempt to the dead API bases" "$(python3 -c "
log=open('/tmp/hosted-verify.log').read()
print('127.0.0.1:1' not in log and 'ECONNREFUSED' not in log)
")"

print -r -- ""
print -r -- "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]] || exit 1
