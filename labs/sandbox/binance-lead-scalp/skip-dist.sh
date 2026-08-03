#!/bin/bash
C=pair-path-micro
echo "=== SKIP DIST (hb lines) ==="
docker exec "$C" sh -c "grep -o 'skip=[A-Z_]*' /tmp/scalp-e-freq-dry.log | sort | uniq -c | sort -rn"
echo "=== HB COUNT ==="
docker exec "$C" sh -c "grep -c 'hb tau' /tmp/scalp-e-freq-dry.log"
echo "=== EVENTS / ENTERS ==="
docker exec "$C" sh -c "grep -c '^--- event' /tmp/scalp-e-freq-dry.log; grep -c 'ENTER fill' /tmp/scalp-e-freq-dry.log"
echo "=== PROC ==="
docker exec "$C" sh -c "ps -eo pid,etime,args | grep '[n]ode scripts/binance-lead-scalp/scalp-dry' || echo NO_PROC"
