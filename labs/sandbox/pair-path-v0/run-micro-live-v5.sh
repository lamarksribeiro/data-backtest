#!/bin/bash
# Pair-Path micro LIVE #5: size10, GTC, feed heal (poll 50ms, maxBookAge 2.5s), 5 events.
set -euo pipefail
for i in $(seq 1 48); do
  C=$(docker ps --format '{{.Names}}' | grep rx06uazamupj1w98pvl2b1d9 | head -1 || true)
  if [ -n "$C" ]; then
    echo "CID=$C"
    docker exec "$C" mkdir -p /usr/src/app/scripts/pair-path /usr/src/app/src/feeds
    docker cp /tmp/pair-path-micro-live.js "$C:/usr/src/app/scripts/pair-path/micro-live.js"
    docker cp /tmp/pair-path-clobFeed.js "$C:/usr/src/app/src/feeds/clobFeed.js"
    echo "ARMED=$(docker exec "$C" printenv ENGINE_START_ARMED || true)"
    echo "=== MICRO LIVE #5 size10 GTC feed-heal max-events=5 ==="
    docker exec "$C" node scripts/pair-path/micro-live.js \
      --live \
      --max-events=5 \
      --open-shares=10 \
      --max-notional=16 \
      --open-cap-cents=2 \
      --order-type=GTC \
      --settle-ms=1500 \
      --poll-ms=50 \
      --max-book-age-ms=2500 \
      --min-tau-start=150 \
      --wait-timeout=1200 \
      --timeout=320
    exit $?
  fi
  echo "wait_$i"
  sleep 5
done
echo NO_CONTAINER
exit 1
