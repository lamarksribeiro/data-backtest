#!/bin/bash
C=pair-path-micro
echo "=== PROC ==="
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
echo "=== COUNTS ==="
docker exec "$C" sh -c '
L=/tmp/scalp-e-adapt-dry.log
echo enters=$(grep -c "ENTER fill" "$L" 2>/dev/null || echo 0)
echo intents=$(grep -c "ENTER intent" "$L" 2>/dev/null || echo 0)
echo rescues=$(grep -c "RESCUE enter" "$L" 2>/dev/null || echo 0)
echo exits=$(grep -c "^EXIT " "$L" 2>/dev/null || echo 0)
echo results=$(grep -c "^result " "$L" 2>/dev/null || echo 0)
echo events=$(grep -c "^--- event" "$L" 2>/dev/null || echo 0)
'
echo "=== ENTERS ==="
docker exec "$C" sh -c 'grep "ENTER fill\|ENTER intent\|RESCUE enter\|^EXIT " /tmp/scalp-e-adapt-dry.log 2>/dev/null || true'
echo "=== RESULTS ==="
docker exec "$C" sh -c 'grep "^result " /tmp/scalp-e-adapt-dry.log 2>/dev/null || true'
echo "=== HEAD ==="
docker exec "$C" head -n 15 /tmp/scalp-e-adapt-dry.log
echo "=== TAIL ==="
docker exec "$C" tail -n 25 /tmp/scalp-e-adapt-dry.log
