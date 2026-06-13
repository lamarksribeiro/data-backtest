#!/bin/sh
# Executa experimentos de uma fila no container data-backtest do Brutus.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck source=common.env.sh
. "$SCRIPT_DIR/common.env.sh"

QUEUE="${LAB_QUEUE:-labs/strategies/edge/edge-sniper-v2/queues/brutus-full.txt}"
PROGRESS_EVERY="${LAB_PROGRESS_EVERY:-20}"

run_queue() {
  while IFS= read -r experiment || [ -n "$experiment" ]; do
    case "$experiment" in
      ''|'#'*) continue ;;
    esac
    echo "========== START $experiment $(date -Iseconds) variantWorkers=$VARIANT_WORKERS single-pass =========="
    docker exec \
      -e "SWEEP_MAX_VARIANTS=$SWEEP_MAX_VARIANTS" \
      -e "DUCKDB_THREADS=$DUCKDB_THREADS" \
      -e "DUCKDB_MEMORY_LIMIT=$DUCKDB_MEMORY_LIMIT" \
      -e "DATASET_CACHE_MAX_MB=$DATASET_CACHE_MAX_MB" \
      "$LAB_CONTAINER" \
      npm run lab:run -- --experiment "$experiment" --variant-workers "$VARIANT_WORKERS" --progress-every "$PROGRESS_EVERY"
    echo "========== DONE $experiment $(date -Iseconds) =========="
  done < "$QUEUE"
}

echo "queue: $QUEUE"
run_queue
echo "========== ALL DONE $(date -Iseconds) =========="
