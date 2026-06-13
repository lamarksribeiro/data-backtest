#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck source=common.env.sh
. "$SCRIPT_DIR/common.env.sh"

REMOTE_DIR="${LAB_REMOTE_REPORTS:-/app/reports/labs/edge-sniper-v2}"
LOCAL_DIR="${LAB_LOCAL_REPORTS:-./reports/labs/edge-sniper-v2-brutus}"

mkdir -p "$LOCAL_DIR"

echo "pulling lab reports from $LAB_CONTAINER:$REMOTE_DIR -> $LOCAL_DIR"
docker cp "$LAB_CONTAINER:$REMOTE_DIR/." "$LOCAL_DIR/"

count="$(find "$LOCAL_DIR" -name top-results.json 2>/dev/null | wc -l | tr -d ' ')"
echo "done: $count report(s) with top-results.json in $LOCAL_DIR"
