#!/bin/bash
# Restart short dry (watch critical cases). Log inside container for dashboard.
set -euo pipefail
MAX_EVENTS="${1:-10}"
FILL="${2:-cruel}"
BUDGET="${3:-5}"
C=pair-path-micro
LOG=/tmp/scalp-e-golden-v2-dry.log

docker exec "$C" sh -c 'pkill -f "binance-lead-scalp/scalp-dry" 2>/dev/null || true' || true
sleep 2
docker exec "$C" sh -c "rm -f $LOG; : > $LOG"

docker exec -d "$C" sh -c "node scripts/binance-lead-scalp/scalp-dry.js \
  --variant=e-golden \
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

echo "STARTED short dry events=$MAX_EVENTS fill=$FILL budget=$BUDGET log=$LOG"
sleep 4
docker exec "$C" head -n 20 "$LOG" || true
