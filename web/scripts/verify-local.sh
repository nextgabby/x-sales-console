#!/bin/zsh
# Verification of local single-user mode, against the production build.
#
# Two things are at stake. One, that someone who was using the console before sessions existed keeps
# their authorization and their advertisers instead of being quietly reset to a setup wizard. Two,
# that the local tool still needs no cookie — the person at the keyboard is the only user, and
# clearing cookies must not lock them out.
#
# Runs against a throwaway copy of a real installation, so it never writes to the live data
# directory. Point LIVE_DATA_DIR somewhere else to use a different one.
#
# Usage: zsh scripts/verify-local.sh
set -u

PORT=3992
LIVE_DATA_DIR=${LIVE_DATA_DIR:-$HOME/.x-ads-sales-console}
DD=/tmp/verify-local-data

[[ -f "$LIVE_DATA_DIR/connection.json" ]] || {
  print -r -- "No pre-sessions installation at $LIVE_DATA_DIR, so there is nothing to migrate."
  print -r -- "Set LIVE_DATA_DIR to one, or skip this script."
  exit 1
}

# A copy, with the new layout stripped back out, so the migration is exercised from the old state.
rm -rf "$DD"
cp -R "$LIVE_DATA_DIR" "$DD"
rm -rf "$DD/users" "$DD/.migrated" "$DD/app-keys.json"

EXPECTED=$(python3 -c "
import json
c=json.load(open('$DD/connection.json'))
s=json.load(open('$DD/spy-handles.json'))
f=json.load(open('$DD/favorites.json'))
print(json.dumps({
  'userId': c['userId'], 'handle': c['handle'], 'consumerKey': c['consumerKey'],
  'spyGrantCount': len(s), 'favoriteCount': len(f),
}))
")

echo "== storage =="
DATA_DIR="$DD" EXPECTED_LEGACY="$EXPECTED" \
  node --import ./scripts/ts-hook.mjs scripts/verify-local.mjs 2>/dev/null
STORE_STATUS=$?

PASS=0
FAIL=0
check() {
  if [[ "$2" == "True" ]]; then print -r -- "  PASS  $1"; PASS=$((PASS+1))
  else print -r -- "  FAIL  $1 ($2)"; FAIL=$((FAIL+1)); fi
}

# No DATABASE_URL, so this is the file backend. The dead API base keeps a real advertiser call from
# going out; the routes under test here resolve identity without reaching X.
DATA_DIR="$DD" APP_ORIGIN="http://127.0.0.1:$PORT" \
  X_ADS_API_BASE="http://127.0.0.1:1" XAI_API_BASE="http://127.0.0.1:1" \
  npx next start -p $PORT >/tmp/local-verify.log 2>&1 &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/connection" >/dev/null 2>&1 && break; sleep 1; done

B="http://127.0.0.1:$PORT"
HANDLE=$(E="$EXPECTED" python3 -c "import json,os; print(json.loads(os.environ['E'])['handle'])")
GRANTS=$(E="$EXPECTED" python3 -c "import json,os; print(json.loads(os.environ['E'])['spyGrantCount'])")

# Bodies go through files. Nested quoting inside a command substitution silently produces an empty
# body, which reads as a route bug rather than a test one.
print -r -- '{"consumerKey":"localkey","consumerSecret":"localsecret"}' > /tmp/l-keys.json

echo "== http =="
curl -s "$B/api/connection" > /tmp/l-conn.json
check "reports local mode, already connected" "$(python3 -c "
import json
d=json.load(open('/tmp/l-conn.json'))
print(d['hosted'] is False and d['isConnected'] is True and d['handle'] == '$HANDLE')
")"
check "the local wizard can still show which app's keys are in use" "$(python3 -c "
import json
d=json.load(open('/tmp/l-conn.json'))
print(d['consumerKeyPreview'] is not None and d['keysFromEnv'] is False)
")"
# The point of the fallback: no cookie was sent with any of these requests.
check "favourites resolve with no session cookie at all" "$(python3 -c "
print('$(curl -s -o /dev/null -w '%{http_code}' "$B/api/favorites")' == '200')
")"
check "the saved advertisers are served" "$(
curl -s "$B/api/spy" > /tmp/l-spy.json
python3 -c "
import json
d=json.load(open('/tmp/l-spy.json'))
print(len(d['spyGrants']) == $GRANTS)
"
)"
# No allowlist is set locally, and one must not be invented: that would lock a rep out of their own
# machine on upgrade.
check "an unset allowlist does not block the local user" "$(python3 -c "
import json
d=json.load(open('/tmp/l-conn.json'))
print(d['allowlistConfigured'] is False and d['isConnected'] is True)
")"
check "the local wizard can still store app keys" "$(python3 -c "
print('$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/setup" \
  -H 'content-type: application/json' --data @/tmp/l-keys.json)' == '200')
")"

echo "== nothing reached the network =="
check "no connection attempt to the dead API bases" "$(python3 -c "
log=open('/tmp/local-verify.log').read()
print('127.0.0.1:1' not in log and 'ECONNREFUSED' not in log)
")"

print -r -- ""
print -r -- "http passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 && $STORE_STATUS -eq 0 ]] || exit 1
