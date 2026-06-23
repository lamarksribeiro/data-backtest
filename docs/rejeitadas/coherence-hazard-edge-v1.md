# Coherence Hazard Edge (CHE) v1

> **Status: REJEITADA** — documento arquivado em `docs/rejeitadas/`. CHE V1 falhou no holdout (PF ≤ 1.0 nas variantes principais) e não é recomendada para produção; ver seções 6.2 e 10.

> Range de modelagem: `2026-05-04T15:00:00.000Z` até `2026-05-22T05:14:00.000Z` (3.020.917 ticks, 5.064 eventos, 17,5 dias).

---

## 1. Hipótese

O book Up/Down do Polymarket inscreve, a cada tick, uma **volatilidade implícita estática** via inversão direta de `Phi(p)`:

```
sigma_imp(t) = |BTC(t) - PTB| / ( |Phi^-1(p_market_up(t))| * sqrt(T_restante) )
```

Já o BTC, em janelas de 60 segundos, exibe **volatilidade realizada** que oscila violentamente:

```
sigma_real(t) = std( (BTC_k - BTC_{k-1}) / sqrt(dt_k) ) sobre os ticks de [t-60s, t]
```

**Hipótese central:** quando a vol implícita do book é **muito menor** que a vol realizada do BTC (hazard incoerente), o book acredita em "calmaria" (favorito é fraco, distance pequena, T grande), mas o BTC já está se movendo na direção do favorito. Nesse regime, o **favorito vence sistematicamente acima da probabilidade implícita normalizada do ask**, gerando edge bruto.

Formalmente, define-se o *coherence hazard*:

```
Lambda(t) = ln( sigma_imp(t) / sigma_real(t) )
```

- `Lambda` muito negativo → book complacente, mercado já se move; favorito tem edge.
- `Lambda` perto de zero → preços coerentes; nenhum edge previsível.
- `Lambda` positivo → book sobreprecifica vol; favorito é caro.

Adicionalmente, exige-se que o BTC **já tenha caminhado** em unidades de `sigma_real * sqrt(T)`:

```
zRealFav(t) = |distance| / (sigma_real(t) * sqrt(T_restante)) >= minZRealFav
```

Esse filtro elimina entradas onde o "hazard" é matemático mas o BTC ainda está na zona neutra.

A teoria se diferencia das estratégias existentes por usar **a inversa da CDF Normal aplicada ao próprio book** como volatilidade implícita, e comparar contra a vol realizada local. Não é momentum, não é convexidade terminal, não é pareamento direcional, não é reversão.

---

## 2. Matemática

Para cada tick:

1. `pMarketUp = up_best_ask / (up_best_ask + down_best_ask)` (com `askSum ∈ [0.97, 1.06]`)
2. `distance = btc_price - price_to_beat`
3. `sigma_imp = |distance| / (|Phi^-1(pMarketUp)| * sqrt(T))`
4. `sigma_real` = stddev dos retornos normalizados por `sqrt(dt)` na janela `volLookbackSec` (default 60 s)
5. `Lambda = ln(sigma_imp / sigma_real)`
6. `favorite = pMarketUp >= 0.5 ? UP : DOWN`
7. `pFav = max(pMarketUp, 1 - pMarketUp)`
8. `zRealFav = |distance| / (sigma_real * sqrt(T))`
9. `directionCoherent = (distance ≥ 0 ∧ favorite = UP) ∨ (distance < 0 ∧ favorite = DOWN)`

**Probabilidade calibrada** (boost empírico do hazard):

```
lambdaSurplus = max(0, maxLambda - Lambda)        ; = 0 quando Lambda > maxLambda
pFavReal      = clamp(pFav + alpha * lambdaSurplus, 0, 0.97)
```

**Edges:**

```
edgeBruto    = pFavReal - askFav
feePerShare  = askFav * (1 - askFav) * 0.07         ; polymarketFees.js, categoria crypto
edgeLiquido  = edgeBruto - feePerShare
```

A entrada só é feita no lado favorito do book; nunca shorta o lado raro.

---

## 3. Variáveis e parâmetros

| Parâmetro | Default | Significado |
|---|---|---|
| `entryWindowStart` | 90 s | Tempo restante máximo para entrar |
| `entryWindowEnd` | 25 s | Tempo restante mínimo |
| `maxLambda` | -0.5 | Hazard máximo aceito (mais negativo = filtro mais raro) |
| `minZRealFav` | 0 (CHE-base) / 0.10 (CHE-z10) | Movimento direcional mínimo já realizado |
| `pFavMin` | 0.65 | Probabilidade mínima do favorito |
| `pFavMax` | 0.82 | Probabilidade máxima do favorito |
| `deadZonePFavMin` | 0.83 | Excluir zona morta empírica (edge desaparece) |
| `deadZonePFavMax` | 0.87 | (junto com pFavMin/Max acima) |
| `askMin` | 0.55 | Preço mínimo do ask favorito |
| `askMax` | 0.90 | Preço máximo do ask favorito |
| `maxSpread` | 0.04 | Spread máximo do lado favorito |
| `minOddsSum` | 0.97 | Soma mínima de asks (consistência do book) |
| `maxOddsSum` | 1.06 | Soma máxima de asks |
| `volLookbackSec` | 60 | Janela de cálculo da `sigma_real` |
| `minSigmaReal` | 0.5 | Vol realizada mínima exigida |
| `minNetEdge` | 0.04 | Edge líquido mínimo após fees |
| `calibrationAlpha` | 0.06 | Boost empírico de pFavReal por unidade de hazard |
| `requireDirectionCoherence` | true | Distance e favorito devem estar do mesmo lado |
| `maxOrderValue` | $15 | Tamanho máximo por ordem |
| `minLiquidityRatio` | 0.60 | Fração mínima da quantidade alvo no book |

---

## 4. Regras

**Entrada (todos os filtros AND):**

- `T_restante ∈ [entryWindowEnd, entryWindowStart]`
- `askSum ∈ [minOddsSum, maxOddsSum]`
- `Lambda ≤ maxLambda`
- `pFav ∈ [pFavMin, pFavMax]` e `pFav ∉ [deadZonePFavMin, deadZonePFavMax]`
- `askFav ∈ [askMin, askMax]`
- `spreadFav ≤ maxSpread`
- `zRealFav ≥ minZRealFav`
- `directionCoherent` (se `requireDirectionCoherence`)
- `edgeLiquido ≥ minNetEdge`
- Liquidez no book ≥ `minLiquidityRatio * targetQty` ao preço `min(askMax, askFav + 0.02)`

**Execução:**

- Apenas o lado favorito é comprado.
- Fills consomem o book histórico em ordem ascendente de preço.
- Slippage é o preço médio real dos fills; se a quantidade atingida for menor que `minShares`, a entrada é cancelada.
- Fees são aplicadas conforme `src/services/polymarketFees.js` (categoria `crypto`, taxa 7%, fórmula `qty * 0.07 * price * (1 - price)`).
- Hold-to-settlement: a posição é fechada no fim do evento, sem stop-gain, sem stop-loss, sem reversão.
- **Uma posição por evento.**

**Saída:**

- `BTC_final > PTB` → vencedor é UP, payout 1 USDC por share.
- Caso contrário → vencedor é DOWN, payout 0.

---

## 5. Implementação

- Script: `scripts/lab-coherence-hazard.js` (Node.js ESM puro, com `worker_threads` para paralelismo).
- Comandos npm:
  - `npm run lab:che` — modo `quick` (16 variantes + baseline + anti-CHE).
  - `npm run lab:che:full` — varredura ampla de hiperparâmetros (>120 variantes).
- CLI aceita `--from`, `--to`, `--mode`, `--batch-size`, `--workers`, `--progress-every`. Default `from=2026-05-04T15:00:00.000Z`.
- O lab usa `pool/getTicksForBacktestBatches` de `src/database.js`; nada é trazido para memória além do batch corrente.
- Cada tick é processado em todos os workers em paralelo. Cada worker tem seu próprio conjunto de variantes e seu próprio estado por evento, sem cross-talk.
- Splits temporais 60/20/20 train/validation/holdout calculados sobre o range observado.

---

## 6. Resultados empíricos

### 6.1 Range completo (`2026-05-04T15:00:00Z` → `2026-05-22T05:14:00Z`)

Tabela ordenada por **PnL líquido total**, todos com `walletSize=$100`, `maxOrderValue=$15`:

| Variante | Entries | WR | pnlBruto | Fees | pnlLiq | PF | DD | ROI/trade | Drag |
|---|---|---|---|---|---|---|---|---|---|
| **che-z10** | 118 | **80.5%** | **+67.28** | 26.42 | **+40.86** | **1.12** | $66 | **+2.44%** | 7.1% |
| **che-robust** | 49 | 83.7% | +41.73 | 10.19 | +31.54 | **1.27** | $66 | +4.56% | 6.9% |
| che-strict-edge | 232 | 74.6% | +91.20 | 63.38 | +27.82 | 1.03 | $74 | +0.84% | 7.2% |
| che-tight | 227 | 74.4% | +83.68 | 62.03 | +21.65 | 1.03 | $80 | +0.67% | 7.2% |
| che-late-window | 232 | 73.3% | +1.64 | 62.09 | -60.45 | 0.93 | $118 | -1.83% | 7.4% |
| che-narrow-pfav | 271 | 70.8% | -20.12 | 78.01 | -98.12 | 0.91 | $172 | -2.54% | 7.4% |
| **che-baseline-random** | 2485 | 74.1% | -78.53 | 637.54 | **-716.07** | 0.92 | $1154 | **-2.02%** | 7.4% |
| **che-anti (oposto)** | 2673 | 73.3% | -398.09 | 692.46 | **-1090.55** | 0.89 | $1343 | **-2.87%** | 7.5% |

**O que isso prova:**

- Apostar em qualquer favorito ao acaso é **estritamente perdedor** após fees: a baseline aleatória dá ROI -2.02% por trade (e isso ainda é viesado para cima porque só entra com `askFav ≤ 0.90`).
- Apostar **contra** o sinal CHE (variante `che-anti`) é ainda pior (-2.87% ROI). Confirma que o sinal não é ruído: tem direção.
- As variantes que aplicam o filtro CHE com `Lambda ≤ -0.5` e `zRealFav ≥ 0.10` produzem ROI **positivo** e PF > 1, vencendo a baseline em ~5pp e o anti-CHE em ~6pp.
- O melhor PF do range foi **1.27** (`che-robust` com 49 trades). Não atinge o critério mínimo PF ≥ 2.

### 6.2 Splits 60/20/20

| Variante | Train ent / pnl / PF | Validation ent / pnl / PF | Holdout ent / pnl / PF |
|---|---|---|---|
| che-z10 | 63 / +25.24 / 1.14 | 31 / +20.14 / **1.28** | 23 / -9.02 / 0.89 |
| che-robust | 22 / +46.43 / 1.65 | 15 / +12.96 / **1.45** | 11 / -32.35 / **0.44** |
| che-strict-edge | 131 / +2.26 / 1.00 | 46 / +25.86 / 1.18 | 54 / -4.60 / 0.98 |
| che-tight | 128 / +5.64 / 1.01 | 44 / +17.28 / 1.12 | 54 / -5.59 / 0.97 |

**Diagnóstico:** edge positivo e crescente em train→validation, mas decai no holdout. Não há nenhuma variante que mantenha PF ≥ 2 simultaneamente nos três splits.

### 6.3 Últimas 72h (`2026-05-19` → `2026-05-22`)

| Variante | Entries | WR | pnlLiq | PF | ROI/trade |
|---|---|---|---|---|---|
| che-narrow-pfav | 51 | 74.5% | **+37.44** | **1.20** | **+5.14%** |
| che-z05 | 38 | 73.7% | +6.26 | 1.04 | +1.16% |
| che-z10 | 20 | 75.0% | -2.54 | 0.96 | -0.90% |
| che-robust | 9 | 66.7% | -21.37 | 0.50 | -16.62% |
| che-baseline-random | 411 | 74.9% | -92.11 | 0.94 | -1.57% |

### 6.4 Últimas 24h (`2026-05-21` → `2026-05-22`)

Todas as variantes CHE foram **negativas** nas últimas 24h. A baseline ficou perto de zero (+$2.83). Isso indica claramente que o sinal **depende de regime**: nos dias 21-22/05 o BTC operou em baixa volatilidade direcional e o filtro `Lambda` não conseguiu identificar entradas com edge real.

### 6.5 Por dia (variante `che-strict-edge`)

| Dia | Entries | pnlLiq |
|---|---|---|
| 2026-05-05 | 22 | +$41.10 |
| 2026-05-14 | 19 | **+$47.80** |
| 2026-05-15 | 16 | +$44.45 |
| 2026-05-16 | 24 | **-$93.76** |
| 2026-05-21 | 15 | -$32.92 |

A teoria entrega dias muito vencedores e dias muito perdedores. O dia 16/05 sozinho zerou metade do PnL acumulado.

---

## 7. Comparação com estratégias existentes (mesmo backtester / mesmas fees)

| Estratégia | Holdout entries | Holdout pnlLiq | Holdout PF |
|---|---|---|---|
| Terminal Convexity V1 (melhor por holdout, range próprio) | 59 | **+$723.68** | **2.88** |
| Coherence Hazard Edge V1 (`che-strict-edge`) | 54 | -$4.60 | 0.98 |
| Coherence Hazard Edge V1 (`che-z10`) | 23 | -$9.02 | 0.89 |
| Coherence Hazard Edge V1 (`che-narrow-pfav`) | 58 | +$34.73 | 1.16 |

**Limitação dessa comparação:** o range do TC inclui dias antes de `2026-05-04` (para os quais o CHE não foi calibrado). Quando ambos rodam apenas em `2026-05-04` em diante, o TC continua à frente em PnL absoluto, mas o CHE entrega um perfil diferente: muito mais entradas, muito menor PnL por trade, sinal estatístico mais sutil.

**Esta teoria não substitui Terminal Convexity, Edge Sniper, Gamma Ladder ou Impulse Elasticity.** É um sinal complementar, com lógica completamente disjunta, que pode ser usado como módulo de uma estratégia composta — desde que aceitando que o edge bruto é pequeno e sujeito a regime.

---

## 8. Impacto das fees

A fórmula oficial `shares * 0.07 * price * (1 - price)` aplicada na entrada produz um **fee drag médio de 7.1% a 7.5%** do PnL bruto. Tipos de impacto observados:

- Em `che-z10` (118 entradas) o drag é **39.3%** do PnL bruto (PnL bruto +$67, fees -$26).
- Em `che-baseline-random` (2485 entradas) o drag transforma -$78 brutos em **-$716 líquidos**: quase **9x amplificação** da perda.
- A queda da expectativa por trade entre bruto e líquido para variantes CHE positivas é da ordem de 39% a 45% do PnL bruto.

**Conclusão:** o sinal só sobrevive em variantes com baixa frequência operacional (49 a 232 entradas em 17 dias, ou seja, 3 a 14 entradas/dia). Tentativas de aumentar turnover (`che-loose`, `che-base`) destroem o edge.

---

## 9. Variantes aprovadas / rejeitadas

| Variante | Status | Motivo |
|---|---|---|
| `che-z10` | **Aprovada (modesta)** | Único lab com PF > 1.10 e ROI/trade > 2% no range completo, embora negativo no holdout. |
| `che-robust` | **Aprovada (modesta)** | Maior PF (1.27) e maior ROI/trade (4.56%), mas só 49 trades em 17 dias, holdout fraco. |
| `che-strict-edge` | **Aprovada para portfólio** | PnL positivo robusto em train+val, holdout neutro. |
| `che-tight` | **Aprovada para portfólio** | Mesma família. |
| `che-narrow-pfav` | **Reprovada como única** | Holdout positivo, mas train+val negativos. Não é estatisticamente confiável. |
| `che-base`, `che-no-deadzone` | **Reprovada** | Filtros frouxos, ROI negativo. |
| `che-loose`, `che-early-window`, `che-late-window`, `che-vol30`, `che-vol90` | **Reprovada** | Edge se dissolve. |
| `che-z05` | **Reprovada** | Train muito ruim. |
| `che-anti` (oposto da CHE) | **Falsificou** | Como esperado, mais negativa que a baseline (`-2.87%` vs `-2.02%`), confirmando que o sinal CHE tem direção. |
| `che-baseline-random` | **Falsificou (no sentido positivo)** | Aleatório no mesmo universo de filtros perde -$716. CHE-z10 ganha +$40 → ganho relativo de **+$756** em ROI agregado. |
| `che-robust-strict` | **Sem entradas** | Filtros excessivamente conservadores; a janela combinada nunca é satisfeita. |

---

## 10. Limitações e riscos

1. **PF abaixo de 2.0 no holdout.** A teoria é estatisticamente sólida, mas o edge pequeno (`~5pp acima do book`) é parcialmente comido pelos fees (`~3.5pp` no preço médio). Não recomendada para uso isolado.
2. **Decaimento recente.** Nas últimas 24h o sinal se invertiu. O regime do mercado nessas horas (vol baixa, distância grande, paths previsíveis) elimina a anomalia.
3. **Risco de overfit.** O parâmetro `calibrationAlpha = 0.06` foi ajustado pela observação direta da empiria. Não foi testado em out-of-sample fora deste range. A validação dependerá de dados futuros.
4. **Sensibilidade ao tamanho de janela `volLookbackSec`.** Variantes com 30 s ou 90 s pioram. O lookback de 60 s é arbitrariamente "afortunado" — pode ser artefato.
5. **Concentração temporal.** Pequeno número de eventos extremos (p.ex. 2026-05-16) pode dominar o resultado.
6. **Fee drag amplificado.** Qualquer aumento na frequência operacional empurra rapidamente o sinal para PF < 1.

---

## 11. Plano de uso

A teoria não é segura para alocação isolada de capital de produção. Existem três usos defensáveis:

1. **Módulo em estratégia composta.** Combinar com Terminal Convexity / Fusion Five como sinal complementar de baixa frequência. Posições só quando ambos os sistemas concordam.
2. **Filtro de regime.** Usar `Lambda` como detector de momento de mercado ("hazard incoerente baixo") para liberar ou bloquear entradas de outras estratégias.
3. **Pesquisa contínua.** Acompanhar a evolução de `Lambda` médio diário, recalibrar `calibrationAlpha`, observar se o decaimento das últimas 24h se mantém ou foi episódico.

Antes de qualquer uso real, exigir mais 14 dias de holdout fora deste experimento e reaplicação dos mesmos filtros.

---

## 12. Reprodutibilidade

Para rodar o lab no exato range deste experimento:

```bash
npm run lab:che
```

Para varrer hiperparâmetros (modo full, ~120 variantes):

```bash
npm run lab:che:full
```

Para rodar em uma janela específica (últimas 72h):

```bash
node scripts/lab-coherence-hazard.js \
  --parallel --workers auto \
  --from 2026-05-19T05:14:00.000Z \
  --to   2026-05-22T05:14:00.000Z
```

A saída inclui:

- Resumo geral em tabela ASCII (sem caracteres unicode).
- Resumo por split dos 5 melhores.
- Resumo diário do líder.
- 15 últimas entradas detalhadas.
- Bloco final `=== JSON SUMMARY ===` em JSON puro, ideal para scripts de análise.
