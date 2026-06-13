# Shared Lab Infrastructure

Biblioteca comum dos laboratorios — sem entrypoints CLI nem scripts shell.

| Modulo | Funcao |
|---|---|
| `labRunner.js` | Executa experimentos config-driven |
| `labConsolidate.js` | Mescla rankings de relatorios |
| `paramGrid.js` | Expande search spaces |
| `reportWriter.js` | Grava resultados em `reports/labs/` |
| `parallelVariantSweep.js` | Sweep paralelo por variantes |
| `variantSweepWorker.js` | Worker thread do sweep |

Entrypoints npm: `labs/cli/`. Operacao remota: `labs/ops/`.

Evite colocar logica especifica de uma estrategia nesta pasta.
