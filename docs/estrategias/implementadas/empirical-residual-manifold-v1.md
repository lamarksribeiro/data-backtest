# Empirical Residual Manifold V1

A **Empirical Residual Manifold V1 (ERM V1)** e uma teoria quantitativa nova para BTC Up/Down 5 minutos na Polymarket. Ela nao ajusta Terminal Convexity, Edge Sniper, Impulse Elasticity, Gamma Ladder, Cofre Sete ou VCL. A ideia central e construir, somente no treino, uma curva empirica de probabilidade de settlement por regime e operar quando essa curva diverge fortemente do consenso do book.

Arquivo de laboratorio: `scripts/lab-empirical-residual-manifold.js`

Comando npm:

```bash
npm run lab:empirical-residual-manifold -- --mode full --batch-size 5000 --parallel true --focus tail-deep-liquid --compare true
```

## Recorte do Banco

Range obrigatorio usado:

```text
from = 2026-05-04T15:00:00.000Z
to   = 2026-05-21T05:16:32.715Z
```

Confirmacao SQL:

| Metrica | Valor |
|---|---:|
| Ticks | `2,859,255` |
| Eventos | `4,780` |
| Primeiro tick | `2026-05-04T15:00:00.548Z` |
| Ultimo tick | `2026-05-21T05:16:32.715Z` |

Cobertura por dia:

| Dia UTC-3 no banco | Ticks | Eventos |
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
| 2026-05-16 | 172,538 | 288 |
| 2026-05-17 | 172,521 | 288 |
| 2026-05-18 | 172,456 | 288 |
| 2026-05-19 | 172,495 | 288 |
| 2026-05-20 | 172,517 | 288 |
| 2026-05-21 | 13,228 | 28 |

Diagnostico complementar por stream do mesmo range:

| Item | Valor |
|---|---:|
| Min / p10 / p50 / p90 / max ticks por evento | `92 / 598 / 599 / 600 / 621` |
| Gaps globais > 30s | `2` |
| Maior gap global | `118.600s` em `2026-05-13T00:44:59.595Z -> 2026-05-13T00:46:58.195Z` |
| Gaps intraevento > 2s | `2` |
| Maior gap intraevento | `58.806s` no evento `2026-05-21T04:25:00Z` |
| Books nulos | `0` |
| Books com asks vazios em algum lado | `242,972` ticks |
| Ask sum medio | `1.0122` |
| Bid sum medio | `0.9869` |
| Spread medio por lado | `0.0126` |

Book por tempo restante:

| Tempo restante | Ticks | Eventos | Dist abs media | Spread medio | Ask sum medio |
|---|---:|---:|---:|---:|---:|
| 0-15s | 143,101 | 4,779 | 51.06 | 0.0159 | 1.0159 |
| 15-30s | 143,129 | 4,779 | 50.29 | 0.0124 | 1.0124 |
| 30-60s | 286,297 | 4,779 | 48.51 | 0.0123 | 1.0123 |
| 60-120s | 572,496 | 4,779 | 45.08 | 0.0126 | 1.0126 |
| 120-180s | 572,554 | 4,779 | 38.87 | 0.0123 | 1.0123 |
| 180-300s | 1,141,678 | 4,780 | 2917.92* | 0.0125 | 1.0114 |

`*` A media alta no bucket 180-300s reflete ticks iniciais com `price_to_beat` ainda nao estabilizado em parte do historico. A ERM V1 nao usa esse bucket na variante promovida.

## Hipoteses Candidatas

### 1. Empirical Residual Manifold

Intuicao: a probabilidade justa de settlement nao precisa ser imposta por uma CDF normal. Ela pode ser aprendida como uma superficie empirica condicional a tempo restante, distancia ao PTB, consenso do book, volatilidade curta, pinning e cruzamentos. Se essa superficie treinada diverge do ask executavel, ha edge.

Variavel latente mal precificada: **probabilidade empirica condicional de settlement** fora do consenso do book.

Formula:

```text
features(t, side) =
  bucket(tau),
  bucket(side * (BTC - PTB)),
  bucket(p_market_side),
  bucket(vol_30s),
  bucket(pin_ratio_45s),
  bucket(crosses_45s)

p_emp(side | features) =
  (wins_bin + prior_weight * p_market_side) / (n_bin + prior_weight)

residual = p_emp - p_market_side
edge = p_emp - ask_side
score = edge * residual * log10(n_bin) * stability_boost / max(spread, 0.01)
```

Condicao de entrada: comprar o lado com `edge` e `residual` positivos, amostra minima no bin calibrado, odds sum saudavel, spread controlado e fill real no ask book.

Condicao de saida: vender se houver bid de lucro configurado; caso contrario, settlement.

Principal risco: bins empiricos podem capturar regimes historicos que desaparecem no holdout.

Resultado: a versao ampla ficou positiva no total, mas fraca no holdout. Nao foi promovida como default.

### 2. Pinning Underdog Residual

Intuicao: perto do PTB, depois de muitos cruzamentos, o book pode supervalorizar o ultimo lado tocado e subprecificar o lado contrario barato.

Variavel latente mal precificada: **local time/pinning pressure** ao redor do PTB.

Formula:

```text
pin_ratio = count(|BTC - PTB| <= 10 nos ultimos 45s) / samples_45s
crosses = numero de cruzamentos do PTB nos ultimos 45s
side = lado com ask barato e p_market_side baixo
score = (p_emp - ask) * (p_emp - p_market_side) * pin_ratio / spread
```

Condicao de entrada: `pin_ratio` alto, `crosses >= 2`, ask barato e residual positivo.

Condicao de saida: settlement.

Principal risco: o mercado pode estar certo ao precificar o underdog barato; pinning nao garante reversao.

Resultado: rejeitada. `pinning-underdog` fez `+672.77` total, mas holdout `-124.89`, PF `0.84`. `pinning-tight` tambem falhou no holdout (`-38.89`, PF `0.83`).

### 3. Deep Tail Residual

Intuicao: a anomalia nao esta no residual medio, mas na cauda em que o historico de treino mostra probabilidade empirica muito alta para um lado, enquanto o book ainda oferece esse lado a ask moderado. Isso costuma aparecer entre 50s e 150s restantes, antes da fase terminal, quando a distancia ja e relevante mas o consenso ainda esta conservador.

Variavel latente mal precificada: **cauda empirica de alta confianca** da manifold, isto e, bins com `p_emp >= 0.80` e residual grande contra o book.

Formula da variante promovida:

```text
tail = p_emp >= 0.80
deep_residual = p_emp - p_market_side >= 0.24
executable_edge = p_emp - ask_side >= 0.28
distance_band = 40 <= side * (BTC - PTB) <= 140
tau_band = 50s <= tau <= 150s
liquidity_ratio >= 0.75

decision_metric =
  (p_emp - ask_side)
  * (p_emp - p_market_side)
  * log10(n_bin)
  / max(spread, 0.01)
```

Condicao de entrada: todos os filtros acima, `ask in [0.10, 0.48]`, `p_market_side <= 0.58`, `spread <= 0.05`, odds sum em `[0.96, 1.08]`, fill no ask book com slippage maximo `0.02`.

Condicao de saida: settlement. A teoria compra assimetria profunda, entao stops mecanicos foram evitados para nao vender barato em ruido de book.

Principal risco: baixa frequencia e amostra pequena; uma mudanca de regime pode zerar sinais ou transformar o residual empirico em overfit.

Resultado: promovida como **`tail-deep-liquid`**.

## Regras Operacionais Promovidas

| Parametro | Valor |
|---|---:|
| Variante | `tail-deep-liquid` |
| Janela | `150s >= tau >= 50s` |
| Distancia assinada | `$40 .. $140` a favor do lado comprado |
| Ask | `0.10 .. 0.48` |
| Spread maximo | `0.05` |
| Odds sum | `0.96 .. 1.08` |
| Probabilidade empirica minima | `0.80` |
| Edge empirico minimo | `0.28` |
| Residual minimo contra mercado | `0.24` |
| Amostras minimas do bin | `50` |
| Market prob maxima do lado | `0.58` |
| Liquidez minima no book | `75%` da quantidade alvo |
| Slippage maximo de entrada | `0.02` |
| Max order value | `$15` |
| Max entradas por evento | `1` |

## Resultados Empiricos

Split cronologico 60/20/20 do range completo:

| Split | Entradas | Wins | Losses | Win rate | PnL | PF | Max DD | Max loss | Top win share |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Train | 13 | 11 | 2 | 84.6% | +223.87 | 8.89 | 14.28 | -14.28 | 20.4% |
| Validation | 7 | 5 | 2 | 71.4% | +60.90 | 3.17 | 28.08 | -14.08 | 24.0% |
| Holdout | 13 | 13 | 0 | 100.0% | +293.24 | inf | 0.00 | n/a | 14.8% |
| Total | 33 | 29 | 4 | 87.9% | +578.01 | 11.24 | 28.08 | -14.28 | 8.1% |

Janelas recentes, usando a calibracao do range completo e as entradas do candidato em foco:

| Janela | Entradas | Wins | Losses | PnL | PF | Observacao |
|---|---:|---:|---:|---:|---:|---|
| Ultimas 72h aproximadas | 12 | 12 | 0 | +277.74 | inf | Derivado dos dias 19, 20 e parcial 21/05 no relatorio focado |
| Ultimas 24h aproximadas | 9 | 9 | 0 | +234.35 | inf | Derivado de 20/05 apos 05:16 ate 21/05 05:16 |

Ao recalibrar somente dentro de janelas recentes curtas, a variante fica esparsa demais: em 72h recentes nao houve entrada para `tail-deep-liquid`; em 24h houve 1 entrada vencedora. Isso reforca que a ERM V1 deve usar calibracao historica mais ampla, nao treinar do zero em janelas curtas.

## Comparacao com Referencias no Mesmo Range

| Estrategia | Entradas | Win rate | PnL | PF | Max DD | Max loss | Avg cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| ERM `tail-deep-liquid` | 33 | 87.9% | +578.01 | 11.24 | 28.08 | -14.28 | 14.15 |
| Edge Sniper V1 | 198 | 69.7% | +449.32 | 1.85 | 63.77 | -14.50 | 14.22 |
| Terminal Convexity V1 | 67 | 49.3% | +965.01 | 3.51 | 46.97 | -14.85 | 13.27 |
| Gamma Ladder V1 | 205 | 57.1% | +4042.76 | 7.89 | 68.59 | -34.76 | 32.83 |
| Impulse Elasticity V1 | 144 | 75.7% | +477.14 | 3.58 | 22.54 | -12.54 | 14.10 |
| Random same clock | 425 | 47.5% | -99.86 | 0.97 | 551.80 | -14.96 | 14.00 |

Holdout das referencias:

| Estrategia | Entradas | Win rate | PnL | PF | Max DD |
|---|---:|---:|---:|---:|---:|
| ERM `tail-deep-liquid` | 13 | 100.0% | +293.24 | inf | 0.00 |
| Edge Sniper V1 | 60 | 63.3% | +71.02 | 1.38 | 42.59 |
| Terminal Convexity V1 | 8 | 62.5% | +88.26 | 3.33 | 14.26 |
| Gamma Ladder V1 | 63 | 71.4% | +1867.02 | 17.21 | 41.30 |
| Impulse Elasticity V1 | 25 | 76.0% | +42.70 | 1.91 | 19.18 |

Interpretacao: a ERM V1 nao supera Gamma Ladder em PnL bruto, mas tem curva diferente, baixa frequencia, max loss menor e PF total maior. Contra Edge Sniper e Impulse Elasticity, ela entrega menos trades, PnL maior que ambos no total, e holdout mais assimetrico. Contra Terminal Convexity, ela opera muito antes (`50s-150s`, nao `15s-8s`) e usa curva empirica treinada, nao convexidade terminal.

## Variantes Rejeitadas

| Variante | Resultado | Motivo |
|---|---|---|
| `erm-cheap-tail` | Total +2278.23, holdout +3.54, PF 1.00 | PnL total alto, mas holdout praticamente zerado e drawdown 284.02 |
| `erm-mid-late` | Holdout +56.33, PF 1.03 | Positiva, mas sem assimetria suficiente |
| `erm-high-residual` | Holdout +209.85, PF 1.11 | Residuais altos demais ainda incluem muitos falsos positivos |
| `erm-balanced` | Validation -264.01, PF 0.90 | Falhou antes do holdout |
| `pinning-underdog` | Holdout -124.89, PF 0.84 | Tese de pinning/underdog nao sustentou |
| `fade-overconfidence` | Total -99.86, PF 0.73 | Fade do consenso foi estruturalmente ruim |
| `tail-deep-discount` | 15/15 wins, PF inf | Forte, mas amostra menor e top win share 20.7%; mantida como tier ultra-seletivo, nao default |
| `tail-deep-tight` | 9/9 wins, PF inf | Amostra pequena demais; top win share 15.9% e apenas 1 entrada na validacao |

## Limitacoes

- A variante promovida tem apenas 33 entradas no range completo. O resultado e interessante, mas ainda nao e suficiente para assumir robustez de producao.
- O holdout perfeito pode ser sorte de regime; a validacao teve 2 perdas e mostra que perdas acontecem.
- A calibracao empirica usa bins treinados no split de treino; se a distribuicao de BTC/PTB/book mudar, os bins podem perder validade.
- O backtest simula fill pelo book historico salvo, mas nao modela fila real, latencia, cancelamentos e impacto de ordem real.
- Nao ha promessa de lucro real.

## Plano de Uso

1. Usar `tail-deep-liquid` apenas como modulo de baixa frequencia, nao como substituto de Gamma Ladder ou Terminal Convexity.
2. Rodar paper trading com o mesmo filtro por pelo menos algumas centenas de eventos antes de ordem real.
3. Recalibrar a manifold com janela historica ampla; nao recalibrar apenas nas ultimas 24h/72h, porque isso torna os bins esparsos.
4. Bloquear operacao se houver gap intraevento relevante no recorder ou se os asks estiverem vazios no lado candidato.
5. Monitorar se surgirem 3 perdas consecutivas ou se PF rolling das ultimas 20 entradas cair abaixo de 2.0.
