#!/bin/bash
set -euo pipefail
DB=vgiav63o4y359d73hvzx3d1y
docker exec "$DB" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "\d ticks"' | head -80
echo "==== MARKETS ===="
docker exec "$DB" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "SELECT id, underlying, type, slug_pattern FROM markets WHERE underlying='\''BTC'\'' ORDER BY type;"'
echo "==== RECENT EVENTS ===="
docker exec "$DB" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "
SELECT e.event_start, e.condition_id, COUNT(t.id) AS ticks
FROM events e
JOIN markets m ON m.id=e.market_id
LEFT JOIN ticks t ON t.market_id=e.market_id AND t.event_start=e.event_start
WHERE m.underlying='\''BTC'\'' AND m.type='\''crypto-updown-5m'\''
  AND e.event_start >= '\''2026-08-02T14:20:00Z'\''
  AND e.event_start < '\''2026-08-02T15:00:00Z'\''
GROUP BY e.event_start, e.condition_id
ORDER BY e.event_start;
"'
