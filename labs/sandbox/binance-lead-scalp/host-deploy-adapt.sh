#!/bin/bash
set -euo pipefail
rm -rf /tmp/binance-lead-scalp-clean
mkdir -p /tmp/binance-lead-scalp-clean
if [ -f /tmp/binance-lead-scalp-new/scalp-dry.js ]; then
  cp -r /tmp/binance-lead-scalp-new/* /tmp/binance-lead-scalp-clean/
elif [ -f /tmp/binance-lead-scalp-new/binance-lead-scalp/scalp-dry.js ]; then
  cp -r /tmp/binance-lead-scalp-new/binance-lead-scalp/* /tmp/binance-lead-scalp-clean/
else
  echo "SCP layout unknown"; ls -la /tmp/binance-lead-scalp-new; exit 1
fi
ls /tmp/binance-lead-scalp-clean
grep -c VARIANT_E_ADAPT /tmp/binance-lead-scalp-clean/scalp-engine.js
grep -n "rescue: true" /tmp/binance-lead-scalp-clean/scalp-engine.js | head -3
bash /tmp/redeploy-e-adapt.sh
