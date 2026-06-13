#!/bin/sh
set -eu

LOG="${LAB_LOG:-/tmp/lab-edge-sniper-brutus.log}"
MARKER="${LAB_WAIT_MARKER:-DONE labs/strategies/edge/edge-sniper-v2/experiments/2026-06-13-btc-5m-depth25-midpoint-quality-sweep.json}"
NEXT_SCRIPT="${LAB_NEXT_SCRIPT:-/tmp/run-lab-brutus-relaxed-only.sh}"

echo "waiting for marker in $LOG:"
echo "  $MARKER"

while ! grep -q "$MARKER" "$LOG" 2>/dev/null; do
  sleep 20
done

echo "marker found — starting next script: $NEXT_SCRIPT"
exec sh "$NEXT_SCRIPT" >> "$LOG" 2>&1
