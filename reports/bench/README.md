# Benchmark Backtest V2

Gerar baseline local (requer `backtest_ticks` válidos no manifest):

```bash
npm run bench:backtest -- --from 2026-05-01 --to 2026-05-08 --save
npm run bench:backtest -- --runs 10 --save
```

Arquivos JSON são gravados neste diretório com timestamp. Compare `timings.processMs` e `timings.duckdbReadMs` entre runs.
