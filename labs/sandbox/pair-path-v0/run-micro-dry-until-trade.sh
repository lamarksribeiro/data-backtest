#!/bin/bash
# Dry micro-live until we see fills (open+hedge) or max attempts.
set -euo pipefail

MAX_ATTEMPTS="${1:-3}"
OPEN_SHARES="${2:-5}"
MAX_NOTIONAL="${3:-8}"
MIN_TAU="${4:-200}"

for i in $(seq 1 24); do
  C=$(docker ps --format '{{.Names}}' | grep rx06uazamupj1w98pvl2b1d9 | head -1 || true)
  if [ -n "$C" ]; then
    echo "CID=$C"
    docker exec "$C" mkdir -p /usr/src/app/scripts/pair-path
    docker cp /tmp/pair-path-micro-live.js "$C:/usr/src/app/scripts/pair-path/micro-live.js"
    echo "ARMED=$(docker exec "$C" printenv ENGINE_START_ARMED || true)"

    for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
      echo ""
      echo "======== DRY ATTEMPT $attempt/$MAX_ATTEMPTS ========"
      docker exec "$C" node scripts/pair-path/micro-live.js \
        --max-events=1 \
        --open-shares="$OPEN_SHARES" \
        --max-notional="$MAX_NOTIONAL" \
        --min-tau-start="$MIN_TAU" \
        --wait-timeout=400 \
        | tee "/tmp/pair-path-dry-attempt-${attempt}.log"

      # Check latest event report for fills
      FILLS=$(docker exec "$C" sh -c 'ls -t runs/pair-path-micro/btc-*.json 2>/dev/null | head -1 | xargs -r cat' | grep -o '"fills":\[[^]]*\]' | head -1 || true)
      MODE=$(docker exec "$C" sh -c 'ls -t runs/pair-path-micro/btc-*.json 2>/dev/null | head -1 | xargs -r cat' | grep -o '"mode":"[^"]*"' | head -1 || true)
      echo "last report: $MODE $FILLS"

      if docker exec "$C" sh -c 'ls -t runs/pair-path-micro/btc-*.json 2>/dev/null | head -1 | xargs -r cat' | grep -q '"kind":"hedge"'; then
        echo "SUCCESS: saw hedge fill (simulated)"
        exit 0
      fi
      if docker exec "$C" sh -c 'ls -t runs/pair-path-micro/btc-*.json 2>/dev/null | head -1 | xargs -r cat' | grep -q '"kind":"open"'; then
        echo "PARTIAL: saw open only — try another event"
      else
        echo "NO TRADE: skip/miss — try another event"
      fi
    done
    echo "DONE attempts without full open+hedge"
    exit 0
  fi
  echo "wait_$i"
  sleep 5
done
echo "NO_CONTAINER"
exit 1
