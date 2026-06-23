# Terminal Convexity V1

Se voce quiser a versao passo a passo e mais didatica, veja tambem `docs/terminal-convexity-v1-explicacao.md`.

A **Terminal Convexity V1** e uma teoria/estrategia nova para o mercado BTC Up/Down 5 minutos da Polymarket. Ela nao tenta comprar direcao cedo. Ela espera a fase final do evento e compra apenas quando o mercado ainda vende barato um lado que ja esta moderadamente vencedor contra o PTB.

O sinal central e: perto da expiracao, a probabilidade justa de um contrato binario deixa de se mover quase linearmente e passa a ter convexidade terminal. Se o BTC esta alguns dolares a favor de um lado e faltam poucos segundos, uma pequena passagem de tempo aumenta muito a probabilidade desse lado terminar ITM. Quando o book ainda oferece esse lado com ask baixo, o payoff fica assimetrico: perda maxima limitada ao custo, ganho potencial de `qty - cost`.

Arquivo de laboratorio: `scripts/lab-terminal-convexity.js`

Servico integrado de backtest: `src/services/terminalConvexityBacktest.js`

Endpoint integrado: `POST /api/backtest/terminal-convexity`

Na interface, selecione `Terminal Convexity V1` na aba `Backtest`.

Comando npm:

```bash
npm run lab:terminal-convexity -- 2026-04-23T00:00:00.000Z 2026-05-16T04:30:00.000Z quick 5000
```

## Teoria

Para cada lado candidato, defina:

```text
side = +1 para UP, -1 para DOWN
X_t = side * (btc_price - price_to_beat)
tau = segundos ate expiracao
```

O preco terminal justo e aproximado por um modelo normal local:

```text
sigma_tau = max(minSigma, sigmaMultiplier * realizedVol * sqrt(tau))
drift_side = side * (fastMove / fastSec + slowDriftWeight * slowMove / slowSec)
driftTerm = clamp(drift_side * tau * driftWeight, -driftClampSigma * sigma_tau, +driftClampSigma * sigma_tau)
z = (X_t + driftTerm) / sigma_tau
p_side = Phi(z)
```

Onde `Phi` e a CDF normal padrao. A convexidade temporal aproximada e:

```text
theta_tc = phi(z) * abs(X_t + driftTerm) / (2 * sigma_tau * tau)
```

O edge executavel e:

```text
modelEdge = p_side - ask
marketLag = p_side - marketProbability_side
score = modelEdge * max(theta_tc, 0.0001) * (1 + max(0, marketLag)) / max(spread, 0.01)
```

Esta formula procura o ponto em que quatro coisas acontecem ao mesmo tempo:

1. O lado ja esta na frente do PTB.
2. O ask ainda esta barato.
3. O tempo restante e pequeno o bastante para a convexidade terminal importar.
4. O book ainda tem liquidez real para preencher a ordem.

## Regra Operacional Promovida

Nome de laboratorio: `tc-dist25-55-stop`

Parametros principais:

| Parametro | Valor |
|---|---:|
| `entryWindowStart` | `15s` |
| `entryWindowEnd` | `8s` |
| `minAheadDist` | `$25` |
| `maxAheadDist` | `$55` |
| `minAsk` | `0.04` |
| `maxAsk` | `0.45` |
| `maxSpread` | `0.14` |
| `minOddsSum` | `0.82` |
| `maxOddsSum` | `1.20` |
| `minModelProb` | `0.32` |
| `minModelEdge` | `0.08` |
| `entrySlippageMax` | `0.02` |
| `minLiquidityRatio` | `0.55` |
| `maxOrderValue` | `15` |
| `stopIfCrossed` | `true` |
| `stopCrossDist` | `-2` |
| `stopMinBid` | `0.04` |

Fluxo:

1. Processa um evento por vez e mantem amostras dos ultimos 90s.
2. So procura entrada quando faltam entre 15s e 8s.
3. Calcula `p_side`, `theta_tc`, `modelEdge`, `marketLag` e `score` para UP e DOWN.
4. Escolhe o maior score que passa os filtros.
5. Simula compra no book historico ate `ask + 0.02`; nao assume fill magico no best ask.
6. Entra no maximo uma vez por evento.
7. Se o lado cruza contra o PTB antes da expiracao e ainda ha bid >= 0.04, vende para reduzir dano.
8. Caso contrario, segura ate settlement.

## Evidencia Empirica

Dataset local usado:

| Metrica | Valor |
|---|---:|
| Ticks | `3,636,246` |
| Eventos | `6,670` |
| Periodo | `2026-04-23T00:00:00Z -> 2026-05-16T04:30:00Z` |

Antes do runner, um SQL por snapshots mostrou que nos ultimos 15s, quando o lado estava entre `$12` e `$55` a favor e ainda barato, havia edge bruto positivo. O filtro final subiu o piso para `$25` porque o holdout recente deteriorava abaixo de `$18`.

### Resultado no Periodo Completo

| Variante | Max ordem | Entradas | Win rate | PnL | PF | Max DD | Max loss | Decisao |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `tc-dist25-55-stop` | `15` | `127` | `74.0%` | `+3046.27` | `9.97` | `27.87` | `-14.85` | Default recomendado |
| `tc-dist25-55-stop-25` | `25` | `122` | `74.6%` | `+4791.68` | `10.14` | `44.97` | `-24.75` | Tier agressivo moderado |
| `tc-dist25-55-stop-30` | `30` | `118` | `75.4%` | `+5609.43` | `10.51` | `54.39` | `-29.70` | Tier agressivo |
| `tc-t12-5` | `15` | `359` | `67.7%` | `+7448.48` | `5.74` | `214.54` | `-14.86` | Rejeitada como default |

### Split 60/20/20 do Default

| Split | Entradas | Win rate | PnL | PF | Max DD |
|---|---:|---:|---:|---:|---:|
| Train | `93` | `80.6%` | `+2498.29` | `15.02` | `27.87` |
| Validation | `21` | `57.1%` | `+269.20` | `3.85` | `26.89` |
| Holdout | `13` | `53.8%` | `+278.78` | `5.18` | `23.86` |

### Janelas Recentes do Default

| Janela | Entradas | Win rate | PnL | PF | Max DD |
|---|---:|---:|---:|---:|---:|
| 72h recentes | `10` | `50.0%` | `+211.72` | `4.81` | `23.86` |
| 24h recentes | `4` | `50.0%` | `+181.84` | `11.31` | `17.64` |

### Resultado Integrado no Range Operacional Desde 04/05/26 15h

Este teste usa o servico integrado no mesmo formato dos outros backtests da aplicacao.

| Range | Ticks | Eventos | Entradas | Win rate | PnL | PF | Max DD | Max loss |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `2026-05-04T15:00:00Z -> 2026-05-16T04:30:00Z` | `1,992,478` | `3,329` | `47` | `51.1%` | `+823.24` | `4.25` | `26.89` | `-14.85` |

### Comparacao com Edge Sniper no Mesmo Range

| Estrategia | Entradas | Win rate | PnL | PF | Max DD | Max loss |
|---|---:|---:|---:|---:|---:|---:|
| Edge Sniper baseline | `450` | `79.6%` | `+3708.86` | `6.08` | `50.63` | `-14.52` |
| Edge Sniper `maxask060` | `352` | `81.8%` | `+3856.97` | `7.77` | `39.10` | `-15.00` |
| Terminal Convexity default | `127` | `74.0%` | `+3046.27` | `9.97` | `27.87` | `-14.85` |
| Terminal Convexity tier 30 | `118` | `75.4%` | `+5609.43` | `10.51` | `54.39` | `-29.70` |

Interpretacao: o default nao maximiza PnL bruto contra o Edge Sniper, mas entrega uma curva diferente, com menos entradas, PF maior e drawdown menor. O tier 30 supera o PnL bruto do Edge Sniper, mas dobra aproximadamente a perda maxima por evento e deve ser usado apenas se o limite de risco aceitar isso.

## Plano de Uso

1. Rodar `tc-dist25-55-stop` como modo principal da teoria.
2. Manter `maxOrderValue=15` ate ter pelo menos mais 300 entradas out-of-sample ou validacao live/paper.
3. Liberar `maxOrderValue=25` ou `30` somente se:
   - ultimas 72h do default estiverem positivas;
   - nao houver gap grande no recorder;
   - spread/ask sum continuarem dentro dos limites;
   - perda maxima por evento de `$25` ou `$30` couber na carteira.
4. Rejeitar por enquanto a variante `tc-t12-5`, apesar do PnL maior, porque o holdout e as ultimas 72h mostram fragilidade.

## Comandos de Reproducao

Periodo completo:

```bash
npm run lab:terminal-convexity -- 2026-04-23T00:00:00.000Z 2026-05-16T04:30:00.000Z quick 5000
```

Ultimas 72h usadas no teste:

```bash
npm run lab:terminal-convexity -- 2026-05-13T04:30:00.000Z 2026-05-16T04:30:00.000Z quick 5000
```

Ultimas 24h usadas no teste:

```bash
npm run lab:terminal-convexity -- 2026-05-15T04:30:00.000Z 2026-05-16T04:30:00.000Z quick 5000
```

## Riscos

- A amostra de holdout do filtro conservador tem poucas entradas; o payoff e assimetrico, entao poucos vencedores grandes podem dominar a curva.
- O modelo depende de book historico salvo corretamente. Se o book estiver ralo, atrasado ou com gaps, a execucao real pode piorar.
- Esta estrategia compra convexidade terminal; em regimes de reversao violenta nos ultimos segundos, ela pode ter sequencias de perdas.
- Nao ha garantia de lucro real. O resultado e backtest com dados locais e simulacao por book.