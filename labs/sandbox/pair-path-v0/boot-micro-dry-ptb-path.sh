#!/bin/bash
# PTB-Path V1 dry on Giovanna data-robot (NO real orders).
# Usage: bash boot-micro-dry-ptb-path.sh [max_events=3] [open_shares=10] [open_leave_usd=30]
set -euo pipefail
MAX_EVENTS="${1:-3}"
OPEN_SHARES="${2:-10}"
OPEN_LEAVE="${3:-30}"
MAX_NOTIONAL="${4:-16}"

for i in $(seq 1 24); do
  C=$(docker ps --format '{{.Names}}' | grep rx06uazamupj1w98pvl2b1d9 | head -1 || true)
  if [ -n "$C" ]; then
    echo "CID=$C"
    docker exec "$C" mkdir -p /usr/src/app/scripts/pair-path
    if [ -f /tmp/pair-path-micro-live.js ]; then
      docker cp /tmp/pair-path-micro-live.js "$C:/usr/src/app/scripts/pair-path/micro-live.js"
      echo "copied /tmp/pair-path-micro-live.js"
    else
      echo "WARN: /tmp/pair-path-micro-live.js missing — using image copy"
    fi
    echo "ARMED=$(docker exec "$C" printenv ENGINE_START_ARMED || true)"
    echo "=== PTB-PATH DRY clip=ptb leave=${OPEN_LEAVE} sh=${OPEN_SHARES} events=${MAX_EVENTS} ==="
    docker exec "$C" node scripts/pair-path/micro-live.js \
      --clip=ptb \
      --open-leave-usd="$OPEN_LEAVE" \
      --hedge-mode=asap \
      --max-events="$MAX_EVENTS" \
      --open-shares="$OPEN_SHARES" \
      --max-notional="$MAX_NOTIONAL" \
      --open-cap-cents=2 \
      --order-type=GTC \
      --settle-ms=1500 \
      --poll-ms=50 \
      --max-book-age-ms=2500 \
      --min-tau-start=150 \
      --wait-timeout=900 \
      --timeout=320 \
      | tee /tmp/pair-path-dry-ptb-path.log
    echo ""
    echo "=== last report ==="
    docker exec "$C" sh -c 'ls -t runs/pair-path-micro/btc-*.json 2>/dev/null | head -1 | xargs -r cat' || true
    exit 0
  fi
  echo "wait_$i"
  sleep 5
done
echo NO_CONTAINER
exit 1
