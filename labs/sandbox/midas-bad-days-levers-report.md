# MIDAS — lab dias ruins (julho)

Gerado: 2026-07-25T20:25:02.041Z
Bad days (7): 2026-07-03, 2026-07-04, 2026-07-05, 2026-07-07, 2026-07-09, 2026-07-14, 2026-07-22
Baseline julho PnL: 2398.72 | stress: 186.71 | worst day: -18.56
Baseline treino PnL: 5465.63

## Critérios

1. Stress: PnL nos badDays ≥ baseline OU worstDay melhora ≥20%
2. Julho: ΔPnL ≥ −5% e PF não cai >0.05
3. Treino: ΔPnL ≥ −8%

## Resultados

| variant | pass | jul PnL | Δjul% | train PnL | Δtrain% | stress | Δstress | worst | stress✓ | jul✓ | train✓ |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| maxask-090 | **Y** | 2363.22 | -1.5% | 5264.75 | -3.7% | 205.5 | 18.78 | -26.11 | Y | Y | Y |
| minsec-09 | **Y** | 2389.79 | -0.4% | 5314.98 | -2.8% | 190.88 | 4.17 | -25.97 | Y | Y | Y |
| maxask-086 | N | 2243.41 | -6.5% | 4744.13 | -13.2% | 192.89 | 6.18 | -27.77 | Y | N | N |
| rev-half | N | 2246.57 | -6.3% | 5092.56 | -6.8% | 191.07 | 4.36 | -18.37 | Y | N | Y |
| minsec-10 | N | 2413.27 | 0.6% | 5223.67 | -4.4% | 184.18 | -2.53 | -25.97 | N | Y | Y |
| rev-ask-090 | N | 2377.84 | -0.9% | 5409.16 | -1% | 183.87 | -2.84 | -19.83 | N | Y | Y |
| rev-ask-085 | N | 2371.7 | -1.1% | 5359.71 | -1.9% | 174.48 | -12.23 | -19.83 | N | Y | Y |
| dist-30 | N | 2310.3 | -3.7% | 5307.26 | -2.9% | 163.79 | -22.92 | -20.54 | N | Y | Y |
| minsec10-dist30 | N | 2324.25 | -3.1% | 5061.3 | -7.4% | 160.14 | -26.57 | -29.07 | N | Y | Y |

## Vencedores (2)

- `maxask-090` — stress Δ18.78, jul -1.5%, train -3.7%
- `minsec-09` — stress Δ4.17, jul -0.4%, train -2.8%

## Relatórios

- Julho: `/app/reports/labs/midas-carry-v1/2026-07-25T20-05-53-782Z-bad-days-levers-july`
- Treino: `/app/reports/labs/midas-carry-v1/2026-07-25T20-24-42-724Z-bad-days-levers-train`
- Micro: `/app/reports/labs/midas-carry-v1/2026-07-25T20-28-26-295Z-bad-days-levers-micro`

## Revalidação micro ($2/$4)

| Variante | PnL | PF | Max DD | Entradas | Δ vs baseline |
|----------|----:|---:|-------:|---------:|----------------:|
| baseline-micro | 496,10 | 1,62 | 15,60 | 2368 | — |
| **minsec-09-micro** | **499,39** | **1,65** | 15,60 | 2309 | **+0,7%** |
| maxask-090-micro | 486,87 | 1,64 | 15,77 | 2183 | −1,9% |

`maxask-090` vence no stress set aggressive ($10/$30) mas **perde** no micro. `minsec-09` é o único candidato que melhora nos dois escalões.

## Recomendação operacional (canário)

1. **Próximo A/B no robot:** `minSecondsLeft: 5 → 9` no preset `btc-micro-aggressive-v1` — melhor tradeoff julho + treino + micro.
2. **Não promover** `maxAsk: 0.90` no canário micro (corta entradas sem ganho líquido em $2/$4).
3. **Não promover** `dist-30`, caps de reverse, nem combos — falham critério de stress ou treino.
4. Manter foco em **execução** (GTC exit já deployado) para losses `expiry_loss` com reverse — não é gate de entrada.

**Deploy:** não automático; patch sugerido em `data-robot/src/tfc/preset-midas.js` (`MIDAS_AGGRESSIVE_V1.minSecondsLeft` ou overlay do canário).

