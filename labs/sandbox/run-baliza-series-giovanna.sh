#!/usr/bin/env bash
# Run multi-event market baliza on Giovanna (read-only, no orders).
#
# On Giovanna host:
#   bash /tmp/poly-baliza/run-baliza-series-giovanna.sh 8 series-a
#
# Or from Windows:
#   ssh Giovanna "bash /tmp/poly-baliza/run-baliza-series-giovanna.sh 8 series-a"
set -euo pipefail

EVENTS="${1:-8}"
LABEL="${2:-series}"
POLL_MS="${POLL_MS:-250}"
MIN_TAU="${MIN_TAU:-40}"
ROOT="${ROOT:-/tmp/poly-baliza}"
OUT="${ROOT}/out"
SCRIPT="${ROOT}/poly-market-baliza-live.mjs"
NAME="poly-baliza-series"

mkdir -p "$OUT"
if [[ ! -f "$SCRIPT" ]]; then
  echo "missing $SCRIPT — copy poly-market-baliza-live.mjs first" >&2
  exit 1
fi

# stop previous series if still running
docker rm -f "$NAME" 2>/dev/null || true

echo "=== baliza series ==="
echo "events=$EVENTS label=$LABEL poll=${POLL_MS}ms minTau=$MIN_TAU out=$OUT"
echo "start=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

docker run --rm --name "$NAME" \
  -e BALIZA_OUT=/out \
  -e HOSTNAME=giovanna-baliza \
  -v "${ROOT}:/work" \
  -v "${OUT}:/out" \
  -w /work \
  node:20-alpine \
  node poly-market-baliza-live.mjs \
    --events "$EVENTS" \
    --full-event \
    --min-tau "$MIN_TAU" \
    --poll-ms "$POLL_MS" \
    --label "$LABEL"

echo "end=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "latest series dirs:"
ls -1dt "$OUT"/* 2>/dev/null | head -5
