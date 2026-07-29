#!/bin/bash
# Wait for current size15 micro-live to finish, then boot size20.
set -euo pipefail

LOG15=/tmp/pair-path-micro-live-size15.log
echo "[wait] polling size15 until micro-live exits..."
while docker exec pair-path-micro sh -c "ps aux | grep -q '[s]cripts/pair-path/micro-live.js'" 2>/dev/null; do
  last=$(tail -3 "$LOG15" 2>/dev/null | tr '\n' ' ' | cut -c1-180)
  echo "[wait] $(date -u +%H:%M:%S) still running… $last"
  sleep 20
done

echo "[wait] size15 process gone at $(date -u +%H:%M:%S)"
tail -30 "$LOG15" || true
echo ""
echo "[boot] starting size20..."
bash /tmp/boot-micro-live-size20.sh
echo "[done] size20 launched"
