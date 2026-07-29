#!/bin/bash
# Dry micro-live with open cap +2¢ (up to 2 events or until open+hedge).
set -euo pipefail
MAX_ATTEMPTS="${1:-2}"
for i in $(seq 1 24); do
  C=$(docker ps --format '{{.Names}}' | grep rx06uazamupj1w98pvl2b1d9 | head -1 || true)
  if [ -n "$C" ]; then
    echo "CID=$C"
    docker exec "$C" mkdir -p /usr/src/app/scripts/pair-path
    docker cp /tmp/pair-path-micro-live.js "$C:/usr/src/app/scripts/pair-path/micro-live.js"
    echo "ARMED=$(docker exec "$C" printenv ENGINE_START_ARMED || true)"
    for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
      echo ""
      echo "======== DRY CAP2 ATTEMPT $attempt/$MAX_ATTEMPTS ========"
      docker exec "$C" node scripts/pair-path/micro-live.js \
        --max-events=1 \
        --open-shares=5 \
        --max-notional=8 \
        --open-cap-cents=2 \
        --min-tau-start=200 \
        --wait-timeout=400 \
        | tee "/tmp/pair-path-dry-cap2-${attempt}.log"
      if docker exec "$C" sh -c 'ls -t runs/pair-path-micro/btc-*.json 2>/dev/null | head -1 | xargs -r cat' | grep -q '"kind":"hedge"'; then
        echo "SUCCESS: open+hedge simulated"
        exit 0
      fi
      if docker exec "$C" sh -c 'ls -t runs/pair-path-micro/btc-*.json 2>/dev/null | head -1 | xargs -r cat' | grep -q '"kind":"open"'; then
        echo "PARTIAL: open only"
      else
        echo "NO TRADE"
      fi
    done
    echo "DONE without full open+hedge"
    exit 0
  fi
  echo "wait_$i"
  sleep 5
done
echo NO_CONTAINER
exit 1
