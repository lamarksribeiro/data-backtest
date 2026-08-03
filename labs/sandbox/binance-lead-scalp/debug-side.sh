#!/bin/bash
C=pair-path-micro
echo "=== ENTER/EXIT LINES ==="
docker exec "$C" sh -c 'grep -n -E "ENTER |EXIT |event=btc-updown-5m-1785681300" /tmp/scalp-e-dry.log'
echo "=== EVENT3 REPORT ==="
docker exec "$C" sh -c 'ls -1t runs/binance-lead-scalp-dry/scE_btc-updown-5m-1785681300*.json | head -1 | xargs cat'
