#!/bin/bash
# Clip-Path V1 LIVE micro on Giovanna — REAL ORDERS. Confirm before running.
# Usage: bash boot-micro-live-clip-tight.sh [max_events=1] [open_shares=10]
set -euo pipefail
MAX_EVENTS="${1:-1}"
OPEN_SHARES="${2:-10}"
MAX_NOTIONAL="${3:-16}"

docker rm -f pair-path-micro 2>/dev/null || true
echo "starting sidecar..."
docker run -d --name pair-path-micro \
  --network coolify \
  --env-file /data/coolify/applications/rx06uazamupj1w98pvl2b1d9/.env \
  -v rx06uazamupj1w98pvl2b1d9-engine-runs:/usr/src/app/runs \
  -w /usr/src/app \
  $(docker ps --filter name=rx06uazamupj1w98pvl2b1d9 --format '{{.Image}}' | head -1) \
  sleep infinity
sleep 2
docker ps | grep pair-path-micro
echo "ARMED=$(docker exec pair-path-micro printenv ENGINE_START_ARMED || true)"
mkdir -p /tmp
docker exec pair-path-micro mkdir -p /usr/src/app/scripts/pair-path
docker cp /tmp/pair-path-micro-live.js pair-path-micro:/usr/src/app/scripts/pair-path/micro-live.js
echo "=== CLIP-PATH LIVE tight sh=${OPEN_SHARES} events=${MAX_EVENTS} ==="
truncate -s 0 /tmp/pair-path-live-clip-tight.log
nohup docker exec pair-path-micro node scripts/pair-path/micro-live.js \
  --live \
  --clip=tight \
  --max-events="$MAX_EVENTS" \
  --open-shares="$OPEN_SHARES" \
  --max-notional="$MAX_NOTIONAL" \
  --open-cap-cents=2 \
  --order-type=GTC \
  --settle-ms=1500 \
  --poll-ms=50 \
  --max-book-age-ms=2500 \
  --min-tau-start=150 \
  --wait-timeout=1200 \
  --timeout=320 \
  > /tmp/pair-path-live-clip-tight.log 2>&1 &
sleep 8
head -40 /tmp/pair-path-live-clip-tight.log
ps aux | grep 'micro-live.js --live' | grep -v grep || echo NO_PROC
