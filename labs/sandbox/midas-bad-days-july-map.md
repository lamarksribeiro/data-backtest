# MIDAS — mapa de dias ruins (julho 2026)

**Gerado:** 2026-07-25  
**Relatório baseline:** `reports/labs/midas-carry-v1/2026-07-25T19-56-40-438Z-bad-days-baseline-july`  
**Janela:** 2026-07-01 → 2026-07-25 (incl. hoje) · envelope aggressive $10/$30

## Agregado

| Métrica | Valor |
|--------|------:|
| PnL total | **+2398,72** |
| PnL stress (bad days) | **+186,71** |
| Dias negativos | **2** (03/07, 09/07) |
| Stress set (7 dias) | ver abaixo |

## Stress set (`badDays`)

Critério: dias com PnL < 0 **ou** bottom quartil do mês.

| Data | PnL | Entradas | W/L | DD |
|------|----:|---------:|----:|---:|
| 2026-07-03 | **−18,56** | 114 | 89/25 | 95,6 |
| 2026-07-09 | **−17,07** | 91 | 69/22 | 67,5 |
| 2026-07-04 | +16,51 | 104 | 80/24 | 56,5 |
| 2026-07-05 | +62,46 | 119 | 91/28 | 42,3 |
| 2026-07-07 | +31,56 | 62 | 48/14 | 51,3 |
| 2026-07-14 | +62,19 | 98 | 81/17 | 54,9 |
| 2026-07-22 | +49,62 | 93 | 71/22 | 64,7 |

> Os únicos dias **vermelhos** no mês foram **03/07** e **09/07**. O stress set inclui também dias de PnL positivo mas baixo (quartil inferior).

## Melhores dias

| Data | PnL |
|------|----:|
| 2026-07-25 | +72,16 |
| 2026-07-23 | +71,23 |
| 2026-07-24 | +70,89 |

## Leitura rápida

- O mês é **fortemente positivo** no lab (+$2399); os “dias ruins” são poucos e concentrados em whipsaw (03 e 09).
- Taxonomia de perdas: ask alto (0,90–0,95) e dist 30–40 têm pior avg loss; top losses são `expiry_loss` com reverse ativo.
- Ver `midas-bad-days-taxonomy.md` e `midas-bad-days-levers-report.md`.
