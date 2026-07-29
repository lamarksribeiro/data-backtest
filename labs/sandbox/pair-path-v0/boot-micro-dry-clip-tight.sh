#!/bin/bash
# Clip-Path V1 dry on Giovanna data-robot container (NO real orders).
# Usage: bash boot-micro-dry-clip-tight.sh [max_events=2] [open_shares=10]
set -euo pipefail
MAX_EVENTS="${1:-2}"
OPEN_SHARES="${2:-10}"
# notional headroom: 10*0.62 + 10*0.42 ≈ 10.4 → use 16
MAX_NOTIONAL="${3:-16}"

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
    echo "=== CLIP-PATH DRY tight sh=${OPEN_SHARES} events=${MAX_EVENTS} ==="
    docker exec "$C" node scripts/pair-path/micro-live.js \
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
      --wait-timeout=900 \
      --timeout=320 \
      | tee /tmp/pair-path-dry-clip-tight.log
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
