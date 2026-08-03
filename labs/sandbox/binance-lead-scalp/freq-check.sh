#!/bin/bash
C=pair-path-micro
echo "=== ALIVE ==="
docker exec "$C" sh -c 'ps -eo etime,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
echo "=== COUNTS ==="
docker exec "$C" sh -c '
echo results=$(grep -c "^result " /tmp/scalp-e-dry.log)
echo enters=$(grep -c "ENTER fill" /tmp/scalp-e-dry.log)
echo exits=$(grep -c "^EXIT " /tmp/scalp-e-dry.log)
echo events=$(grep -c "--- event" /tmp/scalp-e-dry.log)
'
echo "=== RESULTS ==="
docker exec "$C" sh -c 'grep "^result " /tmp/scalp-e-dry.log'
echo "=== LAST HB ==="
docker exec "$C" tail -n 8 /tmp/scalp-e-dry.log
