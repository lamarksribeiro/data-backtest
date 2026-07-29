#!/bin/bash
set -euo pipefail
C=pair-path-micro
MAX_EVENTS="${1:-5}"
OPEN_SHARES="${2:-10}"
OPEN_CAP="${3:-3}"
MAX_NOTIONAL="${4:-16}"

docker cp /tmp/pair-path-micro-live.js "$C":/usr/src/app/scripts/pair-path/micro-live.js
pkill -f 'scripts/pair-path/micro-live.js' 2>/dev/null || true
sleep 1
echo "ARMED=$(docker exec "$C" printenv ENGINE_START_ARMED || true)"
truncate -s 0 /tmp/pair-path-dry-clip-deep3.log
nohup docker exec "$C" node scripts/pair-path/micro-live.js \
  --clip=deep3 \
  --max-events="$MAX_EVENTS" \
  --open-shares="$OPEN_SHARES" \
  --max-notional="$MAX_NOTIONAL" \
  --open-cap-cents="$OPEN_CAP" \
  --order-type=GTC \
  --settle-ms=1500 \
  --poll-ms=50 \
  --max-book-age-ms=2500 \
  --min-tau-start=120 \
  --wait-timeout=1200 \
  --timeout=320 \
  > /tmp/pair-path-dry-clip-deep3.log 2>&1 &
echo "BOOT_PID=$! cap=${OPEN_CAP}c events=${MAX_EVENTS}"
sleep 4
head -25 /tmp/pair-path-dry-clip-deep3.log
