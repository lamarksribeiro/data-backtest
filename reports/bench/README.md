# Benchmark Backtest

## F0 V4 — suíte comparativa (recomendado)

Compara `rows` vs `soa` (frio/quente), fast-run, paralelo e sweep:

```bash
npm run bench:v4 -- --window 1d --save
npm run bench:v4 -- --from 2026-05-29 --to 2026-05-30 --save
npm run bench:v4 -- --window 7d --sweep-variants 50 --save
```

Saída: tabela no stderr + JSON em `f0-v4-*.json` com `speedups` vs `rows-cold`.

## Bench simples (legado V2)

```bash
npm run bench:backtest -- --from 2026-05-01 --to 2026-05-08 --save
```

Requer partições `backtest_ticks` válidas no manifest. Janelas 7d/30d precisam de backfill no lake.
