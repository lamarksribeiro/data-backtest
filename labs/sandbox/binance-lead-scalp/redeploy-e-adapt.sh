#!/bin/bash
set -euo pipefail
C=pair-path-micro
SRC=/tmp/binance-lead-scalp-clean
if [ ! -f "$SRC/scalp-dry.js" ]; then
  echo "missing $SRC/scalp-dry.js"; ls -la /tmp/binance-lead-scalp* 2>/dev/null || true; exit 1
fi
echo "SRC=$SRC"
grep -n "VARIANT_E_ADAPT\|rescue: true\|impulseVolMult: 2.5" "$SRC/scalp-engine.js" | head -10

docker exec "$C" sh -c 'for p in $(ps -eo pid,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" | awk "{print \$1}"); do kill "$p" 2>/dev/null || true; done' || true
sleep 2
docker exec "$C" rm -rf /usr/src/app/scripts/binance-lead-scalp
docker cp "$SRC" "$C:/usr/src/app/scripts/binance-lead-scalp"
docker exec "$C" sh -c 'head -n 8 /usr/src/app/scripts/binance-lead-scalp/scalp-dry.js; grep -c VARIANT_E_ADAPT /usr/src/app/scripts/binance-lead-scalp/scalp-engine.js; grep -n "rescue: true" /usr/src/app/scripts/binance-lead-scalp/scalp-engine.js | head -3'

docker exec -d "$C" sh -c 'node scripts/binance-lead-scalp/scalp-dry.js --variant=e-adapt --max-events=48 --fill=honest --poll-ms=50 --min-tau-start=60 --warm-sec=8 --budget=10 --wait-timeout=900 --timeout=320 > /tmp/scalp-e-adapt-dry.log 2>&1'
sleep 10
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
echo "=== LOG HEAD ==="
docker exec "$C" head -n 35 /tmp/scalp-e-adapt-dry.log
