#!/bin/bash
C=pair-path-micro
echo "=== PROC ==="
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
echo "=== COUNTS ==="
docker exec "$C" sh -c '
echo enters=$(grep -c "ENTER fill" /tmp/scalp-e-freq-dry.log 2>/dev/null || echo 0)
echo exits=$(grep -c "^EXIT " /tmp/scalp-e-freq-dry.log 2>/dev/null || echo 0)
echo results=$(grep -c "^result " /tmp/scalp-e-freq-dry.log 2>/dev/null || echo 0)
'
echo "=== RESULTS ==="
docker exec "$C" sh -c 'grep "^result " /tmp/scalp-e-freq-dry.log 2>/dev/null || true'
echo "=== ENTERS ==="
docker exec "$C" sh -c 'grep "ENTER fill" /tmp/scalp-e-freq-dry.log 2>/dev/null || true'
echo "=== HEAD ==="
docker exec "$C" head -n 12 /tmp/scalp-e-freq-dry.log
echo "=== TAIL ==="
docker exec "$C" tail -n 20 /tmp/scalp-e-freq-dry.log
