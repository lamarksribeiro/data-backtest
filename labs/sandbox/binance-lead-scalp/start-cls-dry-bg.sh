#!/bin/bash
# CLS-v1 dry on Giovanna pair-path-micro (NO real orders).
# Usage: bash start-cls-dry-bg.sh [max_events=96] [fill=cruel] [budget=5]
set -euo pipefail
MAX_EVENTS="${1:-96}"
FILL="${2:-cruel}"
BUDGET="${3:-5}"
C=pair-path-micro
LOG=/tmp/cls-v1-dry.log

# Stop previous CLS dry only (leave other strategies alone)
docker exec "$C" sh -c 'pkill -f "binance-lead-scalp/scalp-dry.js --variant=cls" 2>/dev/null || true' || true
sleep 1

docker start "$C" >/dev/null 2>&1 || true

docker exec -d "$C" sh -c "node scripts/binance-lead-scalp/scalp-dry.js \
  --variant=cls \
  --max-events=${MAX_EVENTS} \
  --fill=${FILL} \
  --budget=${BUDGET} \
  --min-tau-start=60 \
  --poll-ms=50 \
  --max-book-age-ms=2500 \
  --wait-timeout=900 \
  --timeout=320 \
  --warm-sec=6 \
  > ${LOG} 2>&1"

echo "STARTED CLS-v1 dry container=$C log=${LOG} events=$MAX_EVENTS fill=$FILL budget=$BUDGET"
sleep 5
docker exec "$C" tail -n 50 "$LOG" || true
