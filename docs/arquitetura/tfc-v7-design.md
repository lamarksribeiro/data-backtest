# TFC V7 — Design "Maker Carry" (executável em conta real)

Data: 2026-07-07 · Autor: orquestração (maestro) · Status: **em implementação**

Base empírica: `labs/sandbox/tfc-v7-diagnostic-report.md` (diagnóstico 59d, 2026-05-04→2026-07-01)
e histórico de experimentos em `reports/labs/tfc/`.

## 1. Fatos que fundamentam o design

| # | Fato | Número | Fonte |
|---|------|--------|-------|
| 1 | Mecanismo tardio 8→4s vale 35,6% do PnL e tolera 1s de latência | +$1.443,59; degradação -$0,17/trade | diag A.2, B.4 |
| 2 | Flips após o piso 4s são o maior vazamento | -$1.877,50 (215 eventos, -$8,73 cada) | diag A.1 |
| 3 | Zona 0–4s é inexecutável | 21% dos ticks com book válido; 17,8% com depth ≥$10 | diag B.2 |
| 4 | Hedge stop da V6 está morto | 0,8% de fill; fallback taker faz o trabalho | diag A.3 |
| 5 | Custo de entrada taker é enorme | fee $833 + slippage médio $0,017/share (~$850) em 59d | diag run metadata, B.3 |
| 6 | Entradas tardias são melhores | WR τ5–10s = 78,9–80,6% vs τ25–30s = 71,6–73,4% | loss-analysis (tau bins) |
| 7 | minAsk 0,65 e gate dist/vol destroem PnL | Δ -$1.389 e -$3.619 | diag C.3 |
| 8 | Defensive exit por distância fixa perde | max $3.880 vs $4.060 champion | v51-defensive-exit |
| 9 | Reverses são mitigação de perda cara | -$4,16/trade pagando ask até 0,95 | diag A.1 |
| 10 | Book aguenta sizing maior | depth topo médio $132; ordem $10 consome 1,2 níveis | diag B.3 |

## 2. Mecanismos da V7

### M1 — Entrada maker com fallback taker (núcleo da versão)

Quando os gates de entrada abrem (mesma pilha V5: envelope ask 0,55–0,82, spread ≤0,03,
dist <20, OBI ≥0, velocity guard), em vez de comprar taker no ask:

1. postar **limit buy passiva** no favorito a `ask − entryMakerDelta` (default 0,01);
2. reprecificar (cancel/replace) se o ask se mover mais que `entryMakerChase` (default 0,02)
   enquanto os gates continuam válidos;
3. se não preencher até `entryMakerDeadlineSec` (τ default 10s), **fallback taker** ao ask
   corrente se os gates ainda passam (respeitando maxAsk);
4. fill maker: fee zero + sem slippage. Fill simulado com a regra conservadora existente
   (`best_ask ≤ P − epsilon`) — viés pessimista: captura apenas fills adversos.

Racional: economiza ~$0,45–0,50/entrada (fee+slippage) sobre um edge de $1,13/entrada;
o fallback tardio entra na faixa τ 5–15s que historicamente tem WR maior (fato 6).

Requisito de infra: o `orderSimulator` só suporta `placeLimitBuy` como hedge (lot
secundário). É preciso permitir **entrada primária maker** (fill vira `position` normal,
com o mesmo ciclo de vida de `enter()`), mantendo compatibilidade byte-idêntica com
presets v1–v6 (params default off).

### M2 — Reverse tunado (cap de preço + confirmação)

Mesma janela 8→4s. Sweep: `lateFlipReverseMaxAsk ∈ {0.80, 0.85, 0.88, 0.95}` ×
`lateFlipConfirmEnabled/lateFlipMinAdverseMove` × `lateFlipReverseMinAsk ∈ {0, 0.55}`.
Quando o cap bloquear o reverse, cai no exit puro (vender no bid) — mitigação parcial.

### M3 — Danger-zone exit vol-relativo (aposta secundária, barata)

No piso (τ ∈ [4, 5]s), se `|signedDistance| < k × sigma_spot(5s)`, sair no bid.
Sweep `k ∈ {0.3, 0.5, 0.8}` + variante off. Ataca o fato 2 (-$1.878). Expectativa baixa
(fato 8), mas a versão vol-relativa nunca foi testada.

### M4 — Sizing por profundidade

`entryBudget ∈ {10, 15, 20, 25}` medindo degradação de expectância por slippage
(walk do book já modela). Se exp degradar <10% até $20–25, o preset real usa budget
dinâmico `min(cap, α × depthTop)`. Meta: PnL absoluto ~2× em conta real sem piorar DD relativo.

### M5 — Remoções

- `hedgeStopEnabled false` (fato 4) — sai do preset e simplifica o robô.
- Nenhuma ação taker com τ < 4s (fato 3) — invariante da versão.

## 3. Experimentos e critérios

Splits: **train** 2026-05-04→2026-05-31 · **june** 2026-06-01→2026-07-01 ·
**holdout julho (inédito)** 2026-07-01→2026-07-06. Fees on, depth 25, compiled-soa,
`dailyMetrics: true`.

Ordem: M1 isolado → M2/M3 sobre o melhor M1 → M4 sobre o combo → validação 3 splits.

Critérios de promoção (`btc-champion-v7`):

1. PnL 59d ≥ $4.060 (V5 Practical) e june ≥ $2.304;
2. holdout julho positivo e consistente (sem dia < -$60);
3. maxDD ≤ $81; PF ≥ 1,56;
4. robustez maker: ranking estável com `epsilon ∈ {0.005, 0.01, 0.02}` (ΔPnL < 15%);
5. executabilidade: nenhuma ação taker τ<4s; toda reação tolera 1s de latência.

Se M1 não superar a baseline mesmo no cenário pessimista de fill, a V7 vira
"V5 Practical + M2/M4 + remoção do hedge" (ganho menor, ainda válido).

## 4. Port para conta real (data-robot)

- Entrada maker = ordem GTC pós-only + cancel/replace; fallback taker = FAK com maxPrice.
- Reverse/exit tardio = FAK na janela 8→4s (1s de latência tolerada, fato 1).
- Cancel obrigatório de qualquer ordem viva a τ ≤ 2s.
- Espelhar params em `data-robot/src/tfc/preset-v7.js` ao promover.

## 5. Resultado da validação (2026-07-07)

### Fix crítico: fill conservador do stop-buy

O `checkRestingOrders` preenchia `stop_buy` ao **preço do gatilho** (`notional = shares × stopPrice`), não ao ask corrente. Com o rastreamento escalar de best ask (fix do tick cursor), a V6 Hybrid “ressuscitou” ($4.129 full na validação v1 vs $3.607 documentado).

**Correção aplicada:** ao disparar o gatilho, walk do book do tick corrente (como taker) com `capPrice` explícito (`hedgeStopCapAsk`, default 0.95); se `currAsk > cap`, ordem permanece armada (`stopTriggered`) e pode preencher em tick posterior dentro do cap; fee **taker** via `liquidity: 'taker'`.

**Impacto V6 Hybrid (full 59d):**

| Modelo de fill | PnL | Δ vs v5 |
|---|---:|---:|
| Otimista (preço do stop) | $4.129 | +$69 |
| Conservador (ask corrente + cap) | $3.882 | −$178 |

A V6 deixa de superar a V5 Practical em full/june com fill honesto.

### Tabela revalidação (fill conservador) — 5 variantes × 3 janelas

| Variante | Full PnL | Full DD | June PnL | June DD | Holdout PnL | Holdout DD |
|---|---:|---:|---:|---:|---:|---:|
| **v7-danger-reference** | **$4.086** | $80 | **$2.321** | $80 | $239 | $60 |
| v5-practical-reference | $4.060 | $81 | $2.304 | $80 | $255 | $60 |
| v6-plus-danger | $3.950 | $72 | $2.264 | $72 | $352 | $52 |
| v6-hybrid-reference | $3.882 | $72 | $2.246 | $72 | $356 | $52 |
| v6-danger-armed | $3.711 | $72 | $2.184 | $72 | $298 | $52 |

Holdout: 2026-07-01→2026-07-05 (partição 07-06 ausente no lake local). Runs: `v7-final-validate-2-{full,june,holdout}`.

### Decisão

**Promovido `btc-champion-v7` (studioVersion 8):** V5 Practical + `dangerExitEnabled` k=0.3 floor 4s, hedge stop off. Única variante que supera v5 em **full e june** com DD ≤ $85 e holdout positivo.

Composições V6-based (hybrid, +danger, danger-armed) mantêm holdout forte mas perdem PnL em full/june vs v5 com fill conservador — não promovidas.

**Argumento decisivo de executabilidade contra a família V6:** a Polymarket não tem ordem
stop nativa no CLOB. O "stop-buy" da V6 seria um stop **sintético** — o robô observa o ask
do oposto e dispara taker quando cruza o gatilho. Esse disparo pode ocorrer a τ < 4s, na
zona proibida (21% de book válido, repricing violento, 1s de latência), exatamente o cenário
que o diagnóstico provou inviável. Mesmo com fill conservador, o simulador concede fills que
o robô real não consegue reproduzir. A V6 permanece como referência de simulador; a V7
mantém o invariante: **nenhuma ação que exija reação com τ < 4s**.

### Rejeições dos sweeps M1/M1b/M2 (train / june)

| Sweep | Melhor variante | Train Δ vs baseline | June Δ vs baseline | Motivo |
|---|---|---:|---:|---|
| M1 maker+fb | m1-d0.01-dl12-fb1 | −$289 | −$322 | PnL inferior nos dois splits; entradas −12% |
| M1b late entry | m1b-maxsec-20 | −$86 | −$696 | Restringir maxSecondsLeft destrói volume sem ganho net |
| M2 reverse tune | m2-rev-0.85 | −$47 | −$42 | Cap reverse <0.95 corta mitigação sem compensar |

### Curva de capacidade M4 (train / june, budget sweep)

| Budget | Train PnL | Train DD | June PnL | June DD | Eficiência PnL vs b10 |
|---:|---:|---:|---:|---:|---:|
| 10 | $1.756 | $81 | $2.304 | $80 | 100% (referência) |
| 15 | $2.558 | $152 | $3.324 | $108 | ~97% |
| 20 | $3.164 | $189 | $4.314 | $147 | ~90% |
| 25 | $3.629 | $232 | $5.322 | $185 | ~83% |

**Recomendação:** conta real começa em budget 10; pode escalar até ~$20 com eficiência ≥90%; acima disso DD cresce desproporcionalmente.

