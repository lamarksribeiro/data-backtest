#!/bin/sh
# Benchmark A/B ou capacidade máxima no Brutus.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck source=common.env.sh
. "$SCRIPT_DIR/common.env.sh"

EXPERIMENT="${LAB_EXPERIMENT:-labs/strategies/edge/edge-sniper-v3/experiments/2026-06-17-btc-treasure-phase1-obi-entry.json}"
HOST_CPUS="${HOST_CPUS:-$(nproc 2>/dev/null || echo 32)}"
RESERVE_CPUS="${RESERVE_CPUS:-4}"
MAX_MODE="${LAB_MAX_MODE:-0}"
LOG="${LAB_LOG:-/tmp/lab-benchmark-ab.log}"
PROGRESS_EVERY="${LAB_PROGRESS_EVERY:-25}"

LAB_CONTAINER="${LAB_CONTAINER:-$(docker ps | grep le4sptof36h14ry6s5zet5v0 | awk '{print $NF}' | head -1)}"
if [ -z "$LAB_CONTAINER" ]; then
  echo "data-backtest container not found" >&2
  exit 1
fi

if [ -z "${VARIANT_WORKERS:-}" ]; then
  if [ "$MAX_MODE" = "1" ]; then
    VARIANT_WORKERS=$((HOST_CPUS - RESERVE_CPUS))
  else
    VARIANT_WORKERS=8
  fi
fi
if [ "$VARIANT_WORKERS" -lt 1 ]; then VARIANT_WORKERS=1; fi

BACKTEST_WORKERS="${BACKTEST_WORKERS:-1}"
DUCKDB_THREADS="${DUCKDB_THREADS:-4}"

echo "benchmark container=$LAB_CONTAINER experiment=$EXPERIMENT maxMode=$MAX_MODE hostCpus=$HOST_CPUS reserveCpus=$RESERVE_CPUS variantWorkers=$VARIANT_WORKERS backtestWorkers=$BACKTEST_WORKERS duckdbThreads=$DUCKDB_THREADS" | tee "$LOG"
START=$(date +%s)
docker exec \
  -e "BACKTEST_WORKERS=$BACKTEST_WORKERS" \
  -e "SWEEP_MAX_VARIANTS=$SWEEP_MAX_VARIANTS" \
  -e "DUCKDB_THREADS=$DUCKDB_THREADS" \
  -e "DUCKDB_MEMORY_LIMIT=$DUCKDB_MEMORY_LIMIT" \
  -e "DATASET_CACHE_MAX_MB=$DATASET_CACHE_MAX_MB" \
  "$LAB_CONTAINER" \
  npm run lab:run -- --experiment "$EXPERIMENT" --variant-workers "$VARIANT_WORKERS" --progress-every "$PROGRESS_EVERY" 2>&1 | tee -a "$LOG"
END=$(date +%s)
echo "benchmark wallSec=$((END - START)) variantWorkers=$VARIANT_WORKERS" | tee -a "$LOG"
