#!/bin/bash
# Dump last pair-path reports + recent CLOB trades/orders for analysis.
set -euo pipefail
C=pair-path-micro
docker exec "$C" sh -c 'ls -lt runs/pair-path-micro | head -20'
echo '==== LAST DONE REPORTS ===='
docker exec "$C" sh -c 'for f in runs/pair-path-micro/btc-updown-5m-1785255900.json runs/pair-path-micro/btc-updown-5m-1785255000.json; do echo --- $f ---; cat "$f" 2>/dev/null | head -c 8000; echo; done'
echo '==== NODE DUMP TRADES ===='
docker cp /tmp/dump-pair-path-trades.js "$C:/tmp/dump-pair-path-trades.js"
docker exec -w /usr/src/app "$C" node /tmp/dump-pair-path-trades.js
