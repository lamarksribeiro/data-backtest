#!/bin/bash
C=pair-path-micro
LOG=/tmp/scalp-e-golden-v2-dry.log
echo "=== LOG EXISTS? ==="
docker exec "$C" sh -c "ls -la $LOG 2>/dev/null || echo MISSING"
echo "=== FINAL TAIL ==="
docker exec "$C" sh -c "tail -n 40 $LOG"
echo "=== EXIT REASONS COUNT ==="
docker exec "$C" sh -c "
  echo -n 'ladder_full: '; grep -c 'EXIT ladder_full' $LOG || true
  echo -n 'rescue_full: '; grep -c 'EXIT rescue_full' $LOG || true
  echo -n 'rescue_stop: '; grep -c 'EXIT rescue_stop' $LOG || true
  echo -n 'ENTER fill: '; grep -c 'ENTER fill' $LOG || true
"
echo "=== LATEST DRY SUMMARY ==="
docker exec "$C" sh -c 'ls -1t /usr/src/app/runs/binance-lead-scalp-dry/summary_*.json 2>/dev/null | head -3'
SUM=$(docker exec "$C" sh -c 'ls -1t /usr/src/app/runs/binance-lead-scalp-dry/summary_*.json 2>/dev/null | head -1')
if [ -n "$SUM" ]; then
  echo "file=$SUM"
  docker exec "$C" cat "$SUM" | head -c 2500
fi
echo ""
echo "=== PROCS ==="
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep scalp | grep -v grep || echo none'
