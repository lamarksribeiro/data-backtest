#!/bin/bash
set -euo pipefail
docker start pair-path-micro
sleep 2
docker exec pair-path-micro mkdir -p /usr/src/app/scripts
docker exec pair-path-micro rm -rf /usr/src/app/scripts/late-surprise
docker cp /tmp/late-surprise pair-path-micro:/usr/src/app/scripts/late-surprise
echo "=== files ==="
docker exec pair-path-micro ls -la /usr/src/app/scripts/late-surprise
echo "=== ARMED ==="
docker exec pair-path-micro printenv ENGINE_START_ARMED || true
echo "=== node ==="
docker exec pair-path-micro node -e 'console.log("node ok", process.version)'
# kill previous dry if any
docker exec pair-path-micro sh -c 'pkill -f late-surprise-dry.js || true' || true
sleep 1
docker exec -d pair-path-micro sh -c 'node scripts/late-surprise/late-surprise-dry.js --max-events=50 --min-tau-start=60 --poll-ms=50 --fill=honest --wait-timeout=900 > /tmp/late-surprise-dry.log 2>&1'
sleep 3
echo "=== log head ==="
docker exec pair-path-micro head -n 40 /tmp/late-surprise-dry.log || true
echo "=== ps ==="
docker exec pair-path-micro sh -c 'ps aux | grep late-surprise | grep -v grep' || true
