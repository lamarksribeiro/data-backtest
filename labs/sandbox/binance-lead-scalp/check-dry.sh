#!/bin/bash
docker exec pair-path-micro sh -c 'ps -eo pid,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
echo "---"
docker exec pair-path-micro tail -n 50 /tmp/scalp-e-dry.log
echo "---"
docker exec pair-path-micro sh -c 'ls -t runs/binance-lead-scalp-dry/*.json 2>/dev/null | head -5 || echo NO_REPORTS_YET'
