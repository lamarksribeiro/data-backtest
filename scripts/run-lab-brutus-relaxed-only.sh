#!/bin/sh
set -eu

CONTAINER="${LAB_CONTAINER:-le4sptof36h14ry6s5zet5v0-200808843339}"
VARIANT_WORKERS="${VARIANT_WORKERS:-32}"
SWEEP_MAX_VARIANTS="${SWEEP_MAX_VARIANTS:-2000}"
DUCKDB_THREADS="${DUCKDB_THREADS:-8}"
DUCKDB_MEMORY_LIMIT="${DUCKDB_MEMORY_LIMIT:-4GB}"
DATASET_CACHE_MAX_MB="${DATASET_CACHE_MAX_MB:-4096}"

experiment="labs/strategies/edge/edge-sniper-v2/experiments/2026-06-13-btc-5m-relaxed-entry-finder.json"

echo "========== START $experiment $(date -Iseconds) variantWorkers=$VARIANT_WORKERS single-pass =========="
docker exec \
  -e "SWEEP_MAX_VARIANTS=$SWEEP_MAX_VARIANTS" \
  -e "DUCKDB_THREADS=$DUCKDB_THREADS" \
  -e "DUCKDB_MEMORY_LIMIT=$DUCKDB_MEMORY_LIMIT" \
  -e "DATASET_CACHE_MAX_MB=$DATASET_CACHE_MAX_MB" \
  "$CONTAINER" \
  npm run lab:run -- --experiment "$experiment" --variant-workers "$VARIANT_WORKERS" --progress-every 50
echo "========== DONE $experiment $(date -Iseconds) =========="
