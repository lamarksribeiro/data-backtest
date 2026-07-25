#!/usr/bin/env python3
import os
import subprocess

cid = "le4sptof36h14ry6s5zet5v0-065719856396"
live = "labs/strategies/terminal/midas-carry-v1/experiments/fak-exit-gtc-live-window.json"
hold = "labs/strategies/terminal/midas-carry-v1/experiments/fak-exit-gtc-holdout.json"

print("LIVE_WINDOW", flush=True)
subprocess.check_call(
    ["docker", "exec", cid, "node", "labs/cli/run.js", "--experiment", live, "--variant-workers", "4"]
)
print("HOLDOUT", flush=True)
subprocess.check_call(
    ["docker", "exec", cid, "node", "labs/cli/run.js", "--experiment", hold, "--variant-workers", "4"]
)
print("DONE", flush=True)
