#!/bin/bash
set -euo pipefail
C=pair-path-micro
SRC=/tmp/bls-v2
docker start "$C" >/dev/null 2>&1 || true
sleep 1
docker exec "$C" mkdir -p /usr/src/app/scripts /usr/src/app/src/feeds /usr/src/app/src/markets
docker exec "$C" rm -rf /usr/src/app/scripts/binance-lead-scalp
docker exec "$C" mkdir -p /usr/src/app/scripts/binance-lead-scalp
# copy file-by-file to avoid nested dir surprises
docker cp "$SRC/." "$C:/usr/src/app/scripts/binance-lead-scalp/"
docker cp /tmp/binanceSpotFeed.js "$C:/usr/src/app/src/feeds/binanceSpotFeed.js"
docker cp /tmp/marketState.js "$C:/usr/src/app/src/feeds/marketState.js"
docker cp /tmp/clobFeed.js "$C:/usr/src/app/src/feeds/clobFeed.js"
docker cp /tmp/btc5m.js "$C:/usr/src/app/src/markets/btc5m.js"
echo COPIED
docker exec -w /usr/src/app "$C" node --input-type=module -e 'import { VARIANT_E_GOLDEN } from "./scripts/binance-lead-scalp/scalp-engine.js"; console.log(JSON.stringify({impulseCap:VARIANT_E_GOLDEN.impulseCap,rescueStop:VARIANT_E_GOLDEN.rescueStop,sizingMode:VARIANT_E_GOLDEN.sizingMode,ladder:VARIANT_E_GOLDEN.ladderOffsets}));'
