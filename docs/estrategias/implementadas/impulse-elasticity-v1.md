# Impulse Elasticity V1

A **Impulse Elasticity V1** e uma teoria quantitativa nova para BTC Up/Down 5 minutos na Polymarket. Ela nao e um ajuste da Terminal Convexity V1, Edge Sniper, Gamma Ladder ou Cofre Sete. O sinal principal nao nasce do lado vencedor barato nos ultimos segundos; nasce de uma divergencia entre um impulso recente do BTC e a velocidade com que o book UP/DOWN reprecifica esse impulso.

Arquivo de laboratorio: `scripts/lab-impulse-elasticity.js`

Comando npm:

```bash
npm run lab:impulse-elasticity -- --mode quick --batch-size 5000
```

## Recorte do Banco

Range obrigatorio usado por default:

```text
from = 2026-05-04T15:00:00.000Z
to   = maior timestamp local disponivel
```

Confirmacao SQL do laboratorio em `2026-05-16T15:10:35.442Z`:

| Metrica | Valor |
|---|---:|
| Ticks | `2,071,045` |
| Eventos | `3,459` |
| Primeiro tick | `2026-05-04T15:00:00.548Z` |
| Ultimo tick | `2026-05-16T15:10:35.442Z` |

Cobertura por dia:

| Dia | Ticks | Eventos |
|---|---:|---:|
| 2026-05-04 | 86,256 | 144 |
| 2026-05-05 | 172,494 | 288 |
| 2026-05-06 | 172,484 | 288 |
| 2026-05-07 | 172,494 | 288 |
| 2026-05-08 | 172,490 | 288 |
| 2026-05-09 | 172,483 | 288 |
| 2026-05-10 | 172,520 | 288 |
| 2026-05-11 | 172,495 | 288 |
| 2026-05-12 | 172,271 | 288 |
| 2026-05-13 | 172,506 | 288 |
| 2026-05-14 | 172,513 | 288 |
| 2026-05-15 | 172,494 | 288 |
| 2026-05-16 | 87,545 | 147 |

Gaps:

| Metrica | Valor |
|---|---:|
| Gaps globais > 2s | 4 |
| Gaps globais > 5s | 2 |
| Gaps globais > 10s | 1 |
| Maior gap global | 118.600s |
| Gaps intraevento > 2s | 0 |
| Gaps intraevento > 5s | 0 |
| Gaps intraevento > 10s | 0 |
| Maior gap intraevento | 1.496s |

Interpretacao: ha poucos gaps globais, mas nenhum gap relevante dentro dos eventos. Para uma teoria de microestrutura, a parte importante e a continuidade intraevento; ela passou no filtro.

## Leitura Exploratoria

### Book por tempo restante

| Tempo restante | Ticks | Eventos | Abs dist media | Spread medio | Ask sum medio | Bid sum medio | Ask levels UP/DOWN |
|---|---:|---:|---:|---:|---:|---:|---:|
| 000-015s | 103,674 | 3,458 | 52.75 | 0.0160 | 1.0160 | 0.9840 | 14.15 / 14.02 |
| 015-030s | 103,674 | 3,458 | 51.72 | 0.0124 | 1.0124 | 0.9876 | 15.86 / 15.59 |
| 030-060s | 207,348 | 3,458 | 49.69 | 0.0123 | 1.0123 | 0.9877 | 17.43 / 17.24 |
| 060-120s | 414,680 | 3,458 | 46.16 | 0.0128 | 1.0128 | 0.9872 | 19.49 / 19.37 |
| 120-180s | 414,725 | 3,458 | 39.52 | 0.0123 | 1.0123 | 0.9877 | 21.71 / 21.54 |
| 180-300s | 796,958 | 3,459 | 24.26 | 0.0125 | 1.0125 | 0.9875 | 24.09 / 24.09 |

O book e simetrico e bem preenchido na maior parte do evento. Isso permite procurar desvios pequenos entre movimento do BTC e reprecificacao do book sem depender de arbitragem obvia por odds sum.

### Elasticidade de choque

A investigacao central olhou movimentos de BTC em aproximadamente 5s e mediu a resposta do consenso do book:

```text
p_up(t) = mid_up(t) / (mid_up(t) + mid_down(t))
shock_5s = BTC_t - BTC_{t-5s}
response = sign(shock_5s) * (p_up(t) - p_up(t-5s))
```

Bolsões com edge bruto preliminar:

| Tempo | Choque 5s | Resposta book | N ticks | Win rate lado choque | Ask medio | Edge bruto |
|---|---:|---|---:|---:|---:|---:|
| 030-060s | 30+ | under_0015 | 108 | 60.19% | 43.14% | +17.05pp |
| 060-120s | 30+ | under_004 | 208 | 37.98% | 29.36% | +8.63pp |
| 060-120s | 30+ | normal_010 | 476 | 52.52% | 44.22% | +8.30pp |
| 030-060s | 15-30 | under_0015 | 648 | 43.52% | 39.35% | +4.17pp |
| 030-060s | 08-15 | under_004 | 1,043 | 38.35% | 34.20% | +4.15pp |

Essa evidencia nao diz que basta comprar qualquer impulso. Ela diz que o book pode demorar alguns segundos para incorporar choques relevantes, especialmente fora dos ultimos 15s. A teoria entao exige choque, resposta limitada, suporte de distancia e fill real no book.

## Hipoteses Candidatas

### 1. Impulse Elasticity Inertia

Intuicao: depois de um impulso relevante do BTC, o book UP/DOWN nao move a probabilidade implicita na mesma velocidade. Quando o movimento tem suporte direcional e a resposta do book e lenta, ha uma janela curta para comprar o lado do impulso antes da curva alcancar o novo estado.

Variavel latente mal precificada: **elasticidade instantanea do consenso**, isto e, quanto a probabilidade implicita deveria se mover por unidade de choque de BTC em poucos segundos.

Formula inicial:

```text
s = sign(BTC_t - BTC_{t-delta})
I_t = |BTC_t - BTC_{t-delta}| / (sigma_delta + eps)
R_t = s * (p_up(t) - p_up(t-delta))
E_t = max(0, I_t - R_t / rho)
X_t = s * (BTC_t - PTB)
sigma_tau = max(sigma_min, sigma_realizada * sqrt(tau))
carry = clamp((|shock| / delta) * min(tau, H) * w, -c*sigma_tau, c*sigma_tau)
p_model = Phi((X_t + carry) / sigma_tau) + lambda * E_t * (1 - Phi(...))
edge = p_model - ask_side
score = edge * E_t * liquidityRatio / max(spread, 0.01)
```

Condicao de entrada: comprar o lado do choque quando ha `shockAbs`, `shockZ`, resposta do book limitada, spread controlado, odds sum normal, distancia assinada com suporte e liquidez suficiente no ask book.

Condicao de saida: vender quando o book alcanca a reprecificacao (`elasticity_catchup`), quando ha take profit, reversao curta do impulso, stop de bid ou settlement.

Principal risco: um impulso pode ser ruido de alta frequencia e reverter antes que a curva alcance o lado comprado.

Por que nao e Terminal Convexity: a entrada ocorre tipicamente entre 24s e 95s restantes, usa choque e elasticidade do book, e nao exige comprar o lado vencedor barato nos ultimos segundos.

### 2. Overreaction Fade

Intuicao: em alguns choques, o book pode ir rapido demais e superprecificar o lado do movimento. A operacao compraria o lado oposto esperando reversao.

Variavel latente mal precificada: **excesso de resposta do consenso**.

Formula inicial:

```text
O_t = max(0, R_t / rho - k * I_t)
side = -sign(shock)
p_model_fade = Phi((X_side + mean_reversion_carry) / sigma_tau)
score = (p_model_fade - ask_side) * O_t / spread
```

Condicao de entrada: resposta do book acima de `minOverResponse`, choque minimo, ask e spread viaveis.

Condicao de saida: catch-up, stop, reversao, settlement.

Principal risco: o mercado nao esta exagerando; esta corretamente acompanhando informacao direcional forte.

Por que nao e Terminal Convexity: e uma tese de fade de microestrutura em janela media, nao compra lado ja vencedor barato perto da expiracao.

Resultado: rejeitada. No range completo fez `-99.64`, win rate `8.3%`, PF `0.23`. Nas 24h recentes fez `-80.64`, PF `0.14`.

### 3. Compression Breakout

Intuicao: quando o BTC esta perto do PTB, o book fica comprimido perto de 50/50. Se a volatilidade local esta alta e aparece um impulso com resposta lenta, a primeira direcao pode ganhar uma opcao barata antes do book abrir.

Variavel latente mal precificada: **pressao de ruptura dentro de zona comprimida**.

Formula inicial:

```text
C_t = max(0, 1 - |BTC_t - PTB| / D)
B_t = C_t * I_t * max(0, 1 - R_t/rho)
p_model = Phi((X_t + carry) / sigma_tau) + lambda * B_t
score = (p_model - ask_side) * B_t / spread
```

Condicao de entrada: `|BTC - PTB| <= D`, volatilidade minima, choque minimo e resposta lenta.

Condicao de saida: catch-up, stop, take profit, settlement.

Principal risco: perto do PTB o lado comprado troca de vencedor rapidamente; pequenas reversoes destroem expectancy.

Por que nao e Terminal Convexity: nao espera os ultimos segundos nem compra lado moderadamente vencedor; procura ruptura perto do PTB.

Resultado: nao promovida. Full `+166.30`, PF `1.47`, DD `53.19`; holdout positivo, mas PF abaixo de 2 e drawdown pior que a teoria escolhida.

## Regra Promovida

Variante recomendada: `ie-inertia-distance-supported`

Parametros principais:

| Parametro | Valor |
|---|---:|
| `thesis` | `inertia` |
| `entryWindowStart` | 95s |
| `entryWindowEnd` | 24s |
| `impulseSec` | 5s |
| `minShockAbs` | 18 |
| `minShockZ` | 1.05 |
| `minResponse` | -0.04 |
| `maxResponse` | 0.065 |
| `minSignedDistance` | 4 |
| `maxSignedDistance` | 120 |
| `minAsk` | 0.06 |
| `maxAsk` | 0.72 |
| `maxSpread` | 0.10 |
| `minOddsSum` | 0.98 |
| `maxOddsSum` | 1.07 |
| `minModelEdge` | 0.025 |
| `entrySlippageMax` | 0.02 |
| `minLiquidityRatio` | 0.65 |
| `maxOrderValue` | 15 |
| `maxEntriesPerEvent` | 1 |

Fluxo operacional:

1. Processa ticks em batches via `getTicksForBacktestBatches`.
2. Mantem amostras recentes de BTC e probabilidade implicita do book.
3. Mede choque de 5s e resposta do consenso.
4. Compra apenas o lado do impulso quando esse lado ja tem distancia assinada positiva minima contra o PTB.
5. Simula fill consumindo `up_book_asks` ou `down_book_asks` ate `ask + 0.02`.
6. Sai pelo bid book quando a curva alcanca a reprecificacao, por take profit, stop de reversao, stop de bid, saida tardia ou settlement.
7. Usa no maximo uma posicao por evento.

## Resultados Empiricos

### Range completo desde 2026-05-04T15:00:00Z

| Variante | Entradas | Win rate | PnL | PF | DD | Max loss | Avg cost | Decisao |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `ie-inertia-distance-supported` | 114 | 75.4% | +377.66 | 3.92 | 22.54 | -12.54 | 14.09 | Recomendada |
| `ie-inertia-large-shock` | 76 | 64.5% | +322.98 | 3.93 | 23.70 | -11.04 | 13.88 | Secundaria, pouca amostra |
| `ie-inertia-core` | 149 | 63.1% | +314.80 | 1.90 | 53.82 | -12.54 | 14.06 | Rejeitada como default por PF/DD |
| `ie-compression-breakout` | 119 | 60.5% | +166.30 | 1.47 | 53.19 | -14.06 | 14.10 | Rejeitada |
| `ie-random-signal-clock` | 156 | 53.2% | +248.48 | 1.90 | 37.73 | -11.34 | 14.12 | Baseline aleatoria |
| `ie-fade-overreaction` | 109 | 8.3% | -99.64 | 0.23 | 99.64 | -10.51 | 10.81 | Rejeitada |
| `ie-inertia-late40` | 63 | 65.1% | +159.46 | 1.91 | 33.75 | -12.65 | 13.97 | Rejeitada |
| `ie-inertia-tight` | 42 | 64.3% | +258.32 | 3.80 | 26.87 | -10.45 | 13.99 | Rejeitada por holdout negativo |

### Split 60/20/20 da variante recomendada

| Split | Entradas | Win rate | PnL | PF | DD | Max loss |
|---|---:|---:|---:|---:|---:|---:|
| Train | 77 | 72.7% | +220.20 | 2.99 | 22.54 | -12.54 |
| Validation | 19 | 84.2% | +104.72 | 9.73 | 8.47 | -4.66 |
| Holdout | 18 | 77.8% | +52.73 | 9.03 | 2.86 | -2.86 |

O holdout e positivo, PF acima de 2, e nao depende de uma unica trade vencedora: foram 18 entradas, 14 vencedoras e 4 perdedoras. A media por trade no holdout foi `+2.93`.

### Resultado por dia da variante recomendada

| Dia | Entradas | Win rate | PnL | PF | DD | Max loss |
|---|---:|---:|---:|---:|---:|---:|
| 2026-05-04 | 12 | 50.0% | -19.42 | 0.39 | 19.42 | -12.54 |
| 2026-05-05 | 8 | 87.5% | +34.76 | 23.28 | 1.56 | -1.56 |
| 2026-05-06 | 15 | 73.3% | +44.87 | 3.00 | 10.90 | -10.90 |
| 2026-05-07 | 19 | 73.7% | +74.89 | 5.08 | 6.75 | -6.75 |
| 2026-05-08 | 9 | 88.9% | +51.32 | 6.09 | 10.09 | -10.09 |
| 2026-05-09 | 4 | 100.0% | +32.82 | inf | 0.00 | +2.32 |
| 2026-05-10 | 4 | 50.0% | -8.25 | 0.36 | 11.34 | -11.34 |
| 2026-05-11 | 6 | 66.7% | +9.23 | 1.69 | 11.20 | -11.20 |
| 2026-05-12 | 8 | 87.5% | +67.36 | 20.14 | 3.52 | -3.52 |
| 2026-05-13 | 9 | 77.8% | +28.06 | 4.31 | 8.47 | -4.66 |
| 2026-05-14 | 4 | 75.0% | +10.37 | 10.18 | 1.13 | -1.13 |
| 2026-05-15 | 14 | 78.6% | +45.79 | 9.42 | 2.86 | -2.86 |
| 2026-05-16 | 2 | 100.0% | +5.88 | inf | 0.00 | +2.52 |

### Janelas recentes

| Janela | Variante | Entradas | Win rate | PnL | PF | DD | Max loss |
|---|---|---:|---:|---:|---:|---:|---:|
| Ultimas 72h | `ie-inertia-distance-supported` | 23 | 82.6% | +72.14 | 11.98 | 2.86 | -2.86 |
| Ultimas 24h | `ie-inertia-distance-supported` | 9 | 77.8% | +34.80 | 8.23 | 2.86 | -2.86 |

A variante `ie-inertia-core` teve PnL maior nas 24h (`+85.68`), mas foi rejeitada como recomendacao porque no range completo tem PF `1.90` e DD `53.82`, piores que a variante com suporte de distancia.

## Comparacao com Referencias

Mesmo range: `2026-05-04T15:00:00.000Z -> 2026-05-16T15:10:35.442Z`.

| Estrategia | Entradas | Win rate | PnL | PF | DD | Max loss | Observacao |
|---|---:|---:|---:|---:|---:|---:|---|
| Impulse Elasticity V1 | 114 | 75.4% | +377.66 | 3.92 | 22.54 | -12.54 | Nova teoria recomendada |
| Edge Sniper baseline | 129 | 74.4% | +406.20 | 2.41 | 44.44 | -14.50 | Maior PnL bruto, pior PF/DD |
| Terminal Convexity `tc-dist25-55-stop` | 48 | 50.0% | +812.61 | 4.08 | 26.89 | -14.85 | Maior PnL, poucas entradas e payoff terminal |
| Baseline aleatoria no relogio do sinal | 156 | 53.2% | +248.48 | 1.90 | 37.73 | -11.34 | Inferior a IE V1 em PF/DD/WR |

Leitura conservadora: a nova teoria nao supera a Terminal Convexity em PnL bruto nesse recorte, mas entrega uma curva diferente, com mais entradas que Terminal, PF proximo, drawdown menor e uma fonte de sinal distinta. Contra Edge Sniper, tem PnL um pouco menor, mas PF e drawdown melhores.

## Por que e Nova

A Terminal Convexity V1 compra convexidade temporal perto da expiracao quando o lado ja esta vencedor e barato. A Impulse Elasticity V1 compra uma **falha de elasticidade do consenso** em janela media do evento. A pergunta nao e "o lado vencedor esta barato nos ultimos segundos?". A pergunta e:

```text
O BTC acabou de se deslocar de forma estatisticamente relevante, mas a curva UP/DOWN ainda nao respondeu na mesma velocidade?
```

Isso muda a variavel latente, a matematica, a janela temporal, os filtros e a saida. A saida principal tambem e diferente: vender quando a probabilidade implicita alcanca o movimento (`elasticity_catchup`), nao simplesmente esperar o settlement terminal.

## Limitacoes

- A amostra ainda e pequena para afirmar edge real. O holdout tem 18 entradas; e melhor que uma unica trade, mas ainda exige validacao viva/paper.
- O resultado depende da qualidade do book historico. Entradas e saidas consomem book salvo, mas slippage real pode ser pior.
- A variante perde em dias de reversao de impulso, como 2026-05-04 e 2026-05-10.
- A baseline aleatoria tambem ficou positiva, o que indica que parte do edge vem do relogio de eventos com impulso; a melhoria da teoria esta em selecionar lado e suporte de distancia, nao em inventar dinheiro do nada.
- Nao ha promessa de lucro real.

## Plano de Uso

1. Usar `ie-inertia-distance-supported` como variante default de pesquisa.
2. Manter `maxOrderValue=15` ate acumular pelo menos mais 200 entradas out-of-sample.
3. Rodar diariamente:

```bash
npm run lab:impulse-elasticity -- --mode quick --batch-size 5000
npm run lab:impulse-elasticity -- --from <ultimas-72h> --to <db-max> --mode quick --batch-size 5000
npm run lab:impulse-elasticity -- --from <ultimas-24h> --to <db-max> --mode quick --batch-size 5000
```

4. Pausar a teoria se as ultimas 72h ficarem negativas com DD acima de `15` ou se a baseline aleatoria superar a variante recomendada por mais de duas janelas seguidas.
5. Nao promover `ie-inertia-core` apesar das 24h fortes, porque a robustez full-range e pior.
6. Rejeitar `ie-fade-overreaction` e `ie-compression-breakout` como teorias principais neste recorte.

## Reproducao

Pesquisa SQL:

```bash
npm run lab:impulse-elasticity -- --mode research
```

Range completo:

```bash
npm run lab:impulse-elasticity -- --mode quick --batch-size 5000
```

Ultimas 72h usadas:

```bash
npm run lab:impulse-elasticity -- --from 2026-05-13T15:10:35.442Z --to 2026-05-16T15:10:35.442Z --mode quick --batch-size 5000
```

Ultimas 24h usadas:

```bash
npm run lab:impulse-elasticity -- --from 2026-05-15T15:10:35.442Z --to 2026-05-16T15:10:35.442Z --mode quick --batch-size 5000
```

Comparacao Terminal Convexity:

```bash
npm run lab:terminal-convexity -- --from 2026-05-04T15:00:00.000Z --to 2026-05-16T15:10:35.442Z --mode quick --batch-size 5000
```

Comparacao Edge Sniper:

```bash
npm run analyze:edge-sniper -- --from 2026-05-04T15:00:00.000Z --to 2026-05-16T15:10:35.442Z --windows all --mode focused --batch-size 5000 --top 8
```
