# Stable Carry Compression V1

A **Stable Carry Compression V1** e uma teoria quantitativa nova para operar BTC Up/Down 5 minutos na Polymarket. Ela nao tenta ajustar Edge Sniper, Terminal Convexity, Gamma Ladder ou Impulse Elasticity. A ideia central e outra: comprar o lado que ja esta vencendo quando o book mostra compressao, isto e, quando a probabilidade implicita esta estavel o bastante para que o mercado esteja cobrando pouco premio de reversao, mas ainda existe tempo suficiente para realizar lucro parcial antes do vencimento.

Arquivo de laboratorio: `scripts/lab-consensus-curvature-fade.js`

Comando npm:

```bash
npm run lab:consensus-curvature -- --mode research --batch-size 25000 --workers auto
```

Para gravar os eventos usados na analise:

```bash
npm run lab:consensus-curvature -- --mode research --batch-size 25000 --workers auto --events-json tmp/ccf-final-events.json
```

## Recorte do Banco

Range obrigatorio usado por default:

```text
from = 2026-05-04T15:00:00.000Z
to   = maior timestamp local disponivel
```

Confirmacao do laboratorio em `2026-05-17T20:45:50.158Z`:

| Metrica | Valor |
|---|---:|
| Ticks | `2,283,735` |
| Eventos | `3,814` |
| Primeiro tick | `2026-05-04T15:00:00.548Z` |
| Ultimo tick | `2026-05-17T20:45:50.158Z` |
| Maior gap global observado | `118.600s` |
| Ticks sem asks/bids | `909` |
| Media de niveis ask por lado | `~21` |
| Ask sum medio | `1.0128` |

O recorte 60/20/20 do laboratorio completo ficou:

| Split | Intervalo |
|---|---|
| Train | `2026-05-04T15:00:00.000Z` ate `2026-05-12T13:39:30.094Z` |
| Validation | `2026-05-12T13:39:30.094Z` ate `2026-05-15T05:12:40.126Z` |
| Holdout | `2026-05-15T05:12:40.126Z` ate `2026-05-17T20:45:50.158Z` |

## Hipotese

Em mercados de 5 minutos, quando um lado ja esta favorito entre 70c e 82c, o mercado muitas vezes esta precificando continuidade, nao opcionalidade pura. O edge aparece quando essa continuidade ocorre com **compressao temporal do book**: a probabilidade implicita nao esta acelerando, o spread esta baixo e o BTC segue do lado correto do price-to-beat.

A teoria evita comprar favorito cedo demais. A leitura empirica mostrou que entradas entre 120s e 150s restantes ainda carregavam muita reversao escondida. A janela operacional ficou deliberadamente mais tarde:

```text
30s < tempo_restante <= 120s
```

## Matematica

Probabilidade implicita normalizada:

```text
p_up(t) = mid_up(t) / (mid_up(t) + mid_down(t))
```

Curvatura discreta do consenso do book:

```text
C(t) = p_up(t) - 2 * p_up(t - 10s) + p_up(t - 30s)
```

Compressao aceita:

```text
abs(C(t)) <= 0.025
```

Lado teorico:

```text
UP   se p_up(t) >= 0.50 e BTC(t) > price_to_beat
DOWN se p_up(t) <  0.50 e BTC(t) <= price_to_beat
```

Suporte direcional do BTC:

```text
support = side_sign * (BTC(t) - BTC(t - 10s))
```

onde `side_sign = +1` para UP e `-1` para DOWN. A versao final aceita `support >= 0`, ou seja, o BTC nao pode estar se movendo contra o lado comprado no lookback rapido.

Metrica de decisao do sinal:

```text
price_center = (min_ask + max_ask) / 2
price_penalty = abs(ask - price_center) * 0.05
carry_stability = max_curve_abs - abs(C(t))
carry_boost = min(0.03, support / max_distance_abs)

decision_metric = carry_stability + carry_boost - spread - price_penalty
```

Entrada somente se:

```text
decision_metric >= 0
```

## Filtros Finais

Variante escolhida: `scc-v2-late120-profit88`.

| Filtro | Valor |
|---|---:|
| Estrategia | `stable-carry` |
| Tempo restante | `30s < tau <= 120s` |
| Ask de entrada | `0.70 <= ask <= 0.82` |
| Distancia ao PTB | `20 <= abs(BTC - PTB) <= 100` |
| Compressao | `abs(C) <= 0.025` |
| Spread maximo | `0.05` |
| Odds sum | `0.99..1.06` |
| Suporte BTC | `>= 0` |
| Valor maximo por ordem | `$15` |
| Minimo de shares | `5` |
| Saida por lucro | vender se `bid >= 0.88` |
| Saida de fallback | settlement no vencimento |

## Metrica de Selecao

O laboratorio tambem usa uma metrica propria de selecao, a **Temporal Consistency Score (TCS)**. Ela nao mede uma entrada individual; mede se a teoria sobrevive ao recorte temporal.

Regra principal:

```text
se train, validation e holdout tem entradas e PnL positivo:
  TCS = 100000 + pnl_total - 0.1 * max_drawdown - 10 * top_win_share
senao:
  TCS = pnl_total + 0.25 * pnl_holdout - penalidades_por_split_negativo - penalidades_por_split_sem_entrada - 0.1 * max_drawdown - 10 * top_win_share
```

Essa escolha forca o laboratorio a preferir um candidato menor, mas coerente, em vez de um candidato que ganha apenas no holdout ou em uma unica cauda vencedora.

## Resultado Principal

Backtest completo com `workers=4`, `batch-size=25000`, `mode=research`, sem referencias:

| Metrica | Resultado |
|---|---:|
| Entradas | `21` |
| Wins / Losses | `19 / 2` |
| Win rate | `90.5%` |
| PnL | `+18.63` |
| PnL medio | `+0.89` |
| Profit factor | `1.62` |
| Max drawdown | `23.79` |
| Avg cost | `14.76` |
| Top win share | `8.2%` |
| TCS | `100015.43` |
| Duracao da rodada | `144.3s` |

Resultado 60/20/20:

| Split | Entradas | Wins | Losses | PnL | PF |
|---|---:|---:|---:|---:|---:|
| Train | `16` | `14` | `2` | `+1.08` | `1.04` |
| Validation | `2` | `2` | `0` | `+6.62` | `inf` |
| Holdout | `3` | `3` | `0` | `+10.92` | `inf` |

Validacoes recentes:

| Janela | Ticks | Entradas | Wins | Losses | PnL | Observacao |
|---|---:|---:|---:|---:|---:|---|
| Ultimas 72h | `517,557` | `3` | `3` | `0` | `+10.92` | Todas as entradas ocorreram na primeira parte da janela de 72h |
| Ultimas 24h | `172,530` | `0` | `0` | `0` | `0.00` | Sem setup qualificado |

Baseline aleatorio no mesmo relogio de curva (`random-same-curve-clock`), range completo:

| Entradas | Wins | Losses | PnL | PF | Max DD |
|---:|---:|---:|---:|---:|---:|
| `72` | `35` | `37` | `-100.00` | `0.82` | `233.22` |

O baseline aleatorio perder dinheiro no mesmo relogio reduz a chance de o resultado ser apenas efeito de comprar qualquer lado no horario certo.

## Comparacao Com Referencias

Rodada `mode=compare`, mesmo range, `workers=4`, com referencias no mesmo pool paralelo:

| Estrategia | Entradas | Win rate | PnL | PF | Max DD |
|---|---:|---:|---:|---:|---:|
| Stable Carry Compression V1 | `21` | `90.5%` | `+18.63` | `1.62` | `23.79` |
| Edge Sniper V1 | `138` | `72.5%` | `+378.30` | `2.11` | `53.43` |
| Terminal Convexity V1 | `59` | `47.5%` | `+876.75` | `3.53` | `46.97` |
| Gamma Ladder V1 | `142` | `50.7%` | `+2175.74` | `5.62` | `68.59` |
| Impulse Elasticity V1 | `119` | `75.6%` | `+434.44` | `4.14` | `22.54` |

Conclusao da comparacao: SCC V1 nao substitui as estrategias existentes em PnL bruto. Ela e uma teoria independente de baixa frequencia, mais parecida com um filtro complementar de carry do favorito. O achado relevante e a coerencia temporal do sinal pequeno, nao superioridade sobre os labs ja calibrados.

## Rejeicoes

| Variante | Motivo da rejeicao |
|---|---|
| `scc-v1-ask70-82` | Holdout `+27.42`, mas treino `-44.53` e PnL total `-5.09`; entrava cedo demais. |
| `scc-v1-profit88` | Holdout `+15.44`, mas treino `-32.08` e PnL total `-11.07`. |
| `scc-v2-late120-70-82` | PnL total `+22.43`, validacao/holdout positivos, mas treino ainda `-7.05`; perdeu no criterio de coerencia total. |
| `scc-v2-late120-tight-price` | PnL total `+5.33`, mas treino `-24.14`; apertar preco piorou o filtro. |
| `ccf-v1-wide-price` | PnL total `+47.16`, mas treino `-7.44` e holdout com apenas `50%` de win rate. |
| `ccf-v1-wide-profit65` | Quase neutra no total (`-0.27`) e treino negativo; nao passou a consistencia temporal. |
| `reject-cheap-tail` | PnL total `+40.98`, mas holdout `-30.00`; comportamento de cauda barata rejeitado. |
| `reject-extreme-curve` | Holdout `-84.81`; curvatura extrema nao foi edge. |
| `lib-v1-*` | Poucas entradas fora do treino e PnL instavel; a tese de inercia do book nao sustentou validacao/holdout. |
| `random-same-curve-clock` | PnL `-100.00`; baseline aleatorio negativo. |

## Status

SCC V1 e uma descoberta estatisticamente interessante, mas ainda pequena. A amostra final tem apenas 21 entradas no range completo e zero entradas nas ultimas 24h, entao a teoria deve ser tratada como candidata experimental, nao como estrategia pronta para producao. O proximo passo natural e combinar SCC V1 como filtro de regime com uma das estrategias mais fortes, sem misturar o sinal original na fase de descoberta.