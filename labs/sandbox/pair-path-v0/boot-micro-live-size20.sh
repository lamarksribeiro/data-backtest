#!/bin/bash
# Pair-Path micro LIVE size20: GTC, feed heal, 5 events, notional 30.
set -euo pipefail

C=pair-path-micro

# If container missing, recreate like size15 boot
if ! docker ps --format '{{.Names}}' | grep -qx "$C"; then
  echo "container missing — recreating sidecar..."
  docker rm -f "$C" 2>/dev/null || true
  docker ps -aq --filter name=rx06uazamupj1w98pvl2b1d9 | xargs -r docker rm -f || true
  docker run -d --name "$C" \
    --network coolify \
    --env-file /data/coolify/applications/rx06uazamupj1w98pvl2b1d9/.env \
    -v rx06uazamupj1w98pvl2b1d9-engine-runs:/usr/src/app/runs \
    -w /usr/src/app \
    rx06uazamupj1w98pvl2b1d9:cee64b8ddf849ce122059942ab88df4e238fe84f \
    sleep infinity
  sleep 2
fi

# Stop any leftover micro-live inside container (do not kill unrelated)
docker exec "$C" sh -c "pkill -f 'scripts/pair-path/micro-live.js' 2>/dev/null || true" || true
sleep 1

docker exec "$C" mkdir -p /usr/src/app/scripts/pair-path /usr/src/app/src/feeds
docker cp /tmp/pair-path-micro-live.js "$C":/usr/src/app/scripts/pair-path/micro-live.js
docker cp /tmp/pair-path-clobFeed.js "$C":/usr/src/app/src/feeds/clobFeed.js

echo "=== MICRO LIVE size20 GTC max-events=5 notional=30 ==="
truncate -s 0 /tmp/pair-path-micro-live-size20.log
nohup docker exec "$C" node scripts/pair-path/micro-live.js \
  --live \
  --max-events=5 \
  --open-shares=20 \
  --max-notional=30 \
  --open-cap-cents=2 \
  --order-type=GTC \
  --settle-ms=1500 \
  --poll-ms=50 \
  --max-book-age-ms=2500 \
  --min-tau-start=150 \
  --wait-timeout=1200 \
  --timeout=320 \
  > /tmp/pair-path-micro-live-size20.log 2>&1 &
sleep 8
head -35 /tmp/pair-path-micro-live-size20.log
docker exec "$C" ps aux | grep micro-live | grep -v grep || echo NO_PROC
