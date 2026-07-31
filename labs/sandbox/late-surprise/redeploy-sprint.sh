#!/bin/bash
set -euo pipefail
SRC=/tmp/ls-fresh
if [ -f /tmp/ls-fresh/late-surprise-sprint.js ]; then
  SRC=/tmp/ls-fresh
elif [ -f /tmp/ls-fresh/late-surprise/late-surprise-sprint.js ]; then
  SRC=/tmp/ls-fresh/late-surprise
fi
echo "SRC=$SRC"
docker start pair-path-micro >/dev/null 2>&1 || true
sleep 1
docker exec pair-path-micro sh -c 'pkill -f late-surprise || true' || true
sleep 1
docker exec pair-path-micro rm -rf /usr/src/app/scripts/late-surprise
docker cp "$SRC" pair-path-micro:/usr/src/app/scripts/late-surprise
docker exec pair-path-micro ls -la /usr/src/app/scripts/late-surprise
docker exec -d pair-path-micro sh -c 'node scripts/late-surprise/late-surprise-sprint.js --probe --target=15 --timeout=7200 --assets=btc,eth,sol,xrp --poll-ms=50 --wake-tau=25 > /tmp/late-surprise-sprint.log 2>&1'
sleep 5
head_out=$(docker exec pair-path-micro head -n 30 /tmp/late-surprise-sprint.log 2>/dev/null || true)
echo "$head_out"
docker exec pair-path-micro sh -c 'ps aux | grep late-surprise | grep -v grep' || true
