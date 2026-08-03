#!/bin/bash
# Export BTC 5m ticks for dry-overlap window from data-colector PG.
set -euo pipefail
DB=vgiav63o4y359d73hvzx3d1y
OUT=/tmp/scalp-e-live-window-ticks.csv
docker exec "$DB" sh -lc "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -P pager=off -c \"
COPY (
  SELECT
    t.condition_id,
    to_char(t.event_start AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS event_start,
    (EXTRACT(EPOCH FROM t.ts) * 1000)::bigint AS ts_ms,
    (EXTRACT(EPOCH FROM t.event_start) * 1000 + 300000)::bigint AS event_end_ms,
    t.up_best_ask,
    t.up_best_bid,
    t.down_best_ask,
    t.down_best_bid,
    COALESCE((t.up_book_asks->0->>'size')::float8, NULL) AS up_ask_sz_1,
    COALESCE((t.down_book_asks->0->>'size')::float8, NULL) AS down_ask_sz_1
  FROM ticks t
  WHERE t.market_id = '9586e5b0-d92a-40f4-8ca3-d2329a4d92e1'
    AND t.event_start >= '2026-08-02 14:25:00+00'
    AND t.event_start <  '2026-08-02 14:50:00+00'
    AND t.ts >= '2026-08-02 14:25:00+00'
    AND t.ts <  '2026-08-02 14:50:00+00'
  ORDER BY t.condition_id, t.ts
) TO STDOUT WITH CSV HEADER
\"" > "$OUT"
wc -l "$OUT"
head -n 3 "$OUT"
echo "wrote $OUT"
