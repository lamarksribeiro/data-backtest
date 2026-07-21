
INSTALL parquet; LOAD parquet;
WITH ticks AS (
  SELECT
    CAST(ts AS TIMESTAMP) AS ts,
    event_start,
    underlying_price AS spot,
    price_to_beat AS ptb,
    ABS(underlying_price - price_to_beat) AS dist,
    up_ask, down_ask,
    CASE WHEN underlying_price >= price_to_beat THEN 'UP' ELSE 'DOWN' END AS fav
  FROM read_parquet('lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-*/**/*.parquet', hive_partitioning=true)
  WHERE dt BETWEEN '2026-06-01' AND '2026-06-06'
)
, per_event AS (
  SELECT
    CAST(event_start AS DATE) AS dt,
    event_start,
    MAX(spot) - MIN(spot) AS range_spot,
    STDDEV_SAMP(spot) AS sigma_spot,
    -- approximate flips: count fav changes via lag
    COUNT(*) AS n_ticks
  FROM ticks
  GROUP BY 1,2
)
SELECT dt,
       COUNT(*) AS events,
       ROUND(AVG(range_spot),2) AS avg_range,
       ROUND(AVG(sigma_spot),2) AS avg_sigma,
       ROUND(QUANTILE_CONT(range_spot, 0.9),2) AS p90_range
FROM per_event
GROUP BY dt
ORDER BY dt;
