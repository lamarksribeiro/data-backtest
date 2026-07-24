#!/bin/bash
set -euo pipefail
CID=le4sptof36h14ry6s5zet5v0-213817333649
docker exec "$CID" node labs/cli/run-preset.js \
  --preset btc-micro-aggressive-v1 \
  --strategy midas-carry-v1 \
  --strategy-family terminal \
  --from 2026-07-24 \
  --to 2026-07-24 \
  --daily-metrics
