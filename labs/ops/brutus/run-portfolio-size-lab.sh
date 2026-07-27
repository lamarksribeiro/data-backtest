#!/bin/sh
# Copia experiments portfolio-size e executa a fila no container data-backtest.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck source=common.env.sh
. "$SCRIPT_DIR/common.env.sh" 2>/dev/null || true

LAB_CONTAINER="${LAB_CONTAINER:-$(docker ps | grep le4sptof36h14ry6s5zet5v0 | awk '{print $NF}' | head -1)}"
if [ -z "$LAB_CONTAINER" ]; then
  echo "data-backtest container not found" >&2
  exit 1
fi

EXP_DIR=/app/labs/strategies/terminal/midas-carry-v1/experiments
QUEUE_DIR=/app/labs/strategies/terminal/midas-carry-v1/queues
HOST_EXP_DIR="${HOST_EXP_DIR:-/tmp}"

echo "container=$LAB_CONTAINER"
docker exec "$LAB_CONTAINER" mkdir -p "$EXP_DIR" "$QUEUE_DIR"
for f in "$HOST_EXP_DIR"/gold-portfolio-size-*-july.json; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  docker cp "$f" "$LAB_CONTAINER:$EXP_DIR/$base"
  echo "copied $base"
done

docker cp "$HOST_EXP_DIR/portfolio-size-july.txt" "$LAB_CONTAINER:$QUEUE_DIR/portfolio-size-july.txt"
docker exec "$LAB_CONTAINER" ls "$EXP_DIR"/gold-portfolio-size-*-july.json

export LAB_QUEUE="${LAB_QUEUE:-/tmp/portfolio-size-july.txt}"
export VARIANT_WORKERS="${VARIANT_WORKERS:-8}"
export BACKTEST_WORKERS="${BACKTEST_WORKERS:-1}"
export DUCKDB_THREADS="${DUCKDB_THREADS:-4}"
export LAB_PROGRESS_EVERY="${LAB_PROGRESS_EVERY:-25}"

LOG="${LAB_LOG:-/tmp/lab-portfolio-size.log}"
echo "starting queue LAB_QUEUE=$LAB_QUEUE VARIANT_WORKERS=$VARIANT_WORKERS log=$LOG"
nohup env \
  LAB_QUEUE="$LAB_QUEUE" \
  VARIANT_WORKERS="$VARIANT_WORKERS" \
  BACKTEST_WORKERS="$BACKTEST_WORKERS" \
  DUCKDB_THREADS="$DUCKDB_THREADS" \
  LAB_PROGRESS_EVERY="$LAB_PROGRESS_EVERY" \
  LAB_CONTAINER="$LAB_CONTAINER" \
  sh "$SCRIPT_DIR/run-queue.sh" > "$LOG" 2>&1 &
echo "pid=$! log=$LOG"
