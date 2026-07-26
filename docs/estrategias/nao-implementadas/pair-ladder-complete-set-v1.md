# Pair Ladder Complete-Set V1

**Status:** lab research implementado (`labs/strategies/carry/pair-ladder-complete-set-v1/`) · **proibido conta real**  
**Mercado alvo (fase 1):** Polymarket BTC Up/Down **5 minutos**  
**Família:** `carry` / complete-set path builder  
**Runner:** `pair-ladder-complete-set-runner@1`  
**Data:** 2026-07-26  
**Artefatos RE:** `data-backtest/.tmp/pair-ladder-re/` · canvas `pair-ladder-complete-set`  

> Este documento substitui e absorve `clip-ladder-doggy-v1.md` como spec canônica da estratégia.
> Origem: engenharia reversa cruzada de 5 traders lucrativos observados ao vivo.

---

## 0. Veredito em uma frase

Lucro = **montar um conjunto completo (UP+DOWN) cujo custo médio somado fica abaixo de US$ 1**, com shares quase iguais, **segurando até o redeem** — construído ao longo do path do evento, não por arb atômico de um único tick.

\[
q \cdot (1 - (\bar p_{UP} + \bar p_{DOWN})) > 0
\quad\text{quando}\quad
\frac{\min(q_U,q_D)}{\max(q_U,q_D)} \approx 1
\]

Tudo o mais (clips, spray, late vacuum, multi-asset) é **variante de execução** da mesma invariante.

---

## 1. Universo analisado

| Trader | Wallet / proxy | Tier | PnL all-time | PnL week | Família observada |
|---|---|---|---:|---:|---|
| **DoggyStyIe** | `0x0484…1a` | Diamond | +$191.7k | +$24.6k | Clip Ladder BTC 5m |
| **0xb27…b82** | `0xb27b…b82` | Gold | +$766.9k | −$4.1k* | Micro Spray BTC 5m |
| **0xb55…4d4** | `0xb55f…4d4` | Diamond | +$730.7k | +$44.3k | Multi-horizon pair (BTC/ETH/SOL/XRP) |
| **0xce2…fdc** | `0xce25…fdc` | Diamond | +$499.7k | +$24.6k | Gêmeo do b55 (join +2 min) |
| **mo-money** | `0x32ed…ec3` | Gold | +$163.0k | +$29.8k | Hybrid selective multi-asset |

\*b27 com volume week baixo na amostra — pouco ativo recentemente, mas all-time é o maior do grupo.

Amostra activity API: até 5.000 rows/usuário (offset máx.). Janelas ~5–35h recentes. Leaderboard all-time é a verdade de longo prazo; PnL reconstruído na amostra = `redeem − Σ buy cost` (sem rebates).

---

## 2. Consenso duro (vale para todos os pair-bots)

Traços presentes em **todos** os 5 quando operam complete-set:

| # | Traço | Evidência |
|---|---|---|
| 1 | Compra **UP e DOWN** no mesmo evento | dualShare 65–100% (pair puros ≥97%) |
| 2 | **Zero SELL** mid-event | sellShare = 0 em todos |
| 3 | **Zero MERGE** operacional | só REDEEM do vencedor |
| 4 | Abertura perto de **~50¢** | openCents P50 ∈ 47–54¢ |
| 5 | Edge estrutural só com `avgSum<1` + balance alto | cohort locked WR 80–100% em todos com N≥5 |
| 6 | `avgSum≥1.03` destrói | WR ~11–34%, PnL médio fortemente negativo |
| 7 | Compete no **mesmo evento** | 97 overlaps na amostra; quem fecha avgSum menor ganha |

### Cohort universal (amostra settled)

| Cohort | Doggy | b27 | b55 | ce25 | mo-money |
|---|---:|---:|---:|---:|---:|
| `avgSum<1 & bal≥0.95` WR | **98,9%** | 100%* | 100%* | 80% | **100%** |
| `avgSum≥1.03` WR | 30% | (ruim) | — | 11% | 34% |
| all settled WR / PnL | 52% / −$517 | 50% / +$316 | 100%* / +$1.2k | 55% / −$17 | 53% / −$401 |

\*N pequeno na janela BTC-5m focada; all-time dos anons é massivo.

**Implicação:** a estratégia “vencedora” não é adivinhar UP/DOWN. É **recusar inventário que não trava abaixo de 1**.

---

## 3. Quatro variantes da mesma tese

```text
                    COMPLETE-SET PATH BUILDER
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   CLIP LADDER          MICRO SPRAY          MULTI-HORIZON
   (Doggy)              (b27 whale)          (b55 / ce25)
   50→100 clips         1–20 spray           15m / 1h / daily
   ~9 fills/evento      ~400–800 fills       BTC+ETH+SOL+XRP
   rígido               late vacuum extremo  avgSum alvo <<1
        │                     │                     │
        └──────────────┬──────┴─────────────────────┘
                       │
                HYBRID SELECTIVE (mo-money)
                pair quando dá; senão directional
```

### 3.1 Clip Ladder — DoggyStyIe (template limpo)

- Assinatura dominante: **`50-100-100-100`**
- Abre em **~4s**, preço **~51¢**
- 2º fill lado oposto **96%**
- ~9 buys/evento
- Late scoop ≤15¢ em **~52%** dos eventos
- Só BTC 5m

### 3.2 Micro Spray — 0xb27 (template de intensidade)

- Clips **1–20** (modas 20 e 5)
- **Median ~468 buys/evento**
- Same-second multi-fill em **100%** dos eventos dual
- Late vacuum brutal: últimos segundos em **1–8¢** (ex.: 70–114 fills baratos)
- No overlap `…1785017100`: Doggy avgSum 1,06 (−$3) vs b27 avgSum **0,89 (+$491)** com 70 late cheap
- Risco: quando não consegue avgSum&lt;1, estoura (ex. −$642 no mesmo dia)

### 3.3 Multi-horizon twins — b55 + ce25

- Criados com **2,0 minutos** de diferença (30/04/2026)
- Diamond ambos; week +$44k / +$24k
- Operam **15m** e janelas longas; ETH/SOL/XRP além de BTC
- Sizing irregular (med clip ~17–22); muitos fills/evento (~60–80)
- Conseguem avgSum bem abaixo de 1 **sem depender só do late 5m**
- Mesma invariante; universo expandido

### 3.4 Hybrid — mo-money

- dualShare só **65%** — mistura pair e directional
- Quando trava o par (avgSum&lt;1, bal≥0,95): **100% WR**
- Quando desbalanceia: amostra overall negativa
- Lição: **não copiar a parte directional**; copiar só o modo pair locked

---

## 4. Sobreposição no mesmo evento (aula decisiva)

Em eventos BTC 5m com ≥2 bots:

| Quem | Comportamento típico | Resultado |
|---|---|---|
| Doggy | clips grandes, para de scoop cedo | avgSum frequentemente **>1** → small loss |
| b27 | spray + vacuum final 1–5¢ | avgSum **<1** → big win **ou** big loss se falhar |
| mo-money | sizing misto, às vezes só 2 fills | ganha quando pega o lado barato; senão residual |

**Aprendizado cruzado:** o Clip Ladder puro do Doggy é legível e estável, mas **perde edge para quem vacuum o ask residual no fim**. Nossa v1 deve = Doggy structure + **módulo late vacuum inspirado no b27** + **gates duros que o Doggy não usa**.

---

## 5. Estratégia completa — Pair Ladder Complete-Set V1

### 5.1 Objetivo

Por evento BTC 5m, construir inventário tal que:

1. `q = min(shares_UP, shares_DOWN)` maximizado sob teto de notional  
2. `avgSum = avgUP + avgDOWN ≤ stopAvgSum` (default **0,98**)  
3. `balance ≥ stopMinBalance` (default **0,95**)  
4. Residual `|UP−DOWN| ≤ maxResidualShares`  
5. Settlement por redeem do vencedor; PnL ≈ `q − cost_paired − fee − residual_loss`

### 5.2 Máquina de estados

```text
IDLE
  └─ on event open (τ ∈ [280,300]s left ≈ primeiros 20s)
       └─ OPEN_SEED
            BUY side* × openShares     # side* = ask ∈ [openMin, openMax], senão skip evento
            BUY opposite × clipShares  # hedge imediato (idealmente mesmo tick / <2s)
            └─ BUILD
                 enquanto τ > lateStartSec:
                   se projectedAvgSum(nextClip) > blockAvgSum: NÃO compra
                   se runningAvgSum < stopAvgSum AND balance ≥ stopMinBalance: → LOCKED
                   senão: clip no lado que melhora (avgSum ↓ ou balance ↑)
                 └─ LATE_VACUUM (τ ≤ lateStartSec)
                      só compra lado menor / residual se ask ≤ lateMaxAsk
                      prioridade absolute: equalizar e puxar avgSum
                      se LOCKED: não reabrir risco
                 └─ HOLD_TO_REDEEM
                      proibido SELL / MERGE
                      redeem winner
```

### 5.3 Regras de escolha de lado (BUILD)

Em cada tick com book válido:

1. Calcular `proj` de comprar `clipShares` no UP e no DOWN (walk ask + fee).  
2. Escolher a perna que **minimiza** `projectedAvgSum`, sujeito a:
   - não estourar `maxEventNotional`
   - não estourar `maxSharesPerSide`
   - se `balance < 0.85`, preferir o lado **menor** mesmo com preço um pouco pior (até `rebalanceSlackCents`)
3. Se ambas as pernas pioram avgSum acima de `blockAvgSum` → **passar** (ficar quieto).  
4. Se asks de UP e DOWN no mesmo tick têm `askU+askD ≤ pairSnapMax` → comprar **as duas** (modo same-second, estilo b27/Doggy).

### 5.4 Late Vacuum (peça crítica herdada do b27)

| Param | Default | Motivo |
|---|---:|---|
| `lateStartSec` | 180 | últimos 2 min |
| `lateMaxAsk` | 0.12 | scoop ≤12¢ |
| `lateUltraAsk` | 0.05 | vacuum agressivo ≤5¢ |
| `lateClipShares` | 50 | menor que clip cheio |
| `lateUltraClipShares` | 20 | estilo micro-spray controlado |
| `lateOnlyImprove` | true | só se reduzir avgSum ou residual |

Sem late vacuum, o Clip Ladder do Doggy frequentemente termina com avgSum 1,02–1,12 e perde. Com vacuum, b27 transforma o mesmo path em avgSum 0,89.

### 5.5 Gates (o que falta nos bots observados)

| Gate | Default | Por quê |
|---|---:|---|
| `stopAvgSum` | 0.98 | travar lucro estrutural |
| `stopMinBalance` | 0.95 | |
| `blockAvgSum` | 1.02 | não cavar buraco |
| `maxEventNotional` | 250 | pesquisa; subir depois |
| `maxSharesPerSide` | 400 | |
| `maxResidualShares` | 50 | |
| `maxOpenAsk` | 0.55 | não seed caro |
| `minOpenAsk` | 0.45 | |
| `maxSecToOpen` | 20 | |
| `minSecondsLeftToEnter` | 15 | |
| `applyPolymarketFees` | true | crypto r=0,07 |
| `liquidityMode` | `taker` | baseline honesto (Diamond/Gold) |

> Doggy e b27 **continuam comprando** depois de já poderem travar. Nós **paramos**. Isso é a principal assimetria a nosso favor na engenharia.

### 5.6 Parâmetros de sizing (modo A — Clip Ladder)

| Param | Default |
|---|---:|
| `openShares` | 50 |
| `clipShares` | 100 |
| `mode` | `clip_ladder` |

### 5.7 Parâmetros de sizing (modo B — Micro Spray, ablação)

| Param | Default |
|---|---:|
| `openShares` | 20 |
| `clipShares` | 10 |
| `sprayMaxShares` | 20 |
| `mode` | `micro_spray` |
| `maxFillsPerEvent` | 200 | teto de segurança (b27 faz 400–800) |

Modo B só após modo A provar edge; custo de fees e latência sobe muito.

### 5.8 Fees e execução

- Fee crypto: `fee = shares × 0.07 × p × (1−p)` em cada fill taker.  
- Incluir fee no `projectedAvgSum`.  
- Settlement sem fee.  
- `executionMode` v1: `taker` (honest). Maker resting fica como ablação futura — Escada Dupla morreu nisso.  
- Latência: reavaliar book após 1 tick (≥0,5s) antes do fill (lição Paridade Invariante).

### 5.9 Pseudocódigo canônico

```text
function onTick(book, τ):
  if not opened:
    if τ < 300 - maxSecToOpen: return
    if not seedable(book): return
    placeBuy(seedSide, openShares)
    placeBuy(opposite, clipShares)
    opened = true
    return

  if locked: return          # HOLD
  if τ <= lateStartSec:
    vacuum(book)
    maybeLock()
    return

  if canSnapBoth(book):      # askU+askD+fees <= pairSnapMax
    placeBuy(UP, clipShares); placeBuy(DOWN, clipShares)
    maybeLock(); return

  leg = bestImprovingLeg(book)
  if leg is None: return
  if projectedAvgSum(leg) > blockAvgSum: return
  placeBuy(leg.side, clipShares)
  maybeLock()

function maybeLock():
  if avgSum < stopAvgSum and balance >= stopMinBalance and residual <= maxResidualShares:
    locked = true

function vacuum(book):
  side = smallerSide()
  ask = book.ask(side)
  if ask <= lateUltraAsk: placeBuy(side, lateUltraClipShares)
  else if ask <= lateMaxAsk: placeBuy(side, lateClipShares)
```

---

## 6. O que NÃO fazer (anti-padrões)

| Anti-padrão | Por que falha | Quem ensinou |
|---|---|---|
| Multiplicador / martingale | explode notional quando avgSum>1 | Escada Dupla rejeitada |
| Maker resting como fonte do edge | fill rate irreal no backtest | Escada auditoria |
| Arb snapshot FOK dual | quase não existe no lake | Paridade Invariante |
| SELL mid-event | nenhum bot lucrativo do grupo vende | consenso 5/5 |
| Continuar após avgSum>1,02 | cohort tóxico | todos |
| Copiar directional do mo-money | dualShare baixo → amostra negativa | mo-money |
| Spray sem teto (800 fills) na v1 | fees + risco operacional | b27 losses |

---

## 7. Plano de lab

### Layout

```text
labs/strategies/carry/pair-ladder-complete-set-v1/
  strategy.json
  strategy.js
  defaults.json
  params.schema.json
  presets/
    btc-clip-ladder-guarded.json      # modo A + gates
    btc-clip-ladder-vacuum.json       # modo A + late vacuum on
    btc-micro-spray-ablation.json     # modo B
  experiments/
    smoke.json
    train-may-june.json
    holdout-july.json
    ablation-vacuum.json
    ablation-gates.json
```

### Critérios de promoção

1. Smoke 2–3 dias sem crash.  
2. Treino mai–jun, fees on, taker: PnL>0 e PF≥1,2.  
3. Holdout jul: PF≥1,1 e não colapsar vs treino.  
4. Ablation: vacuum OFF piora; gates OFF piora; multiplicador piora.  
5. Replay qualitativo vs fills Doggy/b27 nos overlaps documentados.  
6. **Proibido data-robot** até 2+3+4.

### Smoke 2026-07-26 (janela 20–21/07, fees crypto)

**Iteração A** — vacuum flat/orphan:

| Variant | PnL | Entries | PF |
|---|---:|---:|---:|
| `no-vacuum` | +$6,56 | 230 | 1,09 |
| `guarded-default` | −$697 | 428 | 0,66 |

**Iteração B** — seed amplo @ ~1,03:

| Variant | PnL | Entries | PF |
|---|---:|---:|---:|
| `guarded-default` | −$7.888 | 461 | 0,74 |

**Iteração C — calibração Doggy-path (2026-07-26):**

Achados duros (RE ao vivo + lake):

1. Doggy hoje: +$1.654 no dia; posição live com avgSum **0,979** (500 UP@31¢ + 450 DOWN@66¢).  
2. Path real: `50→100→100…` incluindo rebalance a **80¢+** e chase a **20¢**; median fill 50¢, p10=11¢.  
3. No lake, `askU+askD ≈ 1,01` quase sempre (só 4 ticks ≤1,0/dia) → **snap same-tick é inútil**; edge é temporal.  
4. Cohort locked (`avgSum<1 & bal≥0,95`) é lucrativo no bruto; residual + fees taker crypto destroem o total.  
5. Runner atual: underweight-chase + cushion rebalance + `refuseAvgSum` + seed dual 50/50.

| Variant (calibrate) | PnL | WR | PF |
|---|---:|---:|---:|
| `small-notional` | −$3.945 | 35% | 0,24 |
| `uw-chase` (default) | −$4.183 | 41% | 0,18 |

Diag 1d pré-fee: locked ~140 eventos / +$1,4k lockedPnl, overall ainda negativo (bal médio ~0,87).

**Gap restante (atualizado na Iteração E):** Doggy **é** taker (fee+rebate). O gap do lab não é “virar maker”; é path/seleção/timing (e rebate de volume) sob fill taker honesto. **Não promover / sem conta real.**

Reports: `reports/labs/pair-ladder-complete-set-v1/2026-07-26T03-*-pair-ladder-complete-set-*`  
RE live: `.tmp/pair-ladder-re/doggy-*.json`

**Iteração D — fillMode + scaleOnlyTowardLock (2026-07-26):**

| Mode | Janela | PnL | WR | PF | Fees | Nota |
|---|---|---:|---:|---:|---:|---|
| `optimistic_maker` | 20–21/07 | +$1.311 | 96% | 14,3 | 0 | teto irreal (bid imediato) |
| `resting_maker` | 20–21/07 | **+$144** | 89% | **1,15** | 0 | candidato |
| `taker` | 20–21/07 | −$4.183 | 41% | 0,18 | ~2,9k | baseline honesto |
| `mid` | 20–21/07 | −$4.520 | 6% | 0,03 | ~4,4k | não salva |
| `resting_maker` | **18–24/07 holdout** | **+$71** | 87% | **1,02** | 0 | sobrevive, frágil |
| `taker` | 18–24/07 | −$17.046 | 38% | 0,16 | — | confirma gap de execução |

Conclusão (revogada em parte pela Iteração E): a invariante complete-set **existe** no lake sob fill maker-resting, mas isso **não** é a execução do Doggy. `resting_maker` positivo = artefato de modelo, não paridade RE. Ainda **proibido conta real**.

**Iteração E — Doggy é taker (2026-07-26, reanálise activity):**

Fonte: `.tmp/pair-ladder-re/doggy-activity-fresh.json` (wallet `0x0484…1a`, BTC 5m, ~25–26/07).

| Evidência | Resultado | Implicação |
|---|---|---|
| `usdcSize − price×size` vs fee crypto `C·0.07·p·(1−p)` | erro mediano ~0; ratio ~1,000 | **100% dos fills pagam fee de taker** |
| Activity `TAKER_REBATE` | **+$1.049,86** (1 payout) | conta no [Taker Rebate Program](https://docs.polymarket.com/trading/taker-rebates) |
| Cashflow ~1d | buys $102.096 · redeems $101.686 · rebate $1.050 → **PnL ≈ +$639** | **sem rebate ≈ −$410** no mesmo overlap |
| Join fill×book lake 25/07 | ~50/50 near_ask/near_bid (±0,5¢, sync ±2s) | **ruído de book**; fee fecha o caso |
| Assinatura sizing | dominante `50-100-100-100…`; 1º fill ~51¢ | path Clip Ladder **mantém**; execução **não** |

AvgSum (305 eventos com bal≥1): mediana **0,986**; ~58% &lt;1; lockedPnl bruto ≈ +$675 **antes** de fees (~$2,7k) — o edge complete-set sozinho **não** cobre fee; sobra residual + rebate.

**Veredito:** Doggy opera como **taker agressivo** (BUY hit/walk), zero sells, redeem, rebate de volume. `fillMode=resting_maker` **não** deve ser tratado como paridade Doggy. Próximo honesto: path/gates sob `taker` + fees crypto, e opcionalmente modelo de **taker rebate** por tier; não otimizar PF do maker.

Scripts: `labs/sandbox/doggy-maker-vs-taker.mjs`, `labs/sandbox/doggy-decode-path.mjs`.

**Iteração F — decodificar o path (2026-07-26):**

Activity expandida (~5k rows, 432 eventos BTC 5m, 24–26/07) + join lake 20–25/07 + cashflow por evento.

| Achado RE | Número | Consequência no lab |
|---|---|---|
| Execução | 100% fee taker; 2× `TAKER_REBATE` ($2480+$1050) | rebate material; overlay `feeOptions.takerRebateRate` |
| PnL amostra | −$707 **sem** rebate · **+$2.824 com** | volume tier é parte do P&L Doggy |
| Open | 91% nos 30s; firstPx med 0,51 | `maxSecToOpen=30`, banda 0,45–0,58 |
| Hedge | **96%** 1º/2º fill lados opostos; same-sec só **8%**; gap med **18s** | `seedHedgeSameTick=false` (antes forçava dual @ ~1,02) |
| Sizing | `50-100-100…` dominante | `open=50`, `hedge/clip=100` |
| avgSum | med 0,986; lt0,95 → mean PnL +$18; gt1 → −$17 | gates importam; Doggy ainda opera gt1 |
| Residual ≥25 | win rate **64%** | tilt direcional secundário |
| Fill vs ask lake | med −0,9¢ vs ask | `spreadCents=0` (sem bump) |
| Bug lab | `scaleOnlyTowardLock` bloqueava 1º chase pós-seed flat | corrigido: melhora avgSum + residual ≤ cap |

Diag 1d (20/07, pré-fee) após fix async: avgSum med **0,98**, ~63% &lt;1, WR ~37% — estrutura finalmente parece Doggy. Com fees crypto no lab 20–21/07 o PnL ainda é negativo (rebate 50% melhora mas não vira). Gap restante: preço efetivo Doggy (≤ ask), seleção/stop quando path afunda, residual tilt, e rebate de tier alto.

Artefato: `.tmp/pair-ladder-re/doggy-decode.json`. Preset: `btc-doggy-parity-taker`. **Proibido conta real.**

**Iteração G — regras canônicas do path (2026-07-26):**

Scripts: `doggy-deep-rules.mjs`, `doggy-vs-lab-replay.mjs`.

| Regra Doggy | Evidência | Lab |
|---|---|---|
| Open 1 lado ~50sh @45–55¢ em ≤30s | 78% banda; sec med 4 | `maxSecToOpen=30` |
| Hedge oposto **async** | gap med **18s**; same-sec 8% | `seedHedgeSameTick=false`, `minSecToHedge=5`, `hedgePreferAsk=0.50` |
| Pós-dual: quase só **underweight** | 3150 under vs 122 over | `forbidOverweight=true` |
| Continua após avgSum≤0.95 | 266/290 continuam (muitos vacuum) | `softLockAllowVacuum=true` |
| Late vacuum ≤15¢ | 217 eventos; px med 7¢ | `lateMaxAsk=0.15` |
| Fill efetivo ≤ ask lake | med **−0,9¢** vs ask | research: `slippageCents=-1` |
| Rebate volume | ~76% das fees na amostra | **corrigido Etapa 3 → Diamond 44%** |

Stack honesto no lake (20–25/07, 4d):

| Camada | PnL |
|---|---:|
| Path G + ask−1¢ **pré-fee** | **+$4,1k** |
| + fees crypto | −$14,6k |
| + rebate **76% (artefato)** | ≈ −$0,3k — **corrigido na Etapa 3: usar 44%** |

Conclusão: o “pergaminho” é **path temporal underweight + fill ≤ ask + rebate de taker**. Sem as duas últimas camadas, o lab sangra fees. Com as três, aproxima break-even; Doggy ainda leva residual tilt (~67% final) e possivelmente fill/timing melhores. **Não é maker. Sem conta real.**

**Etapa 1 — replay tick-a-tick (2026-07-26):**

Script: `labs/sandbox/doggy-tick-replay.mjs` → `.tmp/pair-ladder-re/doggy-tick-replay.json`  
Canvas: `doggy-tick-replay-etapa1.canvas.tsx`  
Browser: `@doggystyie` Activity = **Buy + Redeem** only; live Jul 26 (lake local só até 25).

| Check | Resultado |
|---|---|
| Match fill×lake 24–25/07 | 2802/3602 (78%; resto fora do lake) |
| Sync dsec=0 | **99,9%** dos matched |
| Med fill−ask exact / ±1s / ±2s | **−0,69¢ / −0,68¢ / −0,69¢** (estável) |
| Mediana global fill−ask | **−0,70¢** (média −1,1¢) |
| ≤ ask−1¢ | **46%** |
| Walk &gt; ask+1¢ | **25%** |
| Buckets | AT_ASK 647 · WALK 602 · AT_BID 559 · BELOW_BID 784 |

**Achado:** o erro de sync **não** explica o fill melhor que o ask. A melhoria é real no join segundo-a-segundo. Paradoxo: fee=taker, mas ~48% classifica AT_BID/BELOW_BID no snapshot — **fechado na Etapa 4**: artefato do lake 1Hz (med fill−min(ask±1s)=0).

**Etapa 2 — política pós-dual estado→ação (2026-07-26):**

Script: `labs/sandbox/doggy-postdual-policy.mjs` → `.tmp/pair-ladder-re/doggy-postdual-policy.json`  
Canvas: `doggy-postdual-etapa2.canvas.tsx`  
Browser: Activity live Jul 26 00:30–00:45 ET = **Buy + Redeem** only (Diamond).

| Check | Resultado |
|---|---|
| Fills pós-dual classificados | 2806 (396 eventos) |
| UNDER / OVER / FLAT | **2370 / 86 / 350** (under **84,5%**) |
| Matriz avg×residual | UNDER ≥95% em todo bucket n≥50; OVER nunca domina |
| Após avg≤0,95 | **250/250** continuam (média 5,9 fills) — soft stop |
| Após avg≥1 | **303/303** continuam (média 7,3 fills) — **sem hard stop** |
| Residual→winner final | **68%** (dual 49% · open 50%) |
| Overweight intencional | **1,4%** |
| under≤30¢ → loser | **76%** (vacuum dying side) |
| under&gt;55¢ → winner | **72%** (chase do caro) |
| Clip overshoot flip residual | **85%** dos UNDER |
| PnL médio hit vs miss residual | **+$3,9** vs **−$18** |

**Achado:** a política canônica é **sempre UNDER** (forbidOverweight fiel). Não há kill switch por avgSum. O tilt ~68% **não** é overweight no favorito — emerge de vacuum do dying side + chase under do lado caro com clip 100 que vira o residual. Lab: manter `forbidOverweight` + `softLockAllowVacuum` + **`softLockAllowBuild=true`** (continua chase após lock); **não** tratar `stopAvgSum` como hard exit; clip 100 overshoot é feature do tilt.

**Etapa 3 — rebate como sistema / tier (2026-07-26):**

Script: `labs/sandbox/doggy-rebate-tier.mjs` → `.tmp/pair-ladder-re/doggy-rebate-tier.json`  
Canvas: `doggy-rebate-etapa3.canvas.tsx`  
Docs: [Taker Rebate Program](https://docs.polymarket.com/trading/taker-rebates) · Browser: badge **Diamond**.

| Check | Resultado |
|---|---|
| Docs Diamond / Obsidian | **44%** / **50%** das fees taker |
| Lag-match 26/07 ÷ fees 25/07 | **$1049,86 / $2386,03 = 44,000%** (Δ≈0) |
| Payout | diário **00:00 UTC** → rebate_D cobre fees_{D−1} |
| Artefato “~76%” | mesma-janela rebate/fee (errado); infla PnL ~+$1087 nesta amostra |
| Lab | `takerRebateRate=0.44` · `POLYMARKET_TAKER_REBATE_TIERS` / `DEFAULT_TAKER_REBATE_RATE_DIAMOND` |
| wV | `TradeSize × (1−price) × 2.3` (crypto); Diamond precisa 30d wV ≥ $4M |

**Achado:** rebate Doggy = **tier Diamond oficial (44%)**, não uma taxa empírica ~76%. Modelar como sistema de tier + lag diário. Overlay 0.76 **proibido** em paridade.

**Etapa 4 — paradoxo BELOW_BID / fill ≤ ask (2026-07-26):**

Script: `labs/sandbox/doggy-below-bid-paradox.mjs` → `.tmp/pair-ladder-re/doggy-below-bid-paradox.json`  
Canvas: `doggy-below-bid-etapa4.canvas.tsx`

| Check | Resultado |
|---|---|
| Match fill×lake 24–25/07 | 2792 |
| Fee = crypto taker `C·0.07·p·(1−p)` | **99,96%** (med \|err\|≈0) |
| AT_BID + BELOW_BID | **1332 (48%)** — todos com fee taker |
| Med fill−ask(snapshot) | **−0,68¢** |
| Med fill−**min(ask±1s)** | **0,00¢** |
| Resoluções top | taker&lt;ask snapshot 801 · VWAP t−1 259 · ask@t−1 163 |

**Achado:** o paradoxo **não** é maker. O lake 1Hz perde o ask intra-segundo que o taker hit; contra o melhor ask da vizinhança ±1s a mediana do fill é o próprio ask. `slippageCents=-1` permanece proxy honesto do join — **não** autoriza `resting_maker` como paridade Doggy.

**Etapa 5 — holdout honesto path G (2026-07-26):**

Experimento: `experiments/doggy-holdout-etapa5.json` → report `…T05-09-04-761Z-pair-ladder-doggy-holdout-etapa5`  
Canvas: `doggy-holdout-etapa5.canvas.tsx` · cashflow: `doggy-holdout-cashflow.mjs`

Janela lab **22–25/07** (4d, 1027 entradas). Overlap activity Doggy **24–25/07**.

| Variante | PnL 4d | WR |
|---|---:|---:|
| ask + fee | −$22,1k | 14% |
| ask + Diamond 44% | −$15,6k | 30% |
| ask−1¢ + fee | −$15,4k | 46% |
| **ask−1¢ + Diamond 44%** | **−$6,5k** | **52%** |

Overlap 24–25: lab best **−$2,9k** vs Doggy **+$0,7k** (@44% nas fees da amostra) → gap ≈ **−$3,6k**.

**Achado:** o stack RE é monotônico e correto na direção, mas **não fecha paridade**. Gap restante = seleção/timing/path fino (lab entra em ~todo evento) + fill além do proxy −1¢ — não rebate nem sync. **Não promover. Sem conta real.**

**Etapa 6 — seleção Doggy vs lab (2026-07-26):**

Script: `labs/sandbox/doggy-selection-filters.mjs` → `.tmp/pair-ladder-re/doggy-selection-filters.json`  
Canvas: `doggy-selection-etapa6.canvas.tsx`  
Janela overlap **24–25/07** · path lab = ask−1¢ + Diamond 44%.

| Cohort | N | Lab PnL |
|---|---:|---:|
| both | 292 | −$1,7k |
| lab_only (Doggy skip) | 203 | −$814 |
| doggy_only | 12 | — |
| lab all | 495 | −$2,5k |

| Check | Resultado |
|---|---|
| Oráculo só slugs Doggy | lab kept −$1,7k (remove −$814 de lab_only) |
| openBand minEither 45–55 | kept 118 · overlap Doggy 86% · kept ainda −$1,0k |
| fracCheap med | both **0,70** vs lab_only **0,47** |
| Paridade both (n=291) | med Doggy **+$0,79** vs med lab **−$11,01** (Δ −$11,74) · Σ Doggy +$83 vs lab −$1,7k |

**Achado:** seleção é real (~⅓ do sangramento lab), mas **não fecha paridade**. O gap dominante é **path nos eventos em comum**. Nenhum filtro de open testado vira o kept positivo com overlap honesto — **não plugar filtro novo**. Próximo foco = path fino nos both (clip/cadence/stop), não mais gates de entrada.

**Etapa 7 — decomposição do PnL + assinatura de momentum (2026-07-26):**

Scripts: `labs/sandbox/doggy-momentum-signature.mjs` → `.tmp/pair-ladder-re/doggy-momentum-signature.json`  
Base: ledger 429 eventos settled (24–26/07) + join book lake 24–25/07 (2798 fills).

Decomposição do PnL Doggy (amostra settled, sem/com rebate):

| Componente | Valor |
|---|---:|
| Locked edge `q(1−avgSum)` | **+$1.746** |
| Residual tilt | **+$2.175** |
| Fees taker | −$4.638 |
| Rebate Diamond 44% | +$2.042 |
| **Total** | **≈ +$1.360** |

O residual tilt é **tão grande quanto** o locked edge — e o lab só replica o locked. Nos eventos com residual 26–75 shares (n=222), o locked é ~0 e o residual rende +$2.070. Preço marginal do residual: med **54¢** com hit rate **67%** → **+14,6¢/share** de edge direcional real (não é overweight no favorito: a 20–70¢ o EV é +21 a +36¢/share; ≤20¢ é neutro).

Assinatura de momentum (fills 20–70¢, `d15 = ask_lado − ask_lado@t−15s`):

| Classe | N | Hit | EV/share |
|---|---:|---:|---:|
| **MOMO** (d15 ≥ +2¢) | 992 (55%) | 0,554 | **+5,2¢** |
| FLAT | 251 | 0,438 | −2,5¢ |
| REV (d15 ≤ −2¢) | 555 | 0,398 | −3,5¢ |
| *Baseline mercado (qualquer tick MOMO)* | 20k | 0,496 | **−1,3¢** |

MOMO é positivo em **todas** as bandas de preço (pico +8¢ em 40–55¢; late 240–300s chega a **+13¢**); FLAT/REV negativos em quase todas. O baseline do mercado prova que momentum genérico de odds **não** é lucrativo — a seleção do Doggy é melhor que o sinal público de 1Hz (candidatos: lê spot BTC direto e compra a odd defasada; e/ou timing intra-segundo — consistente com fill ≤ ask da Etapa 4).

**Achado (reframe da estratégia):** o Doggy **não é** um arbitrador de complete-set. É um **momentum-taker direcional com hedge estrutural**: (1) chase MOMO do lado que sobe = motor de lucro; (2) hedge/rebalance REV = custo do container que limita a perda quando erra; (3) rebate Diamond paga ~44% do pedágio. O leg-choice do lab (`bestImprovingLeg` = minimizar avgSum) compra sistematicamente o lado **barato/caindo** — é o fluxo REV de EV negativo. Esse é o gap de −$11,74/evento da Etapa 6.

**Próximo lab:** inverter a política de BUILD — clip no lado cujo ask **subiu** ≥2¢ em 15s (enquanto underweight permitir), hedge no lado oposto só em pullback/lateStart; manter gates. Ablação A/B: `legChoice=minAvgSum` vs `legChoice=chaseMomo` na janela 24–25/07, cohort both.

**Etapa 8 — path fino / bug rebalance (2026-07-26):**

Script: `labs/sandbox/doggy-path-parity.mjs` → `.tmp/pair-ladder-re/doggy-path-parity.json`  
Canvas: `doggy-path-etapa8.canvas.tsx`

| Métrica (both n=291) | Doggy | Lab pré | Lab pós-fix |
|---|---:|---:|---:|
| shares med | 585 | **1250** | 750 |
| fills med | 8 | 13 | **8** |
| dualSec med | 36s | **0,9s** | 8,9s |
| buyUsdc med | $304 | $598 | $340 |
| Σ PnL | +$83 | −$1,7k | −$1,8k |
| med Δ lab−Doggy | — | −$11,7 | −$8,1 |

**Causa raiz:** `tryBuild`/`rebalance` completava o hedge no **mesmo tick** do seed quando `tryHedgeOpposite` respeitava `minSecToHedge` — bypass estrutural (fills `rebalance` dominavam o path).

**Fix:** build/rebalance/snap só após inventário dual; `seed_hedge` é o único hedge pré-dual. Size defaults → `maxEventNotional=350`, `maxSharesPerSide=500`, `maxFillsPerEvent=12`.

**Achado:** estrutura de path alinhou (fills/size/dual), mas **paridade de PnL não**. Complementa a Etapa 7: sem o bypass, o lab deixa de sprayar REV cedo; o gap restante é late vacuum + scale-up seletivo + (próximo) leg-choice MOMO. **Não promover. Sem conta real.**

**Etapa 9 — ablação legChoice min_avg_sum vs chase_momo (2026-07-26):**

Script: `labs/sandbox/doggy-legchoice-ablation.mjs` → `.tmp/pair-ladder-re/doggy-legchoice-ablation.json`  
Canvas: `doggy-legchoice-etapa9.canvas.tsx`  
Runner: `legChoice=min_avg_sum|chase_momo` (+ `momoLookbackSec/MinRise/MinAsk/MaxAsk`).

| Variante | both PnL | med Δ lab−Doggy | momo fills |
|---|---:|---:|---:|
| **chase_momo_rise3** | **−$1,3k** | −$7,1 | 890 |
| chase_momo (rise≥2¢) | −$1,3k | −$7,3 | 911 |
| chase_momo_band4055 | −$1,6k | −$9,7 | 805 |
| min_avg_sum (baseline) | −$1,8k | −$8,1 | — |
| chase_momo_clip50 | −$1,8k | −$7,7 | 1987 |

**Achado:** inverter o leg-choice para MOMO melhora **+$430** no cohort both e confirma a Etapa 7 em direção. Ainda **não fecha paridade** (Doggy both +$83; gap ~−$1,4k). O d15 no lake 1Hz é sinal fraco vs seleção Doggy (baseline mercado MOMO −1,3¢). Preset research: `btc-doggy-parity-momo`. **Não promover. Sem conta real.**

**Etapa 10 — observer live local (2026-07-26):**

Script: `labs/sandbox/doggy-live-observer.mjs`  
Output: `.tmp/pair-ladder-re/live-observer/<runId>/` (`fills.jsonl`, `books.jsonl`, `summary.json`)

```bash
cd data-backtest
node labs/sandbox/doggy-live-observer.mjs --minutes=45
```

Só-leitura (Gamma + CLOB WS/REST + Binance + activity wallet). Smoke 2,5 min: **8 fills**, med fill−ask **−1,0¢**, momoShare **38%**. WS rollover de evento estabilizado.

**Fix pós-smoke:** warm da Data API podia falhar em silêncio e dump de backlog cross-slug contaminava fill−ask (run `2026-07-26T19-07-09-969Z` marcada `CONTAMINATED.md`). Observer agora: warm com retry + `liveGateAt` + só slug ativo + `bookMatched`/lag≤2,5s. Analisador: `doggy-live-analyze.mjs`. Lead no lake: `doggy-spot-lead.mjs`.

Próximo: sessão limpa ≥30–45 min → analisar lead spot / fill−ask / dAsk (só `bookMatched`).

**Etapa 11a — spot/lean lead no lake (2026-07-26):**

Script: `labs/sandbox/doggy-spot-lead.mjs` → `.tmp/pair-ladder-re/doggy-spot-lead.json` (days 07-24/25, n=2798 fills).

| Classe | n | hit | ev/share | med dAsk15 |
|---|---:|---:|---:|---:|
| **CHASE** (ask +≥2¢/15s) | 1499 | 0.61 | **+4,4¢** | +9¢ |
| FADE (ask −≥2¢) | 828 | 0.36 | −2,6¢ | −9¢ |
| FLAT | 407 | 0.44 | −2,2¢ | 0 |
| LEAN (ask flat, lean implícito) | 64 | 0.34 | −4,5¢ | +2¢ |

Mid band 20–70¢: CHASE ev **+5,2¢** vs FADE **−3,5¢**. Aceleração do ask (61% dos mid): ev +4,0¢ vs no-accel −2,5¢. LEAN (candidato a lead spot externo sem movimento no book) é **ruim** e raro.

**Achado:** Doggy é chase do book já em movimento, não anticipação silenciosa. Gate acionável no lab = reforçar `chase_momo` / bloquear FADE mid-band — não inventar spot-lead gate sem evidência live. Live session ainda necessária para fill−ask e Δspot real. **Não promover.**

**Etapa 11b — sessão live limpa 45 min (2026-07-26):**

Run: `.tmp/pair-ladder-re/live-observer/2026-07-26T19-09-13-503Z/` (`analyze.json`)

| Métrica | Valor |
|---|---:|
| fills / bookMatched | **58 / 58** |
| med fill−ask | **−1,27¢** |
| belowAskShare | 67% |
| momoShare (dAsk15≥+2¢) | **57%** |
| fadeShare | 29% |
| spotLeadShare (Δspot5 a favor) | **14%** |
| med Δspot5s | ≈0 |

Confirma 11a ao vivo: fill tipicamente ≤ ask (−1¢), motor = chase do book, **não** lead de spot. Gate spot-lead descartado. Próximo = path fino (vacuum unlock + bloquear FADE mid). **Não promover.**

**Etapa 12 — vacuum unlock + bloquear FADE mid (2026-07-26):**

Script: `labs/sandbox/doggy-legchoice-ablation.mjs` → `.tmp/pair-ladder-re/doggy-legchoice-ablation.json`  
Runner: `momoBlockFade` (container mid-band só se MOMO ou ask≤`chaseMaxAsk`).

| Variante | both PnL | Δ vs chase_momo | vacuum both | medVac/ev | rebalance |
|---|---:|---:|---:|---:|---:|
| **chase_momo_vac_nofade** | **−$1.276** | **+$225** | 28 | 0 | **0** |
| chase_momo_no_fade | −$1.309 | +$192 | 18 | 0 | **0** |
| chase_momo | −$1.501 | 0 | 17 | 0 | 281 |
| chase_momo_vac_unlock | −$1.568 | −$67 | 22 | 0 | 281 |
| min_avg_sum | −$1.746 | — | 17 | 0 | 1097 |

Doggy both Σ **+$83**. Critério de sucesso (≥+$700 e medVac≥1,0) **não atingido**. Vacuum unlock sozinho piora; `momoBlockFade` elimina rebalance FADE e recupera ~+$200, mas o lab ainda quase não vacuum (28 vs ~377 Doggy) — `late*` knobs não destravam o scoop no lake 1Hz.

**Achado:** path fino no runner saturado. Gap residual ~**−$1,4k** no both é seleção/timing **intra-segundo** (fill ≤ ask, escolha de clip MOMO) não observável no book 1Hz. **Congelar RE de params 1Hz.** Preset research continua `btc-doggy-parity-momo` (+ `momoBlockFade` disponível). **Não promover. Sem conta real.**

---

## Estratégia canônica (RE Doggy — congelada 2026-07-26)

Modelo operacional inferido (não é complete-set arb):

```
open 45–55¢ ≤30s (clip ~50)
  → hedge async oposto ~3–18s (clip ~100, prefer ask≤50¢)
  → BUILD chase MOMO (ask do lado +≥2¢/15s, banda 20–70¢)
  → late vacuum dying side (≤15–20¢, clip ~50) + soft lock (avg≤0.95 sem hard exit)
  → redeem + taker fee crypto − Diamond rebate 44%
```

| Peça | Evidência | Status lab |
|---|---|---|
| Taker + Diamond 44% | fees / activity | ok |
| Open band / size / dual async | path parity Etapa 8 | ok estrutural |
| Motor = chase MOMO | Etapas 7, 9, 11a/b | `legChoice=chase_momo` (+~$430) |
| Bloquear FADE mid | Etapa 12 | `momoBlockFade` (+~$200) |
| Late vacuum residual tilt | Etapas 2, 7, 12 | **não replicado** (medVac≈0) |
| Fill ≤ ask / seleção intra-s | Etapas 4, 10–11b | proxy `slippageCents=-1`; gap PnL permanece |
| Spot-lead gate | Etapas 11a/b | **descartado** (spotLead 14% live) |

**Veredito:** a estratégia *descrita* está fechada. A *paridade de PnL* no lake 1Hz **não** — edge Doggy depende de qualidade de fill / escolha de momento abaixo da resolução do lake. Próximo trabalho útil (se houver): shadow live com book tick-by-tick próprio, não mais grid de params no Parquet 1Hz.

### Métricas por evento (obrigatórias)

- `avgSum`, `balance`, `lockedEdge`, `residualSide`
- `lateVacuumShares`, `sameSecondPairs`
- `feeDrag`, `fillCount`
- flag `blockedByGate`

---

## 8. Roadmap pós-v1

| Fase | Escopo |
|---|---|
| V1 | BTC 5m · Clip Ladder + vacuum + gates |
| V1.1 | Micro-spray ablation com teto de fills |
| V2 | BTC 15m (padrão b55/ce25) se V1 holdout ok |
| V3 | ETH/SOL 15m — só se edge sobreviver a fees e competição |
| Live | shadow ≥14 dias → micro-canário explícito |

---

## 9. Riscos e honestidade

1. All-time dos whales **não** garante edge futuro — amostra recente do Doggy ficou flat/negativa.  
2. Diamond/Gold embutem **taker rebate** material (Doggy Diamond = **44%** das fees; payout ~$1k/dia na amostra; sem isso o dia fica negativo).  
3. Late vacuum é campo minado: vários bots competem pelo mesmo ask de 2¢.  
4. b27 prova que intensidade sem gate = cauda esquerda enorme (−$600/evento).  
5. Twins multi-asset podem estar colados a infraestrutura/colocation que não temos.  
6. Esta spec é **pesquisa**; promoção só com backtest honesto.

---

## 10. Referências rápidas

| Item | Path / URL |
|---|---|
| Artefatos RE | `.tmp/pair-ladder-re/cross-analysis.json` |
| Doggy perfil | https://polymarket.com/@doggystyie |
| Escada rejeitada | `docs/rejeitadas/escada-dupla-v1.md` |
| Paridade | `labs/strategies/arbitrage/paridade-invariante-v1/README.md` |
| Doc anterior (absorvido) | `clip-ladder-doggy-v1.md` |

---

## 11. Checklist mental antes de codar

- [x] Consenso: complete-set path, não prediction  
- [x] Consenso: nunca vender  
- [x] Consenso: avgSum&lt;1 + balance é o único edge  
- [x] Doggy: sizing discreto e early open  
- [x] b27: late vacuum e same-tick dual  
- [x] Twins: tese generaliza a outros horizons (fase 2)  
- [x] mo-money: ignorar directional  
- [x] Gates mais duros que os bots  
- [ ] Lab + smoke + holdout  
- [ ] Sem conta real
