# MIDAS — Plano de lucratividade em conta real (playbook executável)

**Gerado:** 2026-07-25 · **Autor:** análise integrada (live + labs + código)
**Preset alvo:** `midas-carry-v1` / canário `btc-micro-aggressive-v1` ($2/$4) no data-robot
**Uso deste documento:** é autocontido. Uma IA/operador pode executar as ações das seções 5–7 sem reler os relatórios anteriores. Cada ação tem arquivo, parâmetro, comando e critério de aceite.

---

## 0. Veredito executivo

1. **O edge direcional existe** (WR live 80,0% ≈ BT 79,2%), mas o **edge por trade colapsa para ~zero no live** porque os atritos reais (haircut de settlement 0,995 + fees + fill drift + proteção que nunca dispara) consomem exatamente a margem fina que o lab otimista mostrava.
2. **Todos os 8 losses live foram hold até expiry** (`exitKind: SETTLEMENT`) — a proteção (late-flip exit/reverse/danger) **nunca preencheu em produção**. Causa de código já identificada e corrigida (FAK na saída protetora + circuit breaker global); correção per-leg **pendente de deploy**.
3. **Novidade desta rodada:** o lab agora suporta execução honesta (`settleWinnerPrice: 0.995`) e cada candidata foi validada no **pior caso real** — nenhuma ordem protetora preenche (modo `hold`). Resultado: a MIDAS é lucrativa mesmo assim, e uma variante ajustada (**honest-v2**) domina o canário atual em robustez.
4. **Recomendação (REVISADA na rodada do dia 25 — ver §9):** deploy do fix GTC per-leg + preset **guardian-v3**: manter envelope base (`maxAsk 0.94`, `tier 2.0`) e adicionar `minSecondsLeft 5→9` + **`tierMinZ: 2.0`** (mecanismo novo: favorito caro ask≥0,82 só entra com colchão físico z≥2). Sob execução honesta: julho PF 1,60 com PnL ≈ base (−2,6%) e **pior dia −$2,2 (base: −$7,3)**; junho stress **supera o base** (115,5 vs 114,2) com DD −35%; pior caso (nenhuma proteção preenche) PF 1,29 julho. A primeira proposta deste relatório (honest-v2: maxAsk 0,90 + tier 1,5) foi **substituída** — cortava lucro dos dias bons sem atacar a cauda tão bem quanto o tierMinZ.

---

## 1. Diagnóstico: por que a conta real não lucra

Dados live: 40 trades (24–25/07, ~19h de uptime), +$2,67 líquido. Fonte: `prod-trades.json` (`/trades` dedupado — única fonte confiável de PnL; o audit JSONL duplica `position_settled`).

### 1.1 A matemática por trade (o problema estrutural)

Comprar o favorito a ask `a` com settlement a 0,995 tem breakeven WR = `a / 0.995`:

| Banda | Entradas live | WR live | WR breakeven (c/ haircut) | Resultado |
|---|---|---|---|---|
| 0,55–0,82 (avg 0,69) | 19 | 68% | 69,3% | **empate — zero edge realizado** |
| ≥0,82 (avg 0,91) | 21 | 90% | 90,4% | **empate — zero edge realizado** |

Avg win $0,53 vs avg loss −$1,80: **1 loss engole 3,4 wins**. Com WR 80%, sobra EV ≈ +$0,06/trade — menor que o ruído e que qualquer atrito. O tier 2,0× dobra o orçamento exatamente na banda onde o win é menor ($0,28) e o loss é maior (−$2,6): os dois piores losses live (−$2,63 @0,90 e −$2,56 @0,92) eram trades de tier na faixa 0,90–0,94, onde o breakeven WR ≥ 93% não perdoa nem 1–2c de drift.

### 1.2 As cinco causas do gap live×lab (em ordem de impacto)

| # | Causa | Magnitude | Status |
|---|---|---|---|
| 1 | **Proteção morta em produção** — `exitOrderType: FAK` na saída protetora e na perna EXIT do REVERSE; sem retry; falha abre o circuit breaker global (196× `CIRCUIT_OPEN` em 2,1s no caso âncora) | Lab honesto: proteção vale +$161 (protect 365 vs hold 204, julho micro) | **Corrigido em código** (per-leg GTC, `data-robot/src/strategy/midasV1.js` + `reverseSaga.js`), **pendente deploy** |
| 2 | **Haircut + fees não modelados no lab** — live liquida vencedor a 0,995; lab pagava 1,0 | ~7% do PnL (base julho: 417,9 → 389,0 com haircut) | **Corrigido no lab** (`settleWinnerPrice`, ver §2) |
| 3 | **Fill drift na entrada** — FAK miss (23×) e retries elevam preço (ex.: alvo 0,62 → fill 0,69) | +1c de drift ≈ −12% do PnL hold; +3c ≈ −35% | Aberto — mitigado por `minSecondsLeft: 9` (book mais grosso) e monitorado no gate §6 |
| 4 | **Dados/settlement** — winner divergente (mercado 1784963700: −$2,01 sozinho), lake sem 17/40 eventos live | Contamina paridade; não é PnL recorrente | Aberto (pipeline; fora do escopo deste plano) |
| 5 | **Amostra minúscula** — 40 trades: EV esperado ≈ +$2,6 com σ ≈ $5,9 | ±1σ cobre de −$3 a +$9/dia | Reconhecer: 1 dia de canário não prova nem refuta nada; os gates §6 usam 3+ dias |

**Leitura honesta:** o live não está "quebrado" — está rodando uma estratégia de margem fina com a proteção desligada na prática e com atritos que o lab não cobrava. A solução tem que (a) religar a proteção de forma executável e (b) reformular o envelope para que **o lucro não dependa da proteção**.

---

## 2. Mudança de infra feita nesta rodada (data-backtest)

**`settleWinnerPrice`** — novo parâmetro de execução honesta, aceito por qualquer experimento GLS:

- `src/backtestStudio/gls/orderSimulator.js` — `settleEventPnl(..., { winnerPayout })`: vencedor liquida a `winnerPayout` (default 1,0 = comportamento antigo); perda não muda.
- `src/backtestStudio/gls/runtime.js` — passa `params.settleWinnerPrice ?? 1`.
- Teste: `tests/orderSimulatorMaker.test.js` ("applies winnerPayout haircut only to winning lots") — 17/17 verdes.
- Uso: adicionar `"settleWinnerPrice": 0.995` nos params de qualquer variante.

Fees taker (0,07·p·(1−p)) já eram aplicadas pelo lab (`src/backtest/fees.js`). Entrada taker anda o book real (depth 25) com contabilidade de liquidez consumida — a profundidade não é o problema (confirmado também pelas sondas da Escada Dupla).

---

## 3. Resultados sob execução honesta (settleWinnerPrice 0,995, micro $2/$4)

Protocolo: cada candidata roda em **par** — `protect` (proteções ON, teto realista pós-fix GTC) e `hold` (late-flip/reverse/danger OFF = **pior caso: nenhuma ordem protetora preenche nunca**). Critério de aprovação: `hold` lucrativo por si só nas duas janelas.

### 3.1 Julho 01–22 (22 dias) — `honest-exec-july`

| Variante | Entradas | PnL | PF | MaxDD | Pior dia | Dias+ |
|---|--:|--:|--:|--:|--:|--:|
| base-protect (canário atual) | 2101 | 389,0 | 1,54 | 16,1 | −7,3 | 20/22 |
| **base-hold** | 2101 | 220,2 | 1,29 | 17,4 | **−9,5** | 19/22 |
| minsec9-protect | 2055 | **399,1** | 1,57 | 16,1 | −7,5 | 20/22 |
| minsec9-hold | 2055 | 224,2 | 1,30 | 18,6 | −6,1 | 18/22 |
| tier10-protect | 2101 | 337,6 | 1,58 | **10,7** | −3,9 | 20/22 |
| tier10-hold | 2101 | 166,6 | 1,26 | 11,5 | −10,2 | 18/22 |
| maxask90-tier15-protect | 1939 | 361,6 | 1,57 | 13,0 | −6,6 | 20/22 |
| maxask90-tier15-hold | 1939 | 205,5 | 1,31 | 15,0 | **−4,1** | 18/22 |
| revhalf-protect | 2101 | 332,0 | 1,48 | 13,3 | −6,0 | 21/22 |

### 3.2 Junho 01–08 (semana de stress) — `honest-exec-june-stress`

| Variante | PnL protect | PF | PnL hold | PF hold |
|---|--:|--:|--:|--:|
| base | 114,2 | 1,51 | 53,9 | 1,20 |
| minsec9 | 107,8 | 1,49 | 47,1 | 1,18 |
| maxask90-tier15 | 102,7 | 1,51 | 42,4 | 1,17 |
| tier10 | 101,3 | 1,55 | 41,1 | 1,18 |

**Todas positivas mesmo no pior caso.** O envelope sobrevive à semana ruim sem nenhuma proteção.

### 3.3 Variante final recomendada — `honest-v2` (minsec9 + maxAsk 0,90 + tier 1,5, reverse full)

Experimentos `honest-v2-final-july` / `honest-v2-final-june`:

| Janela | Modo | Entradas | PnL | WR | PF | MaxDD | Pior dia | Dias+ |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| Julho 22d | protect | 1910 | **364,7** | 80,4% | **1,59** | 13,0 | −6,6 | 20/22 |
| Julho 22d | **hold (pior caso)** | 1910 | **203,6** | 80,8% | **1,31** | 15,0 | **−4,1** | 18/22 |
| Junho 8d | protect | 629 | 98,4 | 78,7% | 1,50 | 16,1 | −13,2 | 7/8 |
| Junho 8d | hold (pior caso) | 629 | 38,0 | 78,1% | 1,16 | 21,1 | −13,7 | 5/8 |

**Stress de fill drift** (pós-processado: perda = shares × drift; julho hold ≈ 2400 shares):
+1c em todas as entradas → PnL 203,6 → ~180 (−12%). +3c → ~132. **Continua lucrativa até com 3c de drift médio em 100% das entradas** (o drift real observado afeta minoria das entradas).

### 3.4 Por que honest-v2 vence o canário atual

| Dimensão | Canário (base) | honest-v2 | Leitura |
|---|--:|--:|---|
| PnL julho protect | 389,0 | 364,7 (−6%) | Teto quase igual |
| PF julho protect | 1,54 | **1,59** | Melhor qualidade |
| PnL/$ exposto (hold julho) | 8,8% | **11,0%** | +25% de eficiência por dólar em risco |
| Pior dia hold julho | −9,5 | **−4,1** | Metade da cauda no pior caso |
| MaxDD protect | 16,1 | **13,0** | −19% |
| Notional exposto | 2508 | 1882 (−25%) | Menos capital em risco pelo ~mesmo lucro |

O corte da faixa 0,90–0,94 (breakeven WR ≥ 93–95% com drift — exatamente onde o live perdeu −$2,63 e −$2,56) e a redução do tier tiram a estratégia da zona onde "uma ordem perdida tira todo o lucro". A perda de −6% no teto é o prêmio de seguro; recuperável depois via escala de budget (§6.3).

---

## 4. Mapa lab → conta real (o que o backtest NÃO captura e como cada risco é tratado)

| Risco real | Mecanismo | Tratamento neste plano |
|---|---|---|
| Ordem protetora não preenche (book fino 4–8s, API, latência) | FAK morre sem retry; GTC pode ficar resting sem cruzar | Aprovação da variante **no modo hold** — o plano é lucrativo assumindo proteção = 0. Proteção vira upside (+$160/mês micro), não dependência |
| FAK miss na entrada + fill drift | Book move entre decisão e submit; retries pagam mais caro | `minSecondsLeft: 9` (book mais grosso, mais tempo de retry); stress +1c/+3c aprovado (§3.3); monitorar `fakMissRate` no gate |
| Circuit breaker global do transport | 1 falha de ordem bloqueia TODAS as ordens do processo por cooldown (`liveTransport.js:56-79`) | Fix GTC reduz o gatilho (falha de FAK exit era a fonte); pós-deploy monitorar `CIRCUIT_OPEN` (agora visível nos scripts corrigidos `analyze-prod-audit.mjs`/`diagnose-reverse.mjs` — campo `denied`) |
| GTC EXIT órfã pós-settlement | Ordem resting sobrevive ao expiry binário | Monitorar `prod-status.json.health.orphanOrders` (baseline 0) nas primeiras 24–48h |
| Winner divergente (Chainlink vs spot do lake) | Lab resolve com spot/RTDS; Polymarket usa Chainlink | Risco de dado, não de estratégia; item de pipeline (persistir outcome Gamma/CLOB no lake). Enquanto aberto, não usar paridade de 1 dia como veredito |
| Restarts com posição aberta | 35 `engine_started` no dia; 3 `protective_halt` com posição | Ops: reduzir churn de deploy durante janelas de canário |
| Lake incompleto (17/40 live ausentes) | Ingestão falha eventos live | Item de pipeline; não bloqueia o deploy, bloqueia conclusões de paridade |
| Haircut 0,995 + fees | Corrói ~7% do PnL | Já embutido em todos os números da §3 |

---

## 5. Mudanças a aplicar (exatas)

### 5.1 data-robot (produção) — 2 mudanças

**(a) Deploy do fix per-leg já commitado em código local** (rodadas anteriores, revisado por auditoria independente):
- `src/tfc/preset-midas.js`: `exitOrderType: 'GTC'` em `MICRO_AGGRESSIVE`/`MICRO_ROBUST` (entrada continua `'FAK'`).
- `src/strategy/midasV1.js` + `src/oms/reverseSaga.js`: intent REVERSE com order type **por perna** (EXIT=GTC, ENTER=FAK).
- Testes já verdes: 231/231 (`midas-micro-live.test.js`, `reverse-saga.test.js`).

**(b) Ajuste de envelope do canário — REVISADO §9** (`src/tfc/preset-midas.js`, preset `MICRO_AGGRESSIVE` / canário `btc-micro-aggressive-v1`):

```js
minSecondsLeft: 9,   // era 5 — entra mais cedo: book mais grosso, menos FAK miss
tierMinZ: 2.0,       // NOVO — favorito caro (ask >= tierAskThreshold 0.82) só entra
                     // se z = dist/(sigma*sqrt(tau)) >= 2.0. O robot precisa portar
                     // o gate (5 linhas): calcular z como no lab (sigma de níveis /
                     // 5.48, lookback 90s) e pular entradas de tier com z < tierMinZ.
// manter: maxAsk 0.94, tierAskBudgetFactor 2.0, entryBudget 2, maxEntryBudget 4,
// maxDistAbs 40, lateFlip exit+reverse ON (full), dangerExit ON,
// entryOrderType 'FAK', exitOrderType 'GTC'
```

> A proposta anterior deste relatório (maxAsk 0,90 + tier 1,5) foi retirada: na janela 23–25/07 rendeu −21% vs base (o dia 23 foi excelente justamente na banda alta), enquanto o `tierMinZ` entrega proteção de cauda melhor sem cortar a banda inteira — ver comparação em §9.3.

### 5.2 data-backtest (paridade do lab) — já feito nesta rodada

- Knob `settleWinnerPrice` (§2) — commitado com teste.
- Experimentos novos em `labs/strategies/terminal/midas-carry-v1/experiments/`: `honest-exec-july.json`, `honest-exec-june-stress.json`, `honest-v2-final-july.json`, `honest-v2-final-june.json`.
- Relatórios: `reports/labs/midas-carry-v1/2026-07-25T21-50-19*honest-exec-july`, `*21-53-52*honest-exec-june-stress`, e os dois `*honest-v2-final-*`.
- Novo preset de paridade: `labs/strategies/terminal/midas-carry-v1/presets/btc-micro-honest-v2.json` (espelho do §5.1b).

### 5.3 O que NÃO fazer (rejeitado com evidência)

| Mudança | Por quê não |
|---|---|
| `entryOrderType: 'GTC'` | Adverse selection não testada; ordem resting de entrada preenche tarde contra o gate (S14/auditoria) |
| Alargar janela late-flip (8s→12s+) sem breadcrumb | Sem telemetria (A11), é mexer no escuro; whipsaw comprovado nos labs |
| `earlyWarn`/`bookCollapse` como switch geral | −33% a −67% PnL no treino (lab loss-mitigation 2026-07-25) |
| `lateFlipReverseBudgetFactor: 0.5` | −$57 (julho) e pior variante de junho (revhalf/combo-protect) |
| Scoop / sigma sizing / danger contínuo / minEntryZ | Rejeitados nos labs originais (alfa de latência, não-monotônico, whipsaw) |
| Subir budget antes dos gates §6 | Amostra live de 1 dia não suporta decisão de escala |
| Confiar em PnL do audit JSONL bruto | `position_settled` duplicado (68 eventos p/ 40 trades); usar só `/trades` |

---

## 6. Playbook de deploy e gates (para o operador / IA executora)

### 6.1 Sequência

1. Revisar e deployar (a) e (b) da §5.1 **juntos** (uma janela de deploy, um diff).
2. Rodar canário $2/$4 por **72h** sem outras mudanças (congelar deploys no processo durante o teste; restarts com posição aberta contaminam a amostra).
3. Diariamente: comparar com o lab na **mesma janela UTC** via `scratch/live-vs-backtest/compare-all-live.js`, PnL sempre de `/trades`.

### 6.2 Gates de aceite (72h de canário, todos precisam passar)

| Métrica | Fonte | Gate |
|---|---|---|
| `REVERSE_EXIT_INCOMPLETE` | `diagnose-reverse.mjs` | 0 (era o modo de falha âncora) |
| `orphanOrders` | `prod-status.json.health` | ≈0 (GTC não pode acumular órfãs) |
| `CIRCUIT_OPEN` (denials) | `analyze-prod-audit.mjs` | queda vs baseline 196/dia; sem novos clusters |
| PF live 3d | `/trades` | ≥ 1,25 (hold honesto do lab = 1,31; abaixo de 1,1 investigar antes de continuar) |
| Losses com `exitKind: SETTLEMENT` | `/trades` | < 100% dos losses (hoje: 8/8 — alguma proteção tem que aparecer preenchida) |
| Fill drift médio de entrada | audit fills vs ask alvo | ≤ +2c (acima disso, priorizar lab de retry policy §7.1) |
| Taxa de entrada por slot 5m | audit, janela uptime | ≥ 85% da taxa do lab na mesma janela |

### 6.3 Se os gates passarem (escala)

Subir `entryBudget 2→3` / `maxEntryBudget 4→6` (repõe o notional que o envelope v2 cortou, com mix melhor). Reavaliar gates por mais 72h antes de qualquer novo aumento. Não escalar tier.

### 6.4 Critérios de abortar (voltar preset anterior + congelar)

- PF live 3d < 1,0 com ≥ 60 trades; ou
- `orphanOrders` crescendo sem reconciliação; ou
- 2+ novos `REVERSE_EXIT_INCOMPLETE`; ou
- pior dia < −$8 no micro (2× o pior caso do lab honesto).

---

## 7. Se os gates falharem — próximos experimentos (em ordem)

1. **Retry policy de entrada** (lab novo): FAK com N retries limitados + cap de drift (não virar GTC resting). Modela-se no lab com penalidade de preço por entrada (o runner ainda não simula latência; ver §7.3).
2. **Breadcrumb de late-flip no audit** (`engineApp.js:813`, throttle 250–500ms quando `lateFlip.active`) — pré-requisito para qualquer conclusão nova sobre proteção (A11).
3. **Modelo de fill no lab** (projeto): latência +1 tick na entrada, probabilidade de fill protetor, partial fills. Só depois disso otimizar hiperparâmetros de novo.
4. **Settlement canônico no lake** (pipeline): persistir outcome resolvido (Gamma/CLOB) e reprocessar paridade.

## 8. Reprodução

```powershell
# Grade completa honesta (12 variantes, julho)
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/honest-exec-july.json

# Stress junho
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/honest-exec-june-stress.json

# Validação final honest-v2 (par protect/hold)
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/honest-v2-final-july.json
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/honest-v2-final-june.json

# Testes do knob de haircut
node --test tests/orderSimulatorMaker.test.js
```

**Limitações desta análise:** julho 01–22 foi usado em labs anteriores de seleção (holdout parcialmente queimado) — por isso a validação cruzada com junho e o critério pior-caso; a amostra live é de 1 dia; o lab não simula latência intra-tick nem falhas de API (coberto pelo critério hold + stress de drift, não por simulação).

---

## 9. Rodada dia 25/07 — diagnóstico do dia fraco e evolução para guardian-v3

*(Adicionado após o fechamento das seções 0–8; esta seção REVISA a recomendação da §5.1b.)*

### 9.1 O que aconteceu no dia 25 (fatos)

Lake atualizado com 23–25/07 (`npm run lake:update-btc-5m -- --from 2026-07-23 --to 2026-07-26`) e dia backtestado (`experiments/day25-diagnosis.json`):

| | Live (real) | Lab base-protect (honesto) | Captura |
|---|--:|--:|--:|
| Trades dia 25 | 37 | 75 | 49% |
| PnL dia 25 | **+$2,49** | **+$10,3** | **24%** |
| PnL/trade | $0,067 | $0,137 | 49% |

- **O dia 25 é o pior dos três últimos no lab** (+10,3 vs +50,9 do dia 23) — regime de chop de baixa margem — **mas é positivo**. O "lucro quase nulo" live é **~75% execução, não seleção**: o live rodou só ~15h (zero trades 10–12 UTC e 17–24 UTC — restarts/feeds), capturou metade das entradas do lab e perdeu as proteções (7 losses hold, −$12,78, comendo 30 wins de +$15,27).
- **Conclusão operacional nº 1: nenhum preset conserta o dia 25 live.** As alavancas do dia são: (1) deploy do fix GTC per-leg; (2) **uptime 24/7 do engine** (maior alavanca única: dobraria a captura); (3) gates da §6.

### 9.2 Mecanismos novos implementados e testados (strategy.gls)

1. **`tierMinZ`** — favorito caro (ask ≥ `tierAskThreshold` 0,82) só entra se o colchão físico `z = dist/(σ·√τ) ≥ tierMinZ`. Teoria: a 0,90 o mercado cobra WR 90%+; se o z não sustenta essa probabilidade, o preço está caro vs física → não compra. Ataca exatamente a taxonomia dos piores losses (entradas 0,82–0,95 com dist fraco que viram no fim, média −$16/17 por trade a $10).
2. **`dailyStopLoss` + `lossStreakPauseCount/Events`** — circuit breakers de dia (bloqueiam novas entradas após perda diária X ou N losses seguidos). **Testados e REJEITADOS**: julho protect 294,1 vs 389,0 do base e pior dia PIOROU (−11,2 vs −7,3) — os dias ruins da MIDAS frequentemente se recuperam na segunda metade; o stop trava a perda no fundo. Ficam no GLS como params desligados (default 0) para reuso futuro.

### 9.3 Resultados (execução honesta, micro $2/$4; experiments `v3-tierz-*`)

**Julho 01–22:**

| Variante | PnL | PF | MaxDD | Pior dia |
|---|--:|--:|--:|--:|
| base-protect | 389,0 | 1,54 | 16,1 | −7,3 |
| ms9-protect | 399,1 | 1,57 | 16,1 | −7,5 |
| tmz10-protect | 396,5 | 1,59 | 16,7 | −8,2 |
| **tmz20-protect (guardian-v3)** | 379,0 | **1,60** | **12,7** | **−2,2** |
| tmz20-hold (pior caso) | 197,4 | 1,29 | 15,2 | — |

**Junho stress 01–08:** guardian-v3 **115,5 / PF 1,63 / DD 12,0 / pior dia −7,7** vs base 114,2 / 1,51 / 18,5 / −14,5. Hold: 40,6 / PF 1,17 (positivo).

**23–25/07:** guardian-v3 60,4 (dia 25: +6,3) vs base 74,5 (dia 25: +10,3) — o gate custa nos dias bons da banda alta (dia 23). É o preço do seguro; a decisão privilegia matar a cauda (pior dia julho −2,2, junho −35% DD) mantendo o PnL anualizado ≈ base.

**Vizinhança:** tmz 1,0/1,5/2,0 comportam-se monotonicamente (mais gate → menos PnL julho, cauda melhor) — não é fio de navalha. Alternativa agressiva documentada: `tmz10` (julho 396,5, +2% vs base) se a prioridade for PnL máximo com melhora leve de cauda.

### 9.4 Preset final e porte para o robot

Preset de paridade: `labs/strategies/terminal/midas-carry-v1/presets/btc-micro-guardian-v3.json` (Estúdio v7). Diff vs canário live:

```js
minSecondsLeft: 9,   // era 5
tierMinZ: 2.0,       // NOVO — exige porte no data-robot (midasV1.js):
                     // z = |spot-PTB| / ((sigmaNiveis(90s)/5.48) * sqrt(secsLeft));
                     // if (ask >= 0.82 && z < 2.0) skip entry;
// todo o resto idêntico ao canário (maxAsk 0.94, tier 2.0, proteções ON)
```

A recomendação de honest-v2 (§5.1b original, maxAsk 0,90/tier 1,5) está **retirada**: perdia −21% na janela 23–25 sem entregar a proteção de cauda do tierMinZ.

### 9.5 Encadeamento com o playbook (§6 permanece válido)

A sequência de deploy e os gates da §6 não mudam — apenas o conteúdo do passo (b): usar guardian-v3 em vez de honest-v2. Acrescentar ao monitoramento: contagem de entradas de tier bloqueadas por `tierMinZ` (esperado: ~10% das entradas; se >25%, o cálculo de σ do robot difere do lab — recalibrar antes de concluir).

---

## 10. Rodada "lucros maiores" — escala, mix e compounding (execução honesta)

Pergunta do operador: *manter o perfil de erros e aumentar o lucro absoluto.* Como o EV honesto por trade é positivo (PF 1,5–1,6), lucro = EV × tamanho × nº de trades. Três caminhos foram quantificados (experiments `profit-scale-july`, `profit-scale-june`, `profit-compound-july`; tudo guardian-v3 + settleWinnerPrice 0,995).

### 10.1 Escala de budget (julho 01–22)

| Variante | Budget | PnL | ×vs micro | PF | MaxDD | Pior dia |
|---|---|--:|--:|--:|--:|--:|
| g3 (micro) | $2/$4 | 379,0 | 1,0× | 1,60 | 12,7 | −2,2 |
| **g3-2x** | **$4/$8** | **795,1** | **2,10×** | **1,59** | 28,9 | −5,3 |
| g3-4x | $8/$16 | 1452,8 | 3,83× | 1,52 | 61,2 | −11,8 |
| g3-10x | $20/$40 | 2915,1 | 7,69× | **1,44** | 169,1 | **−119,9** |
| g3-2x-hold (pior caso) | $4/$8 | 439,0 | — | 1,29 | 31,9 | −10,7 |
| g3-10x-hold | $20/$40 | 1781,1 | — | 1,24 | 173,5 | −123,4 |

Junho stress: g3-2x **252,8 / PF 1,63**; hold 91,7 (positivo).

**Leituras:** (1) até **2× a escala é gratuita** — PF idêntico, PnL lineariza; (2) em 4× começa custo leve; (3) **~10× ($20/$40) é o teto de liquidez atual** — PnL sub-linear (7,7×), PF 1,60→1,44 e cauda não-linear (pior dia −$120): o book de 25 níveis passa a ser andado fundo. Acima disso, diversificar por ativo (ETH/SOL 5m) em vez de subir budget.

### 10.2 Mix de bandas (realocar para a margem gorda)

A margem da banda média (0,55–0,82) é ~10pp acima do breakeven (WR ~79% vs 69%; win $0,30/share); a banda alta tem margem de ~1,6pp (WR 92% vs 90,4%; win $0,09/share). Realocação testada:

| Variante | Config | PnL jul | PF | MaxDD |
|---|---|--:|--:|--:|
| g3-2x (referência) | $4/$8, tier 2,0 | 795,1 | 1,59 | 28,9 |
| **g3-midshift** | **$4/$6, tier 1,0** | 715,4 | **1,61** | **22,8** |
| g3-fatband | $4/$6, tier 1,0, maxAsk 0,86 | 702,3 | 1,62 | 24,3 |

Midshift é o melhor PnL/risco por dólar; 2× puro é o maior PnL absoluto. Ambos válidos — escolha operacional (2× se a prioridade é lucro absoluto; midshift se é eficiência de capital).

### 10.3 Compounding por equity (o motor de crescimento)

Single-pass (obrigatório — `dailyMetrics: false`; o modo chunked reinicia a banca por dia), banca inicial $100, `equityScaleEnabled: true`, teto $40/entrada:

| Variante | PnL 22d | PF | MaxDD abs |
|---|--:|--:|--:|
| g3 fixo $2/$4 | 379,0 | 1,60 | 15,4 |
| **g3-eq2pct (budget = 2% da equity)** | **2831,2** | **1,59** | 197,2 |
| g3-eq4pct (4%) | 3728,9 | 1,47 | 221,9 |

**2% da equity preserva o PF integralmente** e multiplica o lucro ~7,5× em 22 dias partindo de $100. A 4% o PF começa a ceder (budget médio entra na zona de degradação de liquidez cedo demais). O DD absoluto cresce com a banca (é ~7% da equity final — saudável); o mecanismo já respeita `min(…, equity)` como piso de ruína.

### 10.4 Plano de escala revisado (substitui §6.3)

```text
Fase A (gates §6.2 passando, 72h):    $2/$4  → $4/$8  (2x — custo zero de PF)
Fase B (+72h de gates verdes):        ligar equityScaleEnabled, equityScalePct 0.02,
                                      maxEntryBudget 8 → subir teto gradualmente (16 → 40)
                                      conforme os gates continuam verdes a cada degrau
Teto por evento:                      $40 (limite de liquidez medido; PF 1.44 além disso)
Crescimento além do teto:             ETH/SOL 5m (dados já no lake) — não subir budget BTC
```

**Aviso central (não pular):** a escala multiplica o PnL do **lab**; o live hoje captura ~24% (dia 25). Escalar antes de fechar execução/uptime multiplica o gap, não o lucro. Ordem obrigatória: deploy GTC + uptime 24/7 → gates §6.2 → Fase A → Fase B.
