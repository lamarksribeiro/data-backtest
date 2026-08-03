#!/bin/bash
# Binance-lead scalp E dry on Giovanna pair-path-micro (NO real orders).
# Usage on host: bash boot-dry.sh [max_events=12] [fill=honest]
set -euo pipefail
MAX_EVENTS="${1:-12}"
FILL="${2:-honest}"
C="pair-path-micro"

# Stop previous scalp-dry if any (leave other processes alone when possible)
docker exec "$C" sh -c 'pkill -f "binance-lead-scalp/scalp-dry" 2>/dev/null || true' || true

docker start "$C" >/dev/null 2>&1 || true
for i in $(seq 1 24); do
  if docker inspect "$C" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
    echo "CID=$C running"
    docker exec "$C" mkdir -p /usr/src/app/scripts /usr/src/app/src/feeds
    if [ -d /tmp/binance-lead-scalp ]; then
      docker exec "$C" rm -rf /usr/src/app/scripts/binance-lead-scalp
      docker cp /tmp/binance-lead-scalp "$C:/usr/src/app/scripts/binance-lead-scalp"
      echo "copied /tmp/binance-lead-scalp → scripts/binance-lead-scalp"
    else
      echo "WARN: /tmp/binance-lead-scalp missing — using image copy if any"
    fi
    if [ -f /tmp/binanceSpotFeed.js ]; then
      docker cp /tmp/binanceSpotFeed.js "$C:/usr/src/app/src/feeds/binanceSpotFeed.js"
      echo "copied binanceSpotFeed.js"
    fi
    if [ -f /tmp/marketState.js ]; then
      docker cp /tmp/marketState.js "$C:/usr/src/app/src/feeds/marketState.js"
      echo "copied marketState.js"
    fi
    echo "=== SCALP E DRY fill=${FILL} events=${MAX_EVENTS} ==="
    docker exec "$C" node scripts/binance-lead-scalp/scalp-dry.js \
      --max-events="$MAX_EVENTS" \
      --fill="$FILL" \
      --min-tau-start=60 \
      --poll-ms=50 \
      --max-book-age-ms=2500 \
      --wait-timeout=900 \
      --timeout=320 \
      --warm-sec=6 \
      --budget=10 \
      | tee /tmp/scalp-e-dry.log
    echo ""
    echo "=== last reports ==="
    docker exec "$C" sh -c 'ls -t runs/binance-lead-scalp-dry/*.json 2>/dev/null | head -3 | xargs -r -I{} sh -c "echo === {}; tail -c 2000 {}"' || true
    exit 0
  fi
  echo "wait_$i"
  sleep 5
done
echo NO_CONTAINER
exit 1
