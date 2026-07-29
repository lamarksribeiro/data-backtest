#!/bin/bash
set -euo pipefail
docker rm -f pair-path-micro 2>/dev/null || true
# stop crash-loop engine if any
docker ps -aq --filter name=rx06uazamupj1w98pvl2b1d9 | xargs -r docker rm -f
echo "starting sidecar..."
docker run -d --name pair-path-micro \
  --network coolify \
  --env-file /data/coolify/applications/rx06uazamupj1w98pvl2b1d9/.env \
  -v rx06uazamupj1w98pvl2b1d9-engine-runs:/usr/src/app/runs \
  -w /usr/src/app \
  rx06uazamupj1w98pvl2b1d9:cee64b8ddf849ce122059942ab88df4e238fe84f \
  sleep infinity
sleep 2
docker ps | grep pair-path-micro
echo "ARMED=$(docker exec pair-path-micro printenv ENGINE_START_ARMED || true)"
mkdir -p /tmp
docker exec pair-path-micro mkdir -p /usr/src/app/scripts/pair-path /usr/src/app/src/feeds
docker cp /tmp/pair-path-micro-live.js pair-path-micro:/usr/src/app/scripts/pair-path/micro-live.js
docker cp /tmp/pair-path-clobFeed.js pair-path-micro:/usr/src/app/src/feeds/clobFeed.js
echo "=== MICRO LIVE #5 size10 GTC 5 events ==="
truncate -s 0 /tmp/pair-path-micro-live-v5.log
nohup docker exec pair-path-micro node scripts/pair-path/micro-live.js \
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
  --timeout=320 \
  > /tmp/pair-path-micro-live-v5.log 2>&1 &
sleep 8
head -35 /tmp/pair-path-micro-live-v5.log
ps aux | grep 'micro-live.js --live' | grep -v grep || echo NO_PROC
