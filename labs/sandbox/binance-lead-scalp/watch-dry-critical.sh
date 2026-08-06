#!/bin/bash
docker exec pair-path-micro sh -c '
  echo "=== critical lines ==="
  grep -E "ENTER|EXIT|RESCUE|rescue_stop|ladder_full|DUMP|--- event|SUMMARY|DONE|session" /tmp/scalp-e-golden-v2-dry.log 2>/dev/null | tail -n 50
  echo "=== process ==="
  ps -eo pid,etime,args | grep "[n]ode scripts/binance-lead-scalp/scalp-dry" || echo NO_DRY
  echo "=== last hb ==="
  grep "hb tau" /tmp/scalp-e-golden-v2-dry.log 2>/dev/null | tail -n 3
'
