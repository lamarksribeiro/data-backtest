#!/bin/bash
set -euo pipefail
C=pair-path-micro
pkill -f 'scripts/pair-path/micro-live.js' 2>/dev/null || true
sleep 1
echo "ARMED=$(docker exec "$C" printenv ENGINE_START_ARMED || true)"
truncate -s 0 /tmp/pair-path-dry-clip-deep3.log
nohup docker exec "$C" node scripts/pair-path/micro-live.js \
  --clip=deep3 \
  --max-events=8 \
  --open-shares=10 \
  --max-notional=16 \
  --open-cap-cents=3 \
  --order-type=GTC \
  --settle-ms=1500 \
  --poll-ms=50 \
  --max-book-age-ms=2500 \
  --min-tau-start=120 \
  --wait-timeout=1800 \
  --timeout=320 \
  --no-stop-on-residual \
  > /tmp/pair-path-dry-clip-deep3.log 2>&1 &
echo "BOOT_PID=$! (dry, no residual kill, 8 events)"
sleep 4
head -22 /tmp/pair-path-dry-clip-deep3.log
