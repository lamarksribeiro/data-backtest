#!/bin/bash
LOG=/tmp/pair-path-dry-cap2.log
while true; do
  TS=$(date -u +%H:%M:%SZ)
  UP=$(docker ps --format '{{.Status}}' --filter name=rx06uazamupj1w98pvl2b1d9 2>/dev/null | head -1 || true)
  PROC=$(ps aux | grep -E 'run-micro-dry-cap2|micro-live' | grep -v grep | wc -l)
  TAIL=$(tail -12 "$LOG" 2>/dev/null || true)
  echo "=== UPDATE $TS ==="
  echo "engine: ${UP:-stopped}  procs=$PROC"
  echo "log:"
  echo "$TAIL"
  if ! ps aux | grep -v grep | grep -q run-micro-dry-cap2; then
    if ! ps aux | grep -v grep | grep -q 'micro-live.js'; then
      echo "=== DRY CAP2 SCRIPT FINISHED ==="
      tail -40 "$LOG" || true
      exit 0
    fi
  fi
  if echo "$TAIL" | grep -q 'SUCCESS: open+hedge'; then
    echo "=== SUCCESS open+hedge ==="
    exit 0
  fi
  if echo "$TAIL" | grep -q 'DONE without full open+hedge'; then
    echo "=== DONE no full trade ==="
    exit 0
  fi
  sleep 30
done
