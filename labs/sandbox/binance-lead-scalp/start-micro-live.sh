#!/bin/bash
# Micro LIVE e-golden V2.2 — ordens reais. Dashboard lê /tmp/scalp-e-adapt-live.log
# Usage: bash start-micro-live.sh [max_events=8] [budget=5]
set -euo pipefail
MAX_EVENTS="${1:-8}"
BUDGET="${2:-5}"
NOTIONAL="${3:-40}"
MAX_LOSS="${4:-8}"
C=pair-path-micro
LOG=/tmp/scalp-e-adapt-live.log

docker start "$C" >/dev/null 2>&1 || true

# Stop dry + live previous
docker exec "$C" sh -c 'for p in $(ps -eo pid,args | grep -E "[n]ode scripts/binance-lead-scalp/scalp-(dry|live)" | awk "{print \$1}"); do kill -TERM "$p" 2>/dev/null || true; done' || true
sleep 3
docker exec "$C" sh -c 'for p in $(ps -eo pid,args | grep -E "[n]ode scripts/binance-lead-scalp/scalp-(dry|live)" | awk "{print \$1}"); do kill -9 "$p" 2>/dev/null || true; done' || true
sleep 1

# Cancel leftover open orders (best-effort)
docker exec "$C" node scripts/binance-lead-scalp/cancel-open.js >/tmp/scalp-cancel-preflight.txt 2>&1 || true
echo "=== cancel preflight ==="
tail -n 20 /tmp/scalp-cancel-preflight.txt || true

# Rotate log
docker exec "$C" sh -c "if [ -f $LOG ]; then mv $LOG ${LOG}.bak.\$(date +%s); fi; : > $LOG"

# Gate: sem --live deve exit 2
set +e
docker exec "$C" node scripts/binance-lead-scalp/scalp-live.js --max-events=1 >/tmp/scalp-live-gate.txt 2>&1
EC=$?
set -e
echo "gate_exit=$EC (expect 2)"
test "$EC" = "2"

echo "=== START MICRO LIVE e-golden V2.2 events=$MAX_EVENTS budget=\$$BUDGET notional=\$$NOTIONAL maxLoss=\$$MAX_LOSS ==="
docker exec -d "$C" sh -c "node scripts/binance-lead-scalp/scalp-live.js \
  --live \
  --variant=e-golden \
  --max-events=${MAX_EVENTS} \
  --budget=${BUDGET} \
  --poll-ms=50 \
  --min-tau-start=60 \
  --warm-sec=8 \
  --wait-timeout=900 \
  --timeout=320 \
  --max-book-age-ms=2500 \
  --max-session-notional=${NOTIONAL} \
  --max-session-loss=${MAX_LOSS} \
  --rescue-stop=0.25 \
  > ${LOG} 2>&1"

sleep 10
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep -E "[n]ode scripts/binance-lead-scalp/scalp-live" || echo NO_PROC'
echo "=== LOG HEAD ==="
docker exec "$C" head -n 40 "$LOG" || true
