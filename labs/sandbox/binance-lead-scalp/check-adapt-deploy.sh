#!/bin/bash
C=pair-path-micro
echo "=== PROC ==="
docker exec "$C" sh -c 'ps -eo pid,etime,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_PROC'
echo "=== VARIANT IN CONTAINER ==="
docker exec "$C" sh -c 'grep -n "VARIANT_E_ADAPT\|rescue: true\|impulseVolMult" /usr/src/app/scripts/binance-lead-scalp/scalp-engine.js 2>/dev/null | head -20 || echo NO_ENGINE'
docker exec "$C" sh -c 'grep -n "e-adapt\|VARIANT_E_ADAPT\|--variant" /usr/src/app/scripts/binance-lead-scalp/scalp-dry.js 2>/dev/null | head -15 || echo NO_DRY'
