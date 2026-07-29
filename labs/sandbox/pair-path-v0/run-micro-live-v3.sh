#!/bin/bash
# Pair-Path micro LIVE #3: size5, cap+2¢, GTC settle, up to 3 events, tau>=200.
set -euo pipefail
for i in $(seq 1 48); do
  C=$(docker ps --format '{{.Names}}' | grep rx06uazamupj1w98pvl2b1d9 | head -1 || true)
  if [ -n "$C" ]; then
    echo "CID=$C"
    docker exec "$C" mkdir -p /usr/src/app/scripts/pair-path
    docker cp /tmp/pair-path-micro-live.js "$C:/usr/src/app/scripts/pair-path/micro-live.js"
    echo "ARMED=$(docker exec "$C" printenv ENGINE_START_ARMED || true)"
    echo "=== MICRO LIVE #3 size5 cap2 GTC max-events=3 ==="
    docker exec "$C" node scripts/pair-path/micro-live.js \
      --live \
      --max-events=3 \
      --open-shares=5 \
      --max-notional=8 \
      --open-cap-cents=2 \
      --order-type=GTC \
      --settle-ms=1200 \
      --min-tau-start=200 \
      --wait-timeout=900 \
      --timeout=320
    exit $?
  fi
  echo "wait_$i"
  sleep 5
done
echo NO_CONTAINER
exit 1
