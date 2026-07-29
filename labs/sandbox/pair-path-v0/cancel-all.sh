#!/bin/bash
pkill -f 'micro-live.js' 2>/dev/null || true
pkill -f 'run-micro-live' 2>/dev/null || true
pkill -f 'boot-micro-live' 2>/dev/null || true
docker rm -f pair-path-micro 2>/dev/null || true
docker ps -aq --filter name=rx06uazamupj1w98pvl2b1d9 | xargs -r docker rm -f
sleep 1
echo "=== leftover ==="
ps aux | grep -E 'micro-live|pair-path-micro' | grep -v grep || echo NO_LIVE
docker ps | grep -E 'pair-path|rx06' || echo NO_CONTAINERS
date -u +%H:%M:%SZ
echo DONE
