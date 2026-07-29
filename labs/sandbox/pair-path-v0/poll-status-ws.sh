#!/bin/bash
# Poll sizefee-ws shadow every 30s until done. Run on Giovanna host.
LOG=/tmp/pair-path-v0/sizefee-ws.log
while true; do
  TS=$(date -u +%H:%M:%SZ)
  UP=$(docker ps --filter name=pair-path-shadow-ws --format '{{.Status}}' 2>/dev/null || true)
  STATUS=$(cat /tmp/pair-path-v0/out/*-sizefee-ws/STATUS.json 2>/dev/null || echo '{}')
  TAIL=$(tail -8 "$LOG" 2>/dev/null || true)
  echo "=== UPDATE $TS ==="
  echo "container: ${UP:-stopped}"
  echo "status: $STATUS"
  echo "log:"
  echo "$TAIL"
  if echo "$STATUS" | grep -q '"running": false'; then
    echo "=== SERIES COMPLETE ==="
    cat /tmp/pair-path-v0/out/*-sizefee-ws/report.json 2>/dev/null || true
    exit 0
  fi
  if [ -z "$UP" ]; then
    sleep 2
    STATUS2=$(cat /tmp/pair-path-v0/out/*-sizefee-ws/STATUS.json 2>/dev/null || echo '{}')
    if echo "$STATUS2" | grep -q '"running": false'; then
      echo "=== SERIES COMPLETE ==="
      cat /tmp/pair-path-v0/out/*-sizefee-ws/report.json 2>/dev/null || true
      exit 0
    fi
  fi
  sleep 30
done
