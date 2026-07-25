#!/bin/bash
set -euo pipefail
CID=le4sptof36h14ry6s5zet5v0-065719856396
echo LIVE_WINDOW
docker exec "$CID" node labs/cli/run.js --experiment labs/strategies/terminal/midas-carry-v1/experiments/fak-exit-gtc-live-window.json --variant-workers 4
echo HOLDOUT
docker exec "$CID" node labs/cli/run.js --experiment labs/strategies/terminal/midas-carry-v1/experiments/fak-exit-gtc-holdout.json --variant-workers 4
