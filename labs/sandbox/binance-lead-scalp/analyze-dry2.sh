#!/bin/bash
C=pair-path-micro
docker exec "$C" cat runs/binance-lead-scalp-dry/scE_btc-updown-5m-1785681300_*.json 2>/dev/null | head -c 8000 || \
  docker exec "$C" sh -c 'ls -1t runs/binance-lead-scalp-dry/scE_*.json | head -1 | xargs cat'
echo
echo "=== COUNTS ==="
docker exec "$C" sh -c 'echo NO_IMPULSE=$(grep -c NO_IMPULSE /tmp/scalp-e-dry.log); echo ENTER_fill=$(grep -c "ENTER fill" /tmp/scalp-e-dry.log); echo EXIT=$(grep -c "^EXIT " /tmp/scalp-e-dry.log); echo results=$(grep -c "^result " /tmp/scalp-e-dry.log)'
