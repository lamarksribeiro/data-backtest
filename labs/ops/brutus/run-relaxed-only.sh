#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck source=common.env.sh
. "$SCRIPT_DIR/common.env.sh"

experiment="labs/strategies/edge/edge-sniper-v2/experiments/2026-06-13-btc-5m-relaxed-entry-finder.json"

echo "========== START $experiment $(date -Iseconds) variantWorkers=$VARIANT_WORKERS single-pass =========="
docker exec \
  -e "SWEEP_MAX_VARIANTS=$SWEEP_MAX_VARIANTS" \
  -e "DUCKDB_THREADS=$DUCKDB_THREADS" \
  -e "DUCKDB_MEMORY_LIMIT=$DUCKDB_MEMORY_LIMIT" \
  -e "DATASET_CACHE_MAX_MB=$DATASET_CACHE_MAX_MB" \
  "$LAB_CONTAINER" \
  npm run lab:run -- --experiment "$experiment" --variant-workers "$VARIANT_WORKERS" --progress-every 50
echo "========== DONE $experiment $(date -Iseconds) =========="
