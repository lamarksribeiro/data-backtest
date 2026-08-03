#!/bin/bash
C=pair-path-micro
echo "=== UTC NOW ==="
date -u +%Y-%m-%dT%H:%M:%SZ
echo "=== DRY KEY LINES ==="
docker exec "$C" sh -c 'grep -E "event [0-9]+/24|ENTER fill|EXIT |^result |window ok" /tmp/scalp-e-dry.log'
echo "=== FIRST LAST ==="
docker exec "$C" sh -c 'head -n 8 /tmp/scalp-e-dry.log; echo ...; tail -n 15 /tmp/scalp-e-dry.log'
