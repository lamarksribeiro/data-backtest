# Rodada 2 — revisão dos relatórios de auditoria e correções aplicadas

**Data:** 2026-07-25
**Insumos desta rodada:** `LAB-FAK-EXIT-GTC.md`, `RELATORIO-AUDITORIA-CONCLUSOES-LIVE-VS-BT.md`, `RELATORIO-REVISAO-INDEPENDENTE-DATA-ROBOT-VS-DATA-BACKTEST.md` (três documentos gerados depois do meu relatório complementar, revisando-o de forma independente).
**Método:** verifiquei cada crítica relevante lendo o código apontado (não confiei nas afirmações dos relatórios sem checar), decidi o que corrigir e o que ficar para depois, e rodei testes (novos e existentes) para cada mudança.
**Resultado:** 3 correções de código aplicadas (uma delas corrige um defeito real no meu próprio patch anterior), 2 scripts de diagnóstico corrigidos, 2 testes novos escritos. `data-robot`: 231/231 testes. `data-backtest`: 406/406 relevantes (3 falhas pré-existentes, não relacionadas, confirmadas por escopo do diff).

---

## 1. A crítica mais séria: meu patch FAK→GTC tinha um bug

A `RELATORIO-REVISAO-INDEPENDENTE...md` (seção 11) apontou algo que eu não tinha visto: `reverseSaga.js` reutilizava a **mesma variável** `orderType` para as duas pernas da saga REVERSE — a perna `EXIT` (vender o lado perdedor) e a perna `ENTER` (comprar o lado novo):

```js
// reverseSaga.js — ANTES
const orderType = intent.orderType ?? 'FAK';
const exitIntent = { ..., orderType, ... };   // linha 74
const enterIntent = { ..., orderType, ... };  // linha 126
```

E `intent.orderType`, no `REVERSE` construído por `midasV1.js:475`, vinha de `params.exitOrderType ?? params.entryOrderType`. Quando troquei `exitOrderType` de `FAK` para `GTC` na rodada anterior, **as duas pernas da reversão passaram a usar GTC** — não só a saída protetora (que era a intenção), mas também a compra do lado novo, que antes era `FAK` (mesma política agressiva da entrada normal).

Isso é um problema real: uma compra GTC pode ficar pendurada no book sem preencher, e nesse meio-tempo o gate original que justificou a reversão pode não valer mais, ou o mercado pode chegar perto demais do expiry para essa nova posição ter qualquer proteção. Eu tinha essa informação na minha frente (li o código completo de `reverseSaga.js` na rodada 1, inclusive citei a linha 126 em nota de risco no relatório complementar), mas não conectei os pontos — a auditoria independente conectou. Aceito a crítica integralmente.

### Correção aplicada

`data-robot/src/strategy/midasV1.js:475` — o intent `REVERSE` agora carrega dois campos de order type, um por perna:

```js
orderType: params.entryOrderType ?? 'GTC',                         // perna ENTER
exitOrderType: params.exitOrderType ?? params.entryOrderType ?? 'GTC',  // perna EXIT
```

`data-robot/src/oms/reverseSaga.js:60-76,126` — cada perna agora lê o campo correto:

```js
const enterOrderType = intent.orderType ?? 'FAK';
const exitOrderType = intent.exitOrderType ?? enterOrderType;
// exitIntent.orderType = exitOrderType
// enterIntent.orderType = enterOrderType
```

Resultado no preset live (`MICRO_AGGRESSIVE`: `entryOrderType: 'FAK'`, `exitOrderType: 'GTC'`): a perna `EXIT` da reversão (protetora) usa `GTC` — a mudança pretendida na rodada 1 — e a perna `ENTER` da reversão (comprar o lado novo) volta a usar `FAK`, igual à entrada normal, igual ao comportamento anterior à minha mudança. Nada mais no fluxo de entrada foi tocado.

### Teste novo

Não havia nenhum teste que checasse o `orderType` de cada perna da saga (`test/reverse-saga.test.js` só checava que as duas pernas existiam e que a posição virava). Adicionei ao teste existente:

```js
assert.equal(exitLeg.orderType, canaryMidasPreset().exitOrderType);   // 'GTC'
assert.equal(enterLeg.orderType, canaryMidasPreset().entryOrderType); // 'FAK'
assert.notEqual(exitLeg.orderType, enterLeg.orderType);
```

Isso fecha o buraco de cobertura que permitiu o bug passar despercebido da primeira vez — se alguém voltar a unificar as duas pernas no futuro, o teste quebra.

---

## 2. Settlement do backtest: `>` deveria ser `>=`

A revisão independente encontrou, em `data-backtest/src/backtestStudio/gls/orderSimulator.js:526`:

```js
const winnerSide = underlying > ptb ? 'UP' : 'DOWN';
```

A regra documentada do mercado Polymarket BTC Up/Down é: **UP se o preço final for maior ou igual ao inicial** (empate resolve UP). O código usava `>` estrito, então um empate exato resolveria (incorretamente) `DOWN` no backtest.

**Verifiquei e corrigi:**

```js
const winnerSide = underlying >= ptb ? 'UP' : 'DOWN';
```

Adicionei teste (`tests/orderSimulatorMaker.test.js`) cobrindo o caso de empate exato — não existia antes. 28/28 testes do arquivo passam.

### O que essa correção NÃO resolve

A revisão aponta um segundo problema, mais estrutural: o `underlying` usado aqui é o último tick de spot/RTDS do lake, não o preço oficial da Chainlink que a Polymarket realmente usa para resolver o mercado. Isso é a causa real apontada para o caso âncora `1784963700` (winner live `Up`, BT `Down` — não é um empate, é fonte de dado diferente). Corrigir isso exigiria o lake passar a persistir o outcome canônico resolvido (Gamma/CLOB), que não temos hoje. **Não fiz essa mudança** — é trabalho de pipeline de dados, não uma correção de linha de código, e nenhum dos três relatórios revisados discorda disso. Fica como próximo passo (ver §5).

---

## 3. Scripts de diagnóstico liam o campo errado (`rejected` em vez de `denied`)

Confirmei a crítica direto nos dados: em `prod-audit-2026-07-25.jsonl`, das 270 linhas `type:'decision'`, **200 têm um array `denied` não vazio** — e nenhuma tem `rejected` (esse campo não existe no schema do engine). `analyze-prod-audit.mjs` e `diagnose-reverse.mjs` procuravam `o.rejected`, então essas 200 recusas eram invisíveis em toda análise anterior, incluindo a minha.

**Corrigido** (`o.rejected` → `o.denied` nos dois scripts) e re-rodei os dois contra os JSONL brutos. Resultado, antes escondido:

```json
"rejectReasonTop": [["CIRCUIT_OPEN", 196], ["MAX_NOTIONAL_EVENT", 4]]
```

Isso muda a leitura do caso `REVERSE_EXIT_INCOMPLETE` em `btc-updown-5m-1784953500`: depois da primeira falha da perna EXIT, a estratégia tentou reemitir o REVERSE **repetidamente** (201 sinais em ~2,1s — cadência hot de 50ms) e foi bloqueada 196 vezes por `CIRCUIT_OPEN` e 4 vezes por `MAX_NOTIONAL_EVENT`. Ou seja: não foi "tentou uma vez e desistiu" — foi "tentou, falhou, e o circuit breaker global do transport (`liveTransport.js:56-79`, compartilhado entre todas as ordens do processo, não por mercado) abriu e bloqueou toda tentativa de recuperação pelo resto da janela". Isso é consistente com a hipótese: a própria falha da perna FAK-exit é o gatilho mais provável do circuit breaker, então a correção GTC da saída (§1) tende a reduzir a frequência com que esse breaker abre — mas não elimina o risco de um GTC "falho" (erro de API, tamanho inválido) também contar como falha e reabrir o circuito para *outros* mercados na mesma janela de cooldown, já que o breaker é global ao processo.

Não fiz mudança de comportamento no circuit breaker nesta rodada — só corrigi a visibilidade do dado. Ficou mais claro que qualquer trabalho futuro de retry na saga (S2b nos relatórios anteriores) precisa considerar que o circuit breaker é compartilhado entre mercados, não local à saga.

---

## 4. O que os relatórios de auditoria confirmaram sobre a rodada 1 (aceito sem mudança)

| Da rodada 1 | Veredito da auditoria | Minha posição |
|---|---|---|
| WR live 80% ≈ BT 79,2% → edge direcional real | Aceito, com ressalva estatística (intervalos de Wilson se sobrepõem; não é *prova* de edge, mas não é refutado) | Concordo — não superinterpretar WR curto como confirmação estatística |
| A1 (8/8 losses sem late-flip) estava subprovado | Aceito integralmente pelos dois auditores independentes | Mantenho a posição da rodada 1: precisa de heartbeat/breadcrumb antes de qualquer conclusão nova sobre late-flip |
| FAK não tem retry na saga → `REVERSE_EXIT_INCOMPLETE` | Mecanismo aceito como correto | Mantenho |
| "FAK é atômico, tudo ou nada" | **Incorreto** — FAK preenche parcialmente e cancela só o residual; quem é tudo-ou-nada é FOK | Aceito a correção terminológica. Não muda a conclusão prática (a saga ainda trata qualquer resultado ≠ fill completo como falha total, sem tentar liquidar o residual — ver §5), mas meu relatório anterior descreveu o mecanismo errado |
| `ignoreConsumed:true` faz o BT "sempre encher" | **Impreciso** — o parâmetro só evita descontar liquidez duas vezes num fluxo interno de planejar/validar/commitar; o simulador ainda pode dar fill parcial/zero por budget, `maxPrice` ou liquidez mínima | Aceito a correção. A conclusão geral (BT é otimista sobre execução, não modela latência/API/circuit breaker/parcial-assíncrono) continua válida, só a explicação técnica específica estava errada |
| "40 vs 125 entradas" = gap de cobertura de ~68% | **Metodologicamente inválido** — janelas diferentes (live ~18,7h, BT 48h); normalizado por slot, live está ~18% abaixo do BT, não ~68% | Aceito. Não vou mais citar "40 vs 125" como métrica de cobertura sem normalizar por janela |
| "35 restarts explicam a cobertura baixa" | **Superestimado** — 35 é `engine_started` (churn de processo/deploy), só 3 são `protective_halt` com posição aberta | Aceito |
| Lab FAK-exit→GTC "valida a correção" | **Parcial** — o lab ablaciona o *resultado* da proteção (liga/desliga mecanismos), não simula FAK/GTC do CLOB real; mede o teto do ganho se a proteção voltar a funcionar, não prova que GTC especificamente entrega esse resultado | Aceito. Não vou comunicar "+69% pós-GTC" como previsão — é o teto teórico do valor da proteção, não uma previsão do patch |
| Journal (`prod-audit-summary.json`) tem `position_settled` duplicado | Confirmado (69 eventos para 40 trades reais) | Mantenho a recomendação da rodada 1: usar sempre `/trades` (`prod-trades.json`) como fonte de verdade de PnL, nunca o audit bruto agregado |
| `entryPrice` do trade journal é o preço-limite solicitado, não o fill médio | Novo achado, verifiquei a lógica em `tradeJournal.js` (prioriza `order.price` sobre `avgPrice`) — não recontei os fills um a um, mas a leitura do código bate com a crítica | Aceito como hipótese forte; não requalifiquei os números de "fill drift" da rodada 1 (ex. `1784965200`) à luz disso — ficam como suspeitos, não confirmados, até alguém comparar contra o preço médio de fill real |

---

## 5. O que fica para depois (não fiz agora — motivo em cada linha)

| Item | Por que não fiz agora |
|---|---|
| Settlement canônico (Chainlink) no lake | Requer nova ingestão de dados (Gamma/CLOB resolved outcome), não é mudança de código local |
| Retry residual real na saga REVERSE (reconciliar por quantidade, não por "tudo ou nada") | Mudança de design maior (máquina de estados por quantidade, proposta na revisão independente §17.3) — meu escopo desta rodada foi corrigir o que já estava no código, não redesenhar a saga. Recomendo priorizar em seguida |
| Heartbeat/breadcrumb de `lateFlip` no audit (mesmo sem intent) | Já recomendado na rodada 1 como S3/P0; continua pendente. Sem isso, A1 não pode ser fechado |
| Deduplicar `position_settled` no journal | Identificado, não corrigido — precisa de uma chave idempotente (`marketId`+`intentId` ou similar) que não investiguei a fundo ainda |
| Separar `entryPrice`/`avgFillPrice`/`worstFillPrice` no trade journal | Identificado, não corrigido — mudança de schema do journal, maior superfície de risco para fazer sem mais tempo de revisão |
| Modelar FAK-miss/partial no lab (não só ablação liga/desliga) | Concordo que é necessário para o lab deixar de ser otimista sobre execução, mas é um projeto de simulação, não uma correção pontual |

---

## 6. Estado atual do código (resumo para quem for revisar o diff)

**`data-robot`:**
- `src/tfc/preset-midas.js` — `exitOrderType: 'FAK' → 'GTC'` em `MICRO_AGGRESSIVE`/`MICRO_ROBUST` (rodada 1, mantido).
- `src/strategy/midasV1.js` — intent `REVERSE` agora emite `orderType` (perna enter) e `exitOrderType` (perna exit) separados (rodada 2, novo).
- `src/oms/reverseSaga.js` — cada perna da saga usa seu próprio order type; nunca mais compartilham uma variável (rodada 2, novo).
- `test/midas-micro-live.test.js` — assert atualizado para `'GTC'` na saída (rodada 1).
- `test/reverse-saga.test.js` — novo assert que trava order type por perna (rodada 2, novo).
- 231/231 testes passam.

**`data-backtest`:**
- `src/backtestStudio/gls/orderSimulator.js` — `settleEventPnl`: `>` → `>=` no cálculo de `winnerSide`, com comentário explicando a limitação de fonte (spot/RTDS vs Chainlink) que ainda não foi resolvida (rodada 2, novo).
- `tests/orderSimulatorMaker.test.js` — novo teste de empate exato (rodada 2, novo).
- `scratch/live-vs-backtest/analyze-prod-audit.mjs`, `diagnose-reverse.mjs` — `o.rejected` → `o.denied` (rodada 2, novo); reexecutados, `prod-audit-summary.json` e `prod-reverse-diagnosis.json` atualizados com os 200 denials antes invisíveis.
- 403/406 testes relevantes passam (3 falhas em `labPresets.test.js`/`strategyPortCatalog.test.js` são pré-existentes, sobre catálogo de outras estratégias, fora do escopo do diff — confirmado por `git status`).

**Nada foi deployado.** Só código e testes locais, como nas rodadas anteriores.

---

## 7. Recomendação de sequência (ajustada com as três rodadas de revisão)

1. Rodar os testes novos (`reverse-saga.test.js`, `orderSimulatorMaker.test.js`) numa revisão de PR antes de qualquer deploy.
2. Deploy do patch GTC **corrigido** (per-leg, não mais compartilhado) — o formato anterior tinha o risco real que a revisão independente apontou; o formato atual não tem esse risco específico.
3. Monitorar 24-48h: `REVERSE_EXIT_INCOMPLETE`, `CIRCUIT_OPEN` (agora visível), `orphanOrders`, taxa de reverse completo.
4. Em paralelo: heartbeat de late-flip (S3) + settlement canônico (fora de escopo de código, precisa de pipeline).
5. Só depois: retry residual real na saga, dedupe do journal, funil de cobertura (`entry_retry_gated`).

**Arquivos desta rodada:** este relatório; diffs listados em §6.
