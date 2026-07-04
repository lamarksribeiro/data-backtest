# Extensão do Order Simulator — Ordens LIMIT pré-posicionadas (maker)

**Objetivo:** estender o motor de backtest GLS para simular ordens LIMIT repousando no book (maker), permitindo comparar com números duas variantes da TFC V5:

- **A (baseline executável):** Late Flip Reverse taker na janela 8s→4s (`btc-champion-v5-practical`)
- **B (candidata):** entrada taker no favorito + **LIMIT de compra pré-posicionada no lado oposto**, preenchida passivamente durante o repricing do flip tardio — sem exigir reação sub-segundo do robô

Status: **implementado** · Preset promovido: `btc-champion-v6-hybrid` (Estúdio v7) · Data: 2026-07-04

---

## 1. Contexto e motivação

A TFC V5 provou que **virar para o lado oposto** quando o spot cruza o PTB nos segundos finais quase triplica o PnL da V4. Porém a análise de liquidez no cubo (`labs/sandbox/tfc-late-flip-liquidity.mjs`, 448 cruzamentos tardios) mostrou que o reverse **taker** nos últimos 2s é irrealista não só por latência, mas por **preço**:

| Momento do cruzamento | Fill $10 no novo fav | Preço médio do fill |
|---|---|---|
| τ ≤ 2s | 62% | $0,81 (38% acima de $0,95) |
| τ 5–8s | 81% | $0,73 |
| τ 8–15s | 87% | $0,71 |

Quando o robô taker reage, o book já repricou. A hipótese da variante B é capturar o preço **durante** a transição: uma LIMIT de compra no lado oposto (ex.: bid $0,40) já está no book quando o flip acontece; o mercado atravessa o preço dela e ela executa **sem latência de reação**. Bônus: ordens maker na Polymarket **não pagam taker fee**.

O simulador atual não modela isso — só fills taker imediatos (walk do book no tick corrente). Este documento especifica a extensão.

---

## 2. Estado atual (o que existe hoje)

### 2.1 `orderSimulator.js`

- **Fills taker imediatos**: `enter()` varre os níveis de ask (`fillAsks`, até `book_depth ?? 25`) no tick passado em `options.tick`; `exit()` varre bids (`fillBids`). Consumo de liquidez por preço é rastreado em `consumedAsksBySide`/`consumedBidsBySide` (não reutiliza o mesmo nível no evento).
- **Posição única e unilateral**: `position = { side, totalShares, remainingShares, totalCost, openCost, avgEntryPrice, peakBid }`. `enter()` falha se já há posição. `reverse()` = exit total + enter no oposto.
- **Settlement** (`settleEventPnl`): lado vencedor por `underlying > ptb`; PnL de expiração = `remainingShares - openCost` (win) ou `-openCost` (loss), somado ao `realizedPnl`.
- **Sem conceito de ordem pendente**: toda ordem executa (ou falha) no instante da chamada.

### 2.2 `runtime.js`

- Por tick: `buildRuntimeContext()` → `updatePeakBid` → `runHook('onTick')`.
- **Finalização antecipada**: se houve entrada e a posição fechou (`!positionView.open`), o evento finaliza imediatamente e ticks restantes são ignorados (`processIndex`/`processTick`). Isso é incompatível com ordens repousando — ver §5.4.
- `finalizeEvent()` monta o `eventRecord` com `orders`, `exits`, `finalPnl` e chama `settleEventPnl`.

### 2.3 Fees (`src/backtest/fees.js`)

- Pós-processamento sobre `result.events`: coleta trades de `orders` (type `entry`) e `exits`, aplica `shares * feeRate * price * (1-price)` (crypto 0.07) e recalcula o summary. **Todo fill é tratado como taker.**

### 2.4 GLS (parser/validator/compilerSoa/blocks)

- Ordens são funções top-level registradas em `ORDER_FUNCTIONS` (`blocks.js`) e emitidas em `emitStaticCall` (`compilerSoa.js` linhas 203–206) como `orders.<fn>(...)`.
- Runtime injeta `ordersApi` nos hooks compilados; adicionar função nova = registrar no catálogo + emitir no compilador + implementar no simulador (não há whitelist adicional).

### 2.5 Dados

- Lake `backtest_ticks` BTC 5m depth 25, cadência real ≈ **2 ticks/s** (~600 ticks por evento de 300s) — resolução suficiente para detectar o book atravessando um preço.
- Não há **trade prints** (execuções), só snapshots de book. O modelo de fill maker precisa ser uma heurística sobre snapshots (§4).

---

## 3. Modelo conceitual

### 3.1 Nova entidade: `restingOrder`

```js
{
  id: 'lim-1',              // sequencial por evento
  kind: 'limit_buy',        // MVP: só compra passiva
  side: 'UP' | 'DOWN',      // lado a comprar
  price: 0.40,              // preço limite (bid nosso)
  budget: 10,               // notional máximo
  shares: 25,               // floor(budget / price) — calculado no place
  placedTs, placedRow,      // rastreio
  status: 'open' | 'filled' | 'cancelled' | 'expired',
  fill: { ts, price, qty, notional, liquidity: 'maker' } | null,
  reason: 'hedge_limit',
}
```

MVP deliberadamente restrito a **limit BUY** (é o que a variante B precisa). Limit sell (saída passiva) fica fora do escopo — anotado em §9.

### 3.2 Posição em dois lados (par hedgeado)

Quando a LIMIT do lado oposto executa com posição aberta no favorito, o simulador passa a ter **dois lotes**:

```js
lots = {
  UP:   { shares, cost } | null,
  DOWN: { shares, cost } | null,
}
```

- `position`/`positionView` continuam apontando o **lote primário** (o da entrada original) — zero mudança para estratégias existentes.
- Novo campo `positionView.hedge = { side, shares, cost } | null` exposto ao GLS (`position.hedge` read-only, mesma mecânica do `positionView` atual).
- `exit()`/`reverse()` continuam operando só no lote primário (MVP). O lote hedge só nasce via fill de LIMIT e só morre no settlement.

### 3.3 Settlement com dois lotes

`settleEventPnl` passa a somar os dois lados:

```
winnerSide = underlying > ptb ? 'UP' : 'DOWN'
expiryPnl  = Σ_lados ( lado == winnerSide ? lot.shares - lot.cost : -lot.cost )
finalPnl   = realizedPnl + expiryPnl
```

Caso típico da variante B com flip: lote fav (perdedor) = `-openCost`; lote hedge (vencedor) = `shares_hedge - cost_hedge`. Com fill a $0,40, cada $10 de hedge vira ~$25 → recupera a perda do fav e ainda lucra. Caso whipsaw (flip momentâneo, fav vence): hedge executou e expira sem valor = custo seco de `cost_hedge` — este é o preço do seguro e a razão de o nível da LIMIT precisar de sweep.

---

## 4. Modelo de fill maker (o coração da extensão)

Não temos trade prints; o fill é inferido do movimento do book entre snapshots.

### 4.1 Regra de disparo (conservadora)

Uma `limit_buy` no lado S a preço P é considerada executada no primeiro tick em que:

```
best_ask(S, tick) <= P - epsilon        (default epsilon = 0.01)
```

Racional: se o melhor ask do lado S caiu **abaixo** do nosso bid P, o mercado negociou através do nosso preço — qualquer vendedor agressor teria consumido nossa ordem antes de o ask repousar abaixo de P. Exigir `P - epsilon` (atravessar de verdade, não só encostar) compensa duas incertezas: fila de prioridade no nível (não somos os primeiros do book) e o gap entre snapshots.

### 4.2 Preço e quantidade do fill

- **Preço**: `P` (nosso limite). Nunca há price improvement no MVP — conservador.
- **Quantidade**: `min(shares, liquidez estimada)`. Duas políticas, parametrizáveis no experimento:
  - `fillPolicy: 'full'` — preenche tudo quando dispara (default; em cruzamentos reais o book vira por completo, ver cubo: ask do lado antigo médio $0,24 pós-flip).
  - `fillPolicy: 'level-capped'` — limita ao tamanho visível no nível ≥ P do snapshot anterior ao disparo (mais conservador, pior caso).
- Fill **integral ou nada por tick** (sem parciais entre ticks) — simplifica e o erro é pequeno na cadência de 0,5s.

### 4.3 Quando checar

No runtime, **antes** de `runHook('onTick')` em cada tick (junto de `updatePeakBid`):

```js
orderSim.checkRestingOrders(normalizedTick);   // dispara fills maker
```

Assim o hook GLS do mesmo tick já enxerga `position.hedge` atualizado (pode, por exemplo, cancelar o late flip exit se o hedge executou).

### 4.4 Expiração e cancelamento

- `onEventEnd`/`finalizeEvent`: toda resting order `open` vira `expired` (custo zero) — equivale ao robô cancelar no settlement.
- `cancelLimit(id?)` disponível no GLS para cancelamento explícito (ex.: cancelar o hedge se saiu da posição primária via late flip exit).

### 4.5 Limitações declaradas do modelo

1. **Fila de prioridade** não modelada — mitigada pelo epsilon de atravessamento.
2. **Fills intra-gap**: se o book atravessa e volta entre dois snapshots (< 0,5s), perdemos o fill → viés conservador (subestima fills).
3. **Auto-trade não considerado**: assumimos que nosso bid não altera o comportamento do book (ordem pequena, $10).
4. Validação de sanidade contra o cubo em §8.3.

---

## 5. Mudanças por arquivo

### 5.1 `src/backtestStudio/gls/orderSimulator.js`

```js
// Estado novo
let restingOrders = [];        // por evento
let lots = { UP: null, DOWN: null };
let limitSeq = 0;

// API nova
placeLimitBuy(side, { price, budget, shares, reason, ts })
  // valida price ∈ (0,1), budget>0; shares = floor(budget/price) se ausente
  // máx. N resting orders simultâneas (limits.maxRestingOrders ?? 4)
  // retorna { id, ... } ou false
cancelLimit(idOrNull)          // null = cancela todas 'open'; retorna nº cancelado
checkRestingOrders(tick)       // §4; ao disparar: cria fill maker, credita lots[side],
                               // registra order { type:'entry', liquidity:'maker', reason } em orders[]
get restingView()              // [{ id, side, price, shares, status }] p/ GLS (read-only, análogo a positionView)
```

Ajustes em código existente:

- `enter()` credita `lots[side]` além de `position` (posição primária = lote primário).
- `exit()` debita `lots[position.side]` em sincronia com `remainingShares`.
- `snapshot()` inclui `restingOrders` e `lots`.
- `reset()` limpa `restingOrders`, `lots`, `limitSeq`.
- `settleEventPnl()` reescrito para somar lotes (§3.3) e reportar `hedgeFill` no retorno (para o eventRecord).

### 5.2 `src/backtestStudio/gls/runtime.js`

- `buildRuntimeContext()`: chamar `orderSim.checkRestingOrders(normalized)` logo após `updatePeakBid`.
- **Finalização antecipada** (`processIndex`/`processTick`): a condição
  `temEntrada && !positionView.open` passa a exigir também `restingView.every(o => o.status !== 'open')` — evento com LIMIT viva continua processando ticks.
- `finalizeEvent()`: expira resting orders abertas; anexa ao `eventRecord`:
  `restingOrders` (resumo), `hedgeFill` (se houve), `hedgePnl` (decomposição do settlement).
- `positionView.hedge` exposto no `sharedCtx` (mesma view mutável, sem alocação por tick).

### 5.3 GLS — superfície da linguagem

- `blocks.js`: `ORDER_FUNCTIONS` += `placeLimitBuy`, `cancelLimit`.
- `compilerSoa.js` e `compiler.js` (`emitStaticCall`):

```js
if (path === 'placeLimitBuy') return `orders.placeLimitBuy(${args[0] || "''"}, __objectArg(${args[1] || '{}'}))`;
if (path === 'cancelLimit')   return `orders.cancelLimit(${args[0] ?? 'null'})`;
```

- `validator.js`: nada além do catálogo (validação de membros `position.hedge.*` segue a regra atual de acesso dinâmico em locals).
- `interpreter` (runtime.js): registrar as duas funções no mesmo mapa das ordens atuais (paridade entre modos de execução).

### 5.4 `src/backtest/fees.js` — maker fee zero

- `addTrade()`: propagar `liquidity` do fill/order.
- `summarizeTrades()`: `if (trade.liquidity === 'maker') continue;` (fee 0, mas somar shares/notional em contadores separados `makerNotional`/`makerShares` para relatório).
- `feeTotals` += `makerTradesFree`, `makerNotional` — o report mostra quanto volume foi isento.

### 5.5 `TerminalFavoriteCarry.gls` — params novos (default-off)

```gls
// V6: Hedge LIMIT pré-posicionada no lado oposto (desativado por padrão)
param hedgeLimitEnabled = false
param hedgeLimitPrice = 0.40        // preço da LIMIT (sweepável)
param hedgeLimitBudget = 10         // notional do hedge
param hedgeLimitMaxSecondsLeft = 30 // só posiciona se ainda faltam >= N s (coloca junto da entrada)
param hedgeCancelOnLateExit = true  // cancela hedge se sair via late flip exit
```

Lógica: imediatamente após `enter()` bem-sucedido, `placeLimitBuy(oppositeSide, { price: hedgeLimitPrice, budget: hedgeLimitBudget, reason: "hedge_limit" })`. Se `lateFlipExit` disparar e `hedgeCancelOnLateExit`, chamar `cancelLimit()` antes do exit. Com hedge preenchido (`position.hedge`), o late flip exit/reverse é **suprimido** — o par já está travado.

---

## 6. Experimento de comparação (o número que queremos)

### 6.1 Variantes

| id | Configuração | O que responde |
|---|---|---|
| `taker-8-4` | V5 Practical exata (`lateFlipExitSec 8`, `lateFlipMinSec 4`, reverse taker) | baseline executável atual |
| `limit-p30` … `limit-p60` | `hedgeLimitEnabled`, `hedgeLimitPrice ∈ {0.30, 0.40, 0.50, 0.60}`, **sem** late flip (`lateFlipExitEnabled false`) | LIMIT pura substitui o reverse? |
| `hybrid-p40` | LIMIT $0,40 **+** late flip exit 8→4 (cancela hedge ao sair) | melhor dos dois mundos? |
| `v5-teto` | V5 sec=2 (referência superior teórica) | quanto do gap a LIMIT recupera |

Grid nos dois arquivos já padronizados do lab (`labs/strategies/terminal/tfc/experiments/`):
`v6-limit-hedge-train.json` (2026-05-04 → 2026-05-31) e `v6-limit-hedge-june.json` (2026-06-01 → 2026-07-01), `variantWorkers 6`, `compiled-soa`, e validação final 59d com `dailyMetrics: true`.

### 6.2 Métricas de decisão

Além do summary padrão (PnL, WR, PF, maxDD, dias positivos), o eventRecord estendido permite extrair por variante:

- **hedge fill rate**: % de eventos com hedge executado;
- **hedge útil vs seguro queimado**: fills em eventos onde o fav perdeu (recuperação) vs onde o fav venceu (whipsaw, custo `cost_hedge`);
- **PnL decomposto**: `pnl_lote_primário` + `pnl_hedge` + `fees` (com `makerNotional` isento);
- **sensibilidade ao epsilon/fillPolicy**: rodar `limit-p40` com `epsilon ∈ {0.005, 0.01, 0.02}` e as duas `fillPolicy` — se o ranking inverter entre políticas, o resultado não é robusto e não promovemos.

### 6.3 Critério de promoção

A variante LIMIT (ou híbrida) substitui a `btc-champion-v5-practical` se, **nas duas janelas** (train e junho) e na política de fill conservadora:

1. PnL ≥ taker-8-4 + 10%;
2. maxDD não pior que 20% acima do taker-8-4;
3. resultado estável entre `epsilon` 0.01 e 0.02 (variação de PnL < 15%).

---

## 7. Fases de implementação

| Fase | Entrega | Verificação |
|---|---|---|
| **F1** | `orderSimulator`: lots + placeLimitBuy/cancelLimit/checkRestingOrders + settle multi-lote | testes unitários novos (§8.1); suíte existente intacta (313 pass) |
| **F2** | `runtime`: check por tick, early-finalize corrigido, eventRecord estendido; interpreter + compilerSoa + compiler + blocks | regressão V1–V5: PnL byte-idêntico com params default (nenhuma resting order criada) |
| **F3** | `fees.js`: maker isento + contadores | teste unitário com evento misto taker+maker |
| **F4** | GLS TFC: params V6 + lógica hedge | smoke 7d local (`v6-smoke`) |
| **F5** | Experimentos §6 + análise + decisão de preset | relatórios no `reports/labs/tfc/` |

F1–F3 são infra pura e não alteram nenhum resultado existente (resting orders só nascem se a estratégia chamar `placeLimitBuy`).

### 7.1 Testes (F1/F3) — `tests/orderSimulatorMaker.test.js`

1. `placeLimitBuy` valida args e respeita `maxRestingOrders`;
2. fill dispara **só** quando `best_ask <= P - epsilon` (não dispara ao encostar);
3. fill credita lote hedge, `positionView.hedge` correto, primário intacto;
4. settlement par hedgeado: fav perde → `finalPnl = -cost_fav + (shares_hedge - cost_hedge)`; fav vence → `finalPnl = shares_fav - cost_fav - cost_hedge`;
5. `cancelLimit` e expiração no fim do evento (custo zero);
6. early-finalize: evento com posição fechada mas LIMIT aberta continua vivo até o fim;
7. fees: fill maker não paga fee; `makerNotional` reportado;
8. paridade interpreter × compiled-soa no mesmo cenário sintético.

### 7.2 Validação de sanidade contra o cubo (F5)

Antes de confiar nos números: para a variante `limit-p40`, comparar a taxa de fills do simulador com a frequência, no cubo, de eventos V5 em que o ask do lado oposto tocou ≤ $0,39 após a entrada (mesma janela). Divergência > 15% → revisar heurística de fill antes de qualquer conclusão.

---

## 8. Riscos e decisões em aberto

| Risco | Mitigação |
|---|---|
| Heurística de fill otimista demais (fila, gaps) | epsilon + fillPolicy conservadora + sanity check cubo + critério de robustez §6.3 |
| Whipsaws enchem o hedge e o fav vence (seguro caro) | é exatamente o que o sweep de `hedgeLimitPrice` mede; níveis baixos ($0,30) reduzem fills falsos |
| Interação late-flip × hedge duplica proteção (paga duas vezes) | variante híbrida cancela hedge ao sair; hedge preenchido suprime late flip |
| Early-finalize alterado afetar performance do hot loop | checagem `restingOrders.length === 0` é O(1) no caso comum (array vazio) |
| Robô real: prioridade de fila e cancelamento no settlement | fora do escopo do simulador; documentar como requisito do port para `polymarket-robot` (cancel obrigatório a τ≤1s) |

**Fora de escopo (registrado para depois):** limit sell (saída maker), múltiplos hedges escalonados (ladder), re-place após cancel, modelagem de fila por tamanho.

---

## 9. Resultados da validação (2026-07-04)

### 9.1 Conclusão sobre LIMIT passiva abaixo do mercado

A hipótese B original (LIMIT buy no oposto na entrada, ex. $0,40) **não protege flip tardio**:

- Na entrada, o oposto já está ~$0,35–$0,42. LIMIT acima disso era **marketable** (fill instantâneo bugado) ou, com cross-fill correto, **nunca preenchia** no flip real — quando o favorito perde, o ask do oposto **sobe** ($0,70+), não cai através do bid.
- Sweeps `limit-p30`…`limit-p60` com fill conservador: PnL fortemente negativo ou zero fills úteis.

**Mecanismo válido:** `placeBuyStop` — compra quando o ask **sobe através** do gatilho (repricing do flip).

### 9.2 Preset promovido: `btc-champion-v6-hybrid`

Arquivo: `labs/strategies/terminal/tfc/presets/btc-champion-v6-hybrid.json` · Estúdio **v7** · `npm run lab:tfc:v6-hybrid`

Lógica GLS (`TerminalFavoriteCarry.gls`):

1. Mesmo sinal do late flip taker (distância cruzada + confirmação de velocidade se ativa).
2. Na janela 8s→4s, arma **buy-stop** no oposto (`hedgeStopPrice` 0,55, lift 0,10).
3. Se o stop preenche → suprime reverse taker; hedge expira no settlement.
4. Se stop armado mas não preenche antes do piso (4s) → cancela e **fallback taker** (reverse 8→4).
5. `hedgeLimitEnabled` permanece **off** (legado inválido).

### 9.3 Comparativo 59 dias (2026-05-04 → 2026-07-01, BTC 5m depth 25)

| Preset | PnL | Entradas | Win % | PF | Max DD |
|--------|-----|----------|-------|-----|--------|
| `btc-champion-v5-practical` (taker 8→4) | **$4.060** | 3.580 | 74,9 | 1,56 | $81 |
| `btc-champion-v6-hybrid` (stop + fallback) | $3.607 | 3.580 | **75,6** | 1,51 | **$78** |

Junho 2026 isolado:

| Preset | PnL | Win % | Max DD |
|--------|-----|-------|--------|
| v5-practical | **$2.304** | 74,8 | $84 |
| v6-hybrid | $2.190 | **76,0** | **$75** |

### 9.4 Decisão

- **V5 Practical** permanece referência de **PnL máximo** na janela completa (−11% vs hybrid).
- **V6 Hybrid** promovido como preset alternativo: maior win rate, menor drawdown, menor fee drag, mecanismo alinhado ao repricing real (stop) com fallback taker executável — **sem depender de ação nos últimos 2s**.
- Critério §6.3 (LIMIT substituir taker com +10% PnL) **não atingido** para LIMIT pura; híbrido stop+taker é candidato operacional, não supera taker em PnL bruto.

Report 59d: `reports/labs/tfc/2026-07-04T18-02-30-429Z-preset-btc-champion-v6-hybrid` (gitignored, reproduzível via `npm run lab:tfc:v6-hybrid`).
