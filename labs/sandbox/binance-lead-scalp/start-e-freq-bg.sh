#!/bin/bash
# Restart scalp dry as E-freq on pair-path-micro
C=pair-path-micro
docker start "$C" >/dev/null 2>&1 || true

docker exec "$C" sh -c 'for p in $(ps -eo pid,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" | awk "{print \$1}"); do kill "$p" 2>/dev/null || true; done' || true
sleep 2

if [ -d /tmp/binance-lead-scalp ]; then
  docker exec "$C" rm -rf /usr/src/app/scripts/binance-lead-scalp
  docker cp /tmp/binance-lead-scalp "$C:/usr/src/app/scripts/binance-lead-scalp"
  echo "copied scripts"
fi

docker exec -d "$C" sh -c 'node scripts/binance-lead-scalp/scalp-dry.js --variant=e-freq --max-events=24 --fill=honest --poll-ms=50 --min-tau-start=60 --warm-sec=6 --budget=10 --wait-timeout=900 --timeout=320 > /tmp/scalp-e-freq-dry.log 2>&1'
sleep 8
echo "=== process ==="
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
echo "=== log ==="
docker exec "$C" tail -n 25 /tmp/scalp-e-freq-dry.log
