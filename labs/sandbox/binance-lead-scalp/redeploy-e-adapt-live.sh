#!/bin/bash
set -euo pipefail
C=pair-path-micro
SRC=/tmp/binance-lead-scalp-clean2/binance-lead-scalp
if [ ! -f "$SRC/scalp-live.js" ]; then
  echo "missing $SRC/scalp-live.js"; ls -la /tmp/binance-lead-scalp-clean2 2>/dev/null || true; exit 1
fi
echo "SRC=$SRC"
grep -n "resolveFillPx\|postLadderSells\|retries ?? 5\|ladder_post_fail" "$SRC/scalp-live.js" | head -15

docker start "$C" >/dev/null 2>&1 || true
docker exec "$C" sh -c 'for p in $(ps -eo pid,args | grep -E "[n]ode scripts/binance-lead-scalp/scalp-(dry|live)" | awk "{print \$1}"); do kill -9 "$p" 2>/dev/null || true; done' || true
sleep 2
docker exec "$C" rm -rf /usr/src/app/scripts/binance-lead-scalp
docker cp "$SRC" "$C:/usr/src/app/scripts/binance-lead-scalp"
docker exec "$C" sh -c 'grep -c resolveFillPx /usr/src/app/scripts/binance-lead-scalp/scalp-live.js'

# rotate log
docker exec "$C" sh -c 'if [ -f /tmp/scalp-e-adapt-live.log ]; then mv /tmp/scalp-e-adapt-live.log /tmp/scalp-e-adapt-live.log.bak.$(date +%s); fi'

# gate
set +e
docker exec "$C" node scripts/binance-lead-scalp/scalp-live.js --max-events=1 >/tmp/scalp-live-gate.txt 2>&1
EC=$?
set -e
echo "gate_exit=$EC (expect 2)"
test "$EC" = "2"

# LIVE
docker exec -d "$C" sh -c 'node scripts/binance-lead-scalp/scalp-live.js --live --variant=e-adapt --max-events=6 --budget=10 --poll-ms=50 --min-tau-start=60 --warm-sec=8 --wait-timeout=900 --timeout=320 --max-session-notional=80 --max-session-loss=25 > /tmp/scalp-e-adapt-live.log 2>&1'
sleep 14
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep -E "[n]ode scripts/binance-lead-scalp/scalp-live" || echo NO_PROC'
echo "=== LOG HEAD ==="
docker exec "$C" head -n 45 /tmp/scalp-e-adapt-live.log
