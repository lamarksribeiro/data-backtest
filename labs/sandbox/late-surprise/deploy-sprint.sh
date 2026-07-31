#!/bin/bash
# Kill dry lento e sobe sprint acelerado (probe multi-asset).
set -euo pipefail
docker start pair-path-micro >/dev/null 2>&1 || true
sleep 1
docker exec pair-path-micro mkdir -p /usr/src/app/scripts
docker exec pair-path-micro rm -rf /usr/src/app/scripts/late-surprise
# scp -r pode aninhar /tmp/late-surprise/late-surprise/
SRC=/tmp/late-surprise
if [ -f /tmp/late-surprise/late-surprise/late-surprise-sprint.js ]; then
  SRC=/tmp/late-surprise/late-surprise
elif [ -f /tmp/late-surprise/late-surprise-sprint.js ]; then
  SRC=/tmp/late-surprise
fi
docker cp "$SRC" pair-path-micro:/usr/src/app/scripts/late-surprise
docker exec pair-path-micro sh -c 'pkill -f late-surprise || true' || true
sleep 1
docker exec -d pair-path-micro sh -c 'node scripts/late-surprise/late-surprise-sprint.js --probe --target=15 --timeout=7200 --assets=btc,eth,sol,xrp --poll-ms=50 --wake-tau=22 > /tmp/late-surprise-sprint.log 2>&1'
sleep 4
echo "=== log ==="
docker exec pair-path-micro head -n 50 /tmp/late-surprise-sprint.log || true
echo "=== ps ==="
docker exec pair-path-micro sh -c 'ps aux | grep late-surprise | grep -v grep' || true
