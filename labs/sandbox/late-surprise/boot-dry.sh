#!/bin/bash
# Late Surprise m3-ask35 dry on Giovanna pair-path-micro (NO real orders).
# Usage on host: bash boot-dry.sh [max_events=50] [fill=honest]
set -euo pipefail
MAX_EVENTS="${1:-50}"
FILL="${2:-honest}"
C="pair-path-micro"

docker start "$C" >/dev/null 2>&1 || true
for i in $(seq 1 24); do
  if docker inspect "$C" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
    echo "CID=$C running"
    docker exec "$C" mkdir -p /usr/src/app/scripts
    if [ -d /tmp/late-surprise ]; then
      docker exec "$C" rm -rf /usr/src/app/scripts/late-surprise
      docker cp /tmp/late-surprise "$C:/usr/src/app/scripts/late-surprise"
      echo "copied /tmp/late-surprise"
    else
      echo "WARN: /tmp/late-surprise missing — using image copy if any"
    fi
    echo "=== LATE SURPRISE DRY fill=${FILL} events=${MAX_EVENTS} ==="
    docker exec "$C" node scripts/late-surprise/late-surprise-dry.js \
      --max-events="$MAX_EVENTS" \
      --fill="$FILL" \
      --min-tau-start=60 \
      --poll-ms=50 \
      --max-book-age-ms=2500 \
      --wait-timeout=900 \
      --timeout=320 \
      | tee /tmp/late-surprise-dry.log
    echo ""
    echo "=== last reports ==="
    docker exec "$C" sh -c 'ls -t runs/late-surprise-dry/*.json 2>/dev/null | head -3 | xargs -r -I{} sh -c "echo === {}; tail -c 2000 {}"' || true
    exit 0
  fi
  echo "wait_$i"
  sleep 5
done
echo NO_CONTAINER
exit 1
