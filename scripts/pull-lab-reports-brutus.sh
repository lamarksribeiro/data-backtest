#!/bin/sh
set -eu

CONTAINER="${LAB_CONTAINER:-le4sptof36h14ry6s5zet5v0-200808843339}"
REMOTE_DIR="${LAB_REMOTE_REPORTS:-/app/reports/labs/edge-sniper-v2}"
LOCAL_DIR="${LAB_LOCAL_REPORTS:-./reports/labs/edge-sniper-v2-brutus}"

mkdir -p "$LOCAL_DIR"

echo "pulling lab reports from $CONTAINER:$REMOTE_DIR -> $LOCAL_DIR"
docker cp "$CONTAINER:$REMOTE_DIR/." "$LOCAL_DIR/"

count="$(find "$LOCAL_DIR" -name top-results.json 2>/dev/null | wc -l | tr -d ' ')"
echo "done: $count report(s) with top-results.json in $LOCAL_DIR"
