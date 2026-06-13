#!/bin/sh
# Atalho: fila quality + relaxed (retomada após sampled).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
export LAB_QUEUE="${LAB_QUEUE:-labs/strategies/edge/edge-sniper-v2/queues/brutus-remaining.txt}"
exec sh "$SCRIPT_DIR/run-queue.sh"
