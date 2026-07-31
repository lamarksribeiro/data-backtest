#!/bin/bash
set -euo pipefail
docker start pair-path-micro >/dev/null 2>&1 || true
docker exec pair-path-micro sh -c 'pkill -f late-surprise || true' || true
sleep 1
docker cp /tmp/late-surprise-sprint.js pair-path-micro:/usr/src/app/scripts/late-surprise/late-surprise-sprint.js
# nohup inside container so redirect works with detached exec
docker exec -d pair-path-micro sh -c 'cd /usr/src/app && nohup node scripts/late-surprise/late-surprise-sprint.js --probe --target=15 --target-windows=24 --timeout=7200 --assets=btc,eth,sol,xrp --poll-ms=50 --wake-tau=25 > /usr/src/app/runs/late-surprise-sprint.log 2>&1 < /dev/null'
sleep 6
docker exec pair-path-micro sh -c 'ps aux | grep late-surprise | grep -v grep; echo ---; head -n 20 /usr/src/app/runs/late-surprise-sprint.log'
