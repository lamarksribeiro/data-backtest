# Late Underdog Blast V1

Aposta no **azarão** quando detecta explosão de virada (mom spot→PTB + ask do favorito subindo + ask do azarão caindo + memória de dominância late). Hold settlement.

Fonte: `src/backtestStudio/gls/strategies/LateUnderdogBlastV1.gls`

## Resultado do lab: rejeitada

Train `2026-04-27` → `2026-05-31` (8 variantes):

| Rank | Variante | PnL | Entradas | WR | PF |
|---:|---|---:|---:|---:|---:|
| 1 | violent | +21.2 | **1** | 100% | — (ruído) |
| 2 | cheap-dog | −10.5 | 16 | 25% | 0.91 |
| 3 | ask55-early | −73.0 | 39 | 28% | 0.73 |
| 4 | base | −134.7 | 43 | 19% | 0.58 |
| 8 | july24-like | −661.1 | 141 | 16% | 0.36 |

Nenhuma variante com amostra útil passou PF ≥ 1.2. Smoke (3 dias) também 0% WR nas entradas.

## Por que falha (mesmo com filtro de explosão)

1. Quando o ask do azarão já caiu para ≤0.42, a maior parte dos “blasts” é **susto** que reverte — não virada completa.
2. As viradas reais do dia 24 (que mataram o mode3 favorito) tinham azarão ainda a **0.85–0.90** na entrada — ou seja, barato no azarão chega **tarde demais** ou no falso positivo.
3. Afrouxar `maxAsk` (july24-like @ 0.65) só aumenta a frequência de knife-catch (WR ~16%).

Conclusão: o edge de “pegar a virada barato no azarão” **não aparece** no harness BTC 5m com os sinais testados. O lado lucrativo continua sendo o favorito barato (Late Cheap Flip mode3 / SBRI).

## Sinais usados

- `underlyingAgo` — momentum e colapso de distância ao PTB
- `upAskAgo` / `downAskAgo` — explosão de odds (fav sobe, dog cai)
- Memória mid-late do ask mínimo do favorito (`minLateFavAsk`)
- Filtros de book (spread, odds sum), hold settlement

## Reproduzir

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/late-underdog-blast-v1/experiments/smoke.json --variant-workers 4
npm run lab:run -- --experiment labs/strategies/terminal/late-underdog-blast-v1/experiments/train.json --variant-workers 4
```

Relatório: `reports/labs/late-underdog-blast-v1/2026-07-26T18-32-25-721Z-late-underdog-blast-train/`

## Status

- **draft / rejeitada no lab** — `promotedToStudio: false`
- Não confundir com `late-cheap-flip-v1` mode3 (favorito barato), que é a campeã do harness de virada.
