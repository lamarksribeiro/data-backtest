#!/bin/bash
C=pair-path-micro
echo "=== /tmp layout ==="
ls -la /tmp/binance-lead-scalp | head -20
echo "=== container layout ==="
docker exec "$C" sh -c 'ls -la /usr/src/app/scripts/binance-lead-scalp; echo ---; head -n 5 /usr/src/app/scripts/binance-lead-scalp/scalp-dry.js; echo ---; grep -n "VARIANT_E_FREQ\|e-freq\|impulseUsd: 8" /usr/src/app/scripts/binance-lead-scalp/scalp-engine.js /usr/src/app/scripts/binance-lead-scalp/scalp-dry.js | head -20'
