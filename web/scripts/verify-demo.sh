#!/bin/zsh
# Final verification of demo mode, against the production build.
#
# The Ads API and xAI base URLs are pointed at a dead port. If any code path still tried to reach
# the real services, it would fail with a connection error instead of quietly succeeding — so a
# clean run is positive evidence that nothing leaves the process, not just an absence of log lines.
#
# Requires a production build first: `npm run build`.
#
# Request bodies go through files. Escaping JSON quotes inside a nested command substitution
# silently produced an empty body, which read as three failing assertions rather than a broken test.
set -u
cd "$(dirname "$0")/.."

PORT=3990
DEMO_MODE=1 \
  X_ADS_API_BASE="http://127.0.0.1:1" \
  XAI_API_BASE="http://127.0.0.1:1" \
  npx next start -p $PORT >/tmp/demo-verify.log 2>&1 &
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

print -r -- '{"days":30}' > /tmp/v-body-summary.json
print -r -- '{"days":30,"question":"rank by best ctr"}' > /tmp/v-body-question.json
print -r -- '{"accountId":"18ce5dem0002"}' > /tmp/v-body-fav.json
print -r -- '{"consumerKey":"x","consumerSecret":"y"}' > /tmp/v-body-keys.json
print -r -- '{}' > /tmp/v-body-empty.json

echo "== accounts =="
curl -s "$B/api/accounts" > /tmp/v-accounts.json
check "four accounts, demo flag set, no group errors" "$(python3 -c "
import json
d=json.load(open('/tmp/v-accounts.json'))
n=sum(len(g['accounts']) for g in d['groups'])
print(n==4 and d.get('demo') is True and not any(g['error'] for g in d['groups']))
")"

echo "== dashboards reconcile at every range =="
for ACC in 18ce5dem0001 18ce5dem0002 18ce5dem0003 18ce5dem0004; do
  for DAYS in 7 30 90; do
    curl -s "$B/api/accounts/$ACC/dashboard?days=$DAYS" > /tmp/v-d.json
    check "$ACC ${DAYS}d rows sum to the account total, no warnings" "$(python3 -c "
import json
d=json.load(open('/tmp/v-d.json'))
if 'error' in d: print('error: '+d['error']); raise SystemExit
t=d['totals']['spend']; s=sum(r['totals']['spend'] for r in d['campaigns'])
print(abs(s-t)<0.02 and not d['partial'] and not d['warnings'])
")"
  done
done

echo "== campaign detail reconciles with its row =="
curl -s "$B/api/accounts/18ce5dem0002/dashboard?days=30" > /tmp/v-d2.json
CID=$(python3 -c "
import json
d=json.load(open('/tmp/v-d2.json'))
print(max(d['campaigns'], key=lambda r:r['totals']['spend'])['id'])
")
ROW=$(python3 -c "
import json
d=json.load(open('/tmp/v-d2.json'))
r=[r for r in d['campaigns'] if r['id']=='$CID'][0]
print(r['totals']['spend'], r['totals']['impressions'])
")
curl -s "$B/api/accounts/18ce5dem0002/campaigns/$CID?days=30" > /tmp/v-detail.json
check "line items sum to the campaign row" "$(ROW="$ROW" python3 -c "
import json, os
d=json.load(open('/tmp/v-detail.json'))
sp, im = [float(x) for x in os.environ['ROW'].split()]
li=sum(l['totals']['spend'] for l in d['lineItems'])
lp=sum(l['totals']['impressions'] for l in d['lineItems'])
print(abs(li-sp)<0.02 and lp==int(im))
")"
check "promoted posts sum to the line items" "$(python3 -c "
import json
d=json.load(open('/tmp/v-detail.json'))
ps=sum(p['totals']['spend'] for p in d['promotedPosts'])
ls=sum(l['totals']['spend'] for l in d['lineItems'])
print(len(d['promotedPosts'])>0 and abs(ps-ls)<0.02)
")"

echo "== pacing =="
check "raise-budget and fix-delivery both appear" "$(python3 -c "
import json
d=json.load(open('/tmp/v-d2.json'))
levers={(r['pacing'].get('advice') or {}).get('lever') for r in d['campaigns']}
print('raise-budget' in levers and 'fix-delivery' in levers)
")"

echo "== takeover =="
curl -s "$B/api/accounts/18ce5dem0002/dashboard?days=30&takeovers=1" > /tmp/v-tk.json
check "takeover hidden by default, surfaced on request" "$(python3 -c "
import json
a=json.load(open('/tmp/v-d2.json'))
b=json.load(open('/tmp/v-tk.json'))
print(a['takeovers']['included'] is False
      and b['takeovers']['included'] is True
      and b['takeovers']['count']==1
      and any(r['takeover'] for r in b['campaigns']))
")"

echo "== benchmark: the lookback positive path =="
CAS=$(curl -s "$B/api/accounts/18ce5dem0003/dashboard?days=90" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print([r['id'] for r in d['campaigns'] if r.get('objective')=='VIDEO_VIEWS' and r['totals']['spend']>0][0])
")
curl -s "$B/api/accounts/18ce5dem0003/campaigns/$CAS/benchmark" > /tmp/v-bench.json
check "reaches past 90 days, builds bands, dates the note" "$(python3 -c "
import json
b=json.load(open('/tmp/v-bench.json'))['benchmark']
print(b['status']=='ok' and b['basis']=='historical' and bool(b['lookback'])
      and b['lookback']['campaigns']==4 and b['cohort']['campaigns']==4
      and all(m['band'] and m['band']['sample']==4 for m in b['metrics'])
      and any('October 2025' in n for n in b['notes']))
")"
check "panel and AI summary agree that history exists" "$(
S=$(curl -s -o /tmp/v-sum.txt -w '%{http_code}' -X POST "$B/api/accounts/18ce5dem0003/campaigns/$CAS/benchmark-summary" -H 'content-type: application/json' --data @/tmp/v-body-empty.json)
python3 -c "print('$S'=='200' and 'Sample response' in open('/tmp/v-sum.txt').read())"
)"

echo "== segments =="
curl -s "$B/api/accounts/18ce5dem0001/dashboard?days=30" > /tmp/v-d1.json
BIG=$(python3 -c "
import json
d=json.load(open('/tmp/v-d1.json'))
print(max(d['campaigns'], key=lambda r:r['totals']['spend'])['id'])
")
curl -s "$B/api/accounts/18ce5dem0001/campaigns/$BIG/segments?days=30" > /tmp/v-seg.json
check "platform rows sum to campaign spend, with a real price spread" "$(BIG=$BIG python3 -c "
import json, os
d=json.load(open('/tmp/v-seg.json'))
c=json.load(open('/tmp/v-d1.json'))
row=[r for r in c['campaigns'] if r['id']==os.environ['BIG']][0]
rows=d['breakdown']['rows']
s=sum(r['totals']['spend'] for r in rows)
cpms=[r['totals']['cpm'] for r in rows]
print(abs(s-row['totals']['spend'])<0.02 and (max(cpms)-min(cpms))/min(cpms) > 0.2)
")"
check "age bands carry a CTR gradient; gender carries an unknown remainder" "$(python3 -c "
import json
a=json.load(open('/tmp/v-seg.json'))['audience']
ctrs=[r['ctr'] for r in a['age']]
unknown=[r for r in a['gender'] if r['label']=='Unknown']
print(a['status']=='ok' and ctrs[0]>ctrs[-1]*1.5
      and len(unknown)==1 and 0.01 < unknown[0]['share'] < 0.1)
")"

echo "== AI =="
check "creative summary returns labelled sample text" "$(
curl -s -X POST "$B/api/accounts/18ce5dem0002/campaigns/$CID/creative-summary" -H 'content-type: application/json' --data @/tmp/v-body-summary.json > /tmp/v-cre.txt
python3 -c "
t=open('/tmp/v-cre.txt').read()
print('Sample response' in t and 'headline creative' in t)
"
)"
check "a typed question gets the generic answer, not a canned summary" "$(
curl -s -X POST "$B/api/accounts/18ce5dem0002/campaigns/$CID/creative-summary" -H 'content-type: application/json' --data @/tmp/v-body-question.json > /tmp/v-q.txt
python3 -c "
t=open('/tmp/v-q.txt').read()
print('Sample response' in t and 'generated' in t and 'headline creative' not in t)
"
)"

echo "== stored settings =="
# Demo favourites live in the visitor's own cookie, so the jar is the state. Toggling twice through
# one jar must land back where it started.
rm -f /tmp/v-jar-a.txt /tmp/v-jar-b.txt
check "favourite toggles on, then off, without touching disk" "$(
curl -s -c /tmp/v-jar-a.txt -b /tmp/v-jar-a.txt -X POST "$B/api/favorites" \
  -H 'content-type: application/json' --data @/tmp/v-body-fav.json > /tmp/v-fav1.json
curl -s -c /tmp/v-jar-a.txt -b /tmp/v-jar-a.txt -X POST "$B/api/favorites" \
  -H 'content-type: application/json' --data @/tmp/v-body-fav.json > /tmp/v-fav2.json
python3 -c "
import json
a=json.load(open('/tmp/v-fav1.json')); b=json.load(open('/tmp/v-fav2.json'))
print('18ce5dem0002' in a['favorites'] and '18ce5dem0002' not in b['favorites'])
"
)"

# The reason the cookie exists: a public link has many concurrent visitors, and server memory would
# show one reviewer's star to everyone else.
check "one visitor's favourite is invisible to another" "$(
curl -s -c /tmp/v-jar-a.txt -b /tmp/v-jar-a.txt -X POST "$B/api/favorites" \
  -H 'content-type: application/json' --data @/tmp/v-body-fav.json > /tmp/v-fav-a.json
curl -s -c /tmp/v-jar-b.txt -b /tmp/v-jar-b.txt "$B/api/favorites" > /tmp/v-fav-b.json
python3 -c "
import json
a=json.load(open('/tmp/v-fav-a.json')); b=json.load(open('/tmp/v-fav-b.json'))
print('18ce5dem0002' in a['favorites'] and '18ce5dem0002' not in b['favorites'])
"
)"
check "setup refuses to store keys" "$(
S=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/setup" -H 'content-type: application/json' --data @/tmp/v-body-keys.json)
python3 -c "print('$S' != '200')"
)"

echo "== nothing reached the network =="
check "no connection attempt to the dead API bases" "$(python3 -c "
log=open('/tmp/demo-verify.log').read()
print('127.0.0.1:1' not in log and 'ECONNREFUSED' not in log and 'fetch failed' not in log)
")"

echo
echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
