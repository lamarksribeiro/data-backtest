#!/bin/bash
C=pair-path-micro
echo "=== ALIVE ==="
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
echo "=== REPORTS ==="
docker exec "$C" sh -c 'ls -lt runs/binance-lead-scalp-dry 2>/dev/null | head -20 || echo NONE'
echo "=== SUMMARY_FILES ==="
docker exec "$C" sh -c 'ls -1t runs/binance-lead-scalp-dry/summary_*.json 2>/dev/null | head -3'
echo "=== EVENT_REPORTS ==="
docker exec "$C" sh -c 'ls -1t runs/binance-lead-scalp-dry/scE_*.json 2>/dev/null | head -15'
echo "=== LOG_GREP ==="
docker exec "$C" sh -c 'grep -E "^(---|event=|ENTER |EXIT |result |=== summary)" /tmp/scalp-e-dry.log | tail -n 120'
echo "=== HB_TAIL ==="
docker exec "$C" tail -n 25 /tmp/scalp-e-dry.log
