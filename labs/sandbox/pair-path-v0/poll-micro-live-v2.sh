#!/bin/bash
LOG=/tmp/pair-path-micro-live-v2.log
while true; do
  TS=$(date -u +%H:%M:%SZ)
  UP=$(docker ps --format '{{.Status}}' --filter name=rx06uazamupj1w98pvl2b1d9 2>/dev/null | head -1 || true)
  PROC=$(ps aux | grep -E 'run-micro-live-v2|micro-live.js --live' | grep -v grep | wc -l)
  TAIL=$(tail -15 "$LOG" 2>/dev/null || true)
  echo "=== UPDATE $TS ==="
  echo "engine: ${UP:-stopped}  procs=$PROC"
  echo "log:"
  echo "$TAIL"
  if ! ps aux | grep -v grep | grep -q run-micro-live-v2; then
    if ! ps aux | grep -v grep | grep -q 'micro-live.js --live'; then
      echo "=== MICRO LIVE V2 FINISHED ==="
      tail -50 "$LOG" || true
      exit 0
    fi
  fi
  sleep 30
done
