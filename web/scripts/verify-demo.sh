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

echo "== targeting =="
RT=$(python3 -c "
import json
d=json.load(open('/tmp/v-d1.json'))
print([r['id'] for r in d['campaigns'] if r['name'].startswith('Retargeting')][0])
")
curl -s "$B/api/accounts/18ce5dem0001/campaigns/$RT?days=30" > /tmp/v-tgt.json
check "custom audience ids resolve to names, and the dead list is flagged" "$(python3 -c "
import json
t=json.load(open('/tmp/v-tgt.json'))['targeting']
g=[x for x in t['groups'] if x['type']=='CUSTOM_AUDIENCE'][0]
names={v['label'] for v in g['included']}
dead=[v for v in g['included'] if v.get('missing')]
print(t['status']=='ok'
      and 'Lapsed Installs | 30 Days' in names
      and len(dead)==1 and dead[0]['label']=='Spring CRM Upload | 2023'
      and [v['label'] for v in g['excluded']]==['App Purchasers | All Time'])
")"
check "the exclusion is reported without being called a mistake" "$(python3 -c "
import json
t=json.load(open('/tmp/v-tgt.json'))['targeting']
s=[x for x in t['signals'] if x['title'].endswith('exclusions') or x['title'].endswith('exclusion')]
print(len(s)==1 and 'deliberate' in s[0]['detail'])
")"
check "country applies to every line item, the audiences to one" "$(python3 -c "
import json
t=json.load(open('/tmp/v-tgt.json'))['targeting']
loc=[x for x in t['groups'] if x['type']=='LOCATION'][0]['included'][0]
aud=[x for x in t['groups'] if x['type']=='CUSTOM_AUDIENCE'][0]['included'][0]
print(t['lineItems']==2 and loc['everywhere'] is True and len(loc['lineItemIds'])==2
      and aud['everywhere'] is False and len(aud['lineItemIds'])==1)
")"
check "raw enums are humanised, not echoed back as the group label" "$(python3 -c "
import json
t=json.load(open('/tmp/v-tgt.json'))['targeting']
eng=[x for x in t['groups'] if x['type']=='ENGAGEMENT_TYPE'][0]
age=[x for x in t['groups'] if x['type']=='AGE'][0]
print(eng['label']=='Engagement retargeting'
      and [v['label'] for v in eng['included']]==['Impression']
      and [v['label'] for v in age['included']]==['18 and over'])
")"
SUS=$(python3 -c "
import json
d=json.load(open('/tmp/v-d1.json'))
print([r['id'] for r in d['campaigns'] if r['name']=='Brand Reach — Sustain'][0])
")
curl -s "$B/api/accounts/18ce5dem0001/campaigns/$SUS?days=30" > /tmp/v-tgt2.json
check "a line item with no criteria is counted and named as unconstrained" "$(python3 -c "
import json
t=json.load(open('/tmp/v-tgt2.json'))['targeting']
s=[x for x in t['signals'] if 'untargeted' in x['title']]
print(t['untargetedLineItems']==1 and len(s)==1 and 'unconstrained' in s[0]['detail'])
")"
LK=$(python3 -c "
import json
d=json.load(open('/tmp/v-d1.json'))
print([r['id'] for r in d['campaigns'] if r['name'].startswith('Lookalike')][0])
")
curl -s "$B/api/accounts/18ce5dem0001/campaigns/$LK?days=30" > /tmp/v-tgt3.json
check "a handle targeted directly and as a lookalike is called out once" "$(python3 -c "
import json
t=json.load(open('/tmp/v-tgt3.json'))['targeting']
s=[x for x in t['signals'] if 'lookalike' in x['title']]
print(len(s)==1 and '@lumenfitness' in s[0]['detail'])
")"

echo "== AI =="
check "targeting review returns labelled sample text" "$(
curl -s -X POST "$B/api/accounts/18ce5dem0001/campaigns/$RT/targeting-summary" -H 'content-type: application/json' --data @/tmp/v-body-empty.json > /tmp/v-trev.txt
python3 -c "
t=open('/tmp/v-trev.txt').read()
print('Sample response' in t and 'broad companion' in t)
"
)"
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
