#!/bin/bash
# Start scalp E dry in background inside pair-path-micro
C=pair-path-micro
docker start "$C" >/dev/null 2>&1 || true

# Kill only node scalp-dry (not this script)
docker exec "$C" sh -c 'for p in $(ps -eo pid,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" | awk "{print \$1}"); do kill "$p" 2>/dev/null || true; done' || true
sleep 2

docker exec -d "$C" sh -c 'node scripts/binance-lead-scalp/scalp-dry.js --max-events=24 --fill=honest --poll-ms=50 --min-tau-start=60 --warm-sec=6 --budget=10 --wait-timeout=900 --timeout=320 > /tmp/scalp-e-dry.log 2>&1'
sleep 8

echo "=== process ==="
docker exec "$C" sh -c 'ps -eo pid,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
echo "=== files ==="
docker exec "$C" ls -la /usr/src/app/scripts/binance-lead-scalp/
echo "=== log ==="
docker exec "$C" cat /tmp/scalp-e-dry.log 2>/dev/null | tail -n 60 || echo NO_LOG
