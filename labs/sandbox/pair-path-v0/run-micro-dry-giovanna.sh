#!/bin/bash
set -euo pipefail
for i in $(seq 1 24); do
  C=$(docker ps --format '{{.Names}}' | grep rx06uazamupj1w98pvl2b1d9 | head -1 || true)
  if [ -n "$C" ]; then
    echo "CID=$C"
    docker exec "$C" mkdir -p /usr/src/app/scripts/pair-path
    docker cp /tmp/pair-path-micro-live.js "$C:/usr/src/app/scripts/pair-path/micro-live.js"
    echo "ARMED=$(docker exec "$C" printenv ENGINE_START_ARMED || true)"
    docker exec "$C" node scripts/pair-path/micro-live.js \
      --max-events=1 \
      --open-shares=5 \
      --max-notional=8 \
      --min-tau-start=200 \
      --wait-timeout=400
    exit $?
  fi
  echo "wait_$i"
  sleep 5
done
echo "NO_CONTAINER"
exit 1
