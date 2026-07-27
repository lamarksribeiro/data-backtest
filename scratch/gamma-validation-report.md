# BTC 5m — validação contra resultados resolvidos da Polymarket

Gerado: 2026-07-27T05:11:03.398Z
Eventos com label local: 23829; resultados canônicos encontrados: 26060.

## Concordância de vencedor

Divergências entre último spot local e resultado resolvido: **236/23829 (0.99%)**.

| antecedência | n | flip local | flip canônico | AUC canônico do preço |
|---:|---:|---:|---:|---:|
| 60s | 23827 | 15.59% | 15.78% | 0.846 |
| 30s | 23827 | 11.10% | 11.37% | 0.903 |
| 20s | 23828 | 9.11% | 9.40% | 0.923 |
| 10s | 23822 | 6.94% | 7.35% | 0.949 |

## Regra pré-entrada simples no holdout (30s)

`favMid <= 0.70 AND z <= 4`

Sinais: 890/6608 (13.47%); precisão 49.89%; recall 57.07%.

## Saída tick-a-tick com settlement canônico

| variante | saídas | PnL local | PnL canônico | maxDD canônico | canônico holdout |
|---|---:|---:|---:|---:|---:|
| hold | 0 (0.00%) | $1212.87 | $398.54 | $274.13 | $178.79 |
| lead | 1829 (22.16%) | $2426.01 | $1395.74 | $202.15 | $536.96 |
| lead_bid45 | 1607 (19.47%) | $2702.71 | $1417.08 | $213.14 | $563.12 |
| lead_bid40 | 1553 (18.82%) | $2727.82 | $1408.54 | $207.09 | $580.13 |
| bid45 | 2511 (30.43%) | $-342.84 | $-1216.36 | $2521.86 | $723.05 |
| shock | 3605 (43.69%) | $-1755.98 | $-2153.04 | $2551.13 | $332.00 |

Observação: quando uma variante saiu antes do fim, o PnL da saída independe do vencedor; o label canônico altera apenas os trades mantidos até o settlement.

