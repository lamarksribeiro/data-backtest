#!/bin/bash
date -u +%H:%M:%SZ
tail -30 /tmp/pair-path-micro-live-v3.log 2>/dev/null || echo NO_LOG
echo '---'
ps aux | grep 'micro-live.js --live' | grep -v grep || echo NO_LIVE_PROCESS
docker ps | grep rx06 || echo NO_ENGINE
