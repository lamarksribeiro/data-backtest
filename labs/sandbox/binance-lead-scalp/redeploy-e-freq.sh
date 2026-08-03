#!/bin/bash
set -euo pipefail
C=pair-path-micro
SRC=/tmp/binance-lead-scalp-clean
if [ ! -f "$SRC/scalp-dry.js" ]; then
  echo "missing $SRC/scalp-dry.js"; ls -la /tmp/binance-lead-scalp-clean 2>/dev/null || true; exit 1
fi
echo "SRC=$SRC"
grep -n "VARIANT_E_FREQ\|impulseUsd: 8" "$SRC/scalp-engine.js" | head -5

docker exec "$C" sh -c 'for p in $(ps -eo pid,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" | awk "{print \$1}"); do kill "$p" 2>/dev/null || true; done' || true
sleep 2
docker exec "$C" rm -rf /usr/src/app/scripts/binance-lead-scalp
docker cp "$SRC" "$C:/usr/src/app/scripts/binance-lead-scalp"
docker exec "$C" sh -c 'head -n 3 /usr/src/app/scripts/binance-lead-scalp/scalp-dry.js; grep -c VARIANT_E_FREQ /usr/src/app/scripts/binance-lead-scalp/scalp-engine.js'

docker exec -d "$C" sh -c 'node scripts/binance-lead-scalp/scalp-dry.js --variant=e-freq --max-events=24 --fill=honest --poll-ms=50 --min-tau-start=60 --warm-sec=6 --budget=10 --wait-timeout=900 --timeout=320 > /tmp/scalp-e-freq-dry.log 2>&1'
sleep 8
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
docker exec "$C" cat /tmp/scalp-e-freq-dry.log | head -n 30
