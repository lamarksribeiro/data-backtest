# MIDAS Probe V1 — Validação (smoke + junho stress + holdout julho)

**Data:** 2026-07-26 · Budget lab US$ 5 (probe US$ 1,5) · settle 0.995 · BTC 5m depth 25

| Experimento | Path |
|---|---|
| Smoke 20–22/07 | `reports/labs/midas-probe-v1/2026-07-26T17-36-54-720Z-smoke-probe-july20-22` |
| Stress 01–08/06 | `reports/labs/midas-probe-v1/2026-07-26T17-39-40-436Z-stress-probe-june` |
| Holdout 01–25/07 | `reports/labs/midas-probe-v1/2026-07-26T17-42-46-072Z-holdout-probe-july` |

## Tabela consolidada

| Janela | Variante | PnL | WR | PF | DD | Pior dia |
|---|---|---:|---:|---:|---:|---:|
| Smoke 3d | baseline-full | **+91** | **79%** | 1,41 | 26,5 | +25,6 |
| Smoke 3d | probe-confirm | +40 | 66% | 1,32 | **17,7** | +9,1 |
| Smoke 3d | probe-dist-kill | +45 | 73% | 1,31 | 25,0 | +7,0 |
| **Jun stress 8d** | baseline-full | **+294** | **80%** | **1,52** | 43,9 | **−32,3** |
| Jun stress 8d | probe-confirm | +108 | 68% | 1,35 | **27,1** | **−13,8** |
| Jun stress 8d | probe-dist-kill | +129 | 74% | 1,35 | **26,6** | **−12,4** |
| Jun stress 8d | probe-strict | +48 | 64% | 1,23 | 30,4 | −23,0 |
| **Jul 25d** | baseline-full | **+1147** | **82%** | **1,59** | 36,9 | −13,8 |
| Jul 25d | probe-confirm | +555 | 72% | 1,51 | **24,9** | **−6,9** |
| Jul 25d | probe-dist-kill | +627 | 78% | 1,51 | 26,5 | −11,4 |
| Jul 25d | probe-strict | +301 | 70% | 1,45 | **21,0** | **−5,3** |

## O que os testes mostram

1. **Probe entrega o que prometeu nas bruscas.** No junho stress, pior dia −32 → **−14** (confirm) / **−12** (dist-kill); DD 44 → **27**. No holdout julho, pior dia −14 → **−7** (confirm).
2. **Custo de PnL ~50%** vs baseline em todas as janelas (confirm). Dist-kill recupera um pouco mais de PnL com proteção um pouco menor que confirm no smoke, similar no junho.
3. **PF se mantém saudável** (1,35–1,51) — não é o colapso das zonas (PF ~0,45).
4. **probe-strict** (sem entrada direta) é o mais defensivo no holdout (DD 21, pior dia −5) mas deixa ~half das entradas no caminho e corta demais o PnL.
5. Baseline continua o rei de expectativa; probe é **seguro de cauda**, não maximizador.

## Veredito lab

| Objetivo | Vencedor |
|---|---|
| Max PnL / WR | `baseline-full` |
| Anti-wipeout (pior dia + DD) | **`probe-confirm`** (jul) · empate próximo com dist-kill (jun) |
| Meio-termo | `probe-dist-kill` |

**Candidata para calibrar:** `probe-confirm` com `probeKillOppAsk` 0,50–0,55 (hoje 0,45 pode estar matando cedo demais) e micro budget alinhado ao robot ($2/$4).

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/midas-probe-v1/experiments/holdout-probe-july.json
npm run lab:run -- --experiment labs/strategies/terminal/midas-probe-v1/experiments/stress-probe-june.json
```
