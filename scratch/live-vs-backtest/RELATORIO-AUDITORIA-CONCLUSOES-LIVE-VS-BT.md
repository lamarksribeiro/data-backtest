# Relatório de auditoria — conclusões live (data-robot) × backtest (data-backtest)

**Auditor:** análise independente sobre os relatórios e artefatos existentes  
**Data da auditoria:** 2026-07-25  
**Preset auditado:** `midas-carry-v1` / `btc-micro-aggressive-v1` ($2 / $4)  
**Período dos dados live:** ~2026-07-24 22:15 UTC → 2026-07-25 16:55 UTC  
**Período do backtest de referência:** 2026-07-24 00:00 UTC → 2026-07-26 00:00 UTC  

**Documentos auditados:**

| Documento | Papel |
|-----------|--------|
| `RELATORIO-MIDAS-LIVE-VS-BT.md` | Relatório principal de paridade e catálogo A1–A11 |
| `RELATORIO-COMPLEMENTAR-CORRECAO-FAK-EXIT.md` | Causa raiz A2 + patch FAK→GTC + A11 |
| `LAB-FAK-EXIT-GTC.md` | Ablação lab proxy proteção vs hold |

**Artefatos de dados cruzados:**

- `full-parity-slim.json` / `full-parity-report.json`
- `prod-trades.json`, `prod-status.json`
- `prod-audit-summary.json`, `prod-audit-2026-07-24.jsonl`, `prod-audit-2026-07-25.jsonl`
- `prod-reverse-diagnosis.json`, `prod-loss-lateflip.json`
- `bt-summary-2026-07-24-25.md`, `bt-results-2026-07-24-25.json`
- `labs/.../experiments/fak-exit-gtc-*.json`

---

## 1. Sumário executivo

### Veredito

1. **O edge direcional parece real.** Win rate live **80,0%** vs BT **79,2%** — a seleção de trades não está “morta”.
2. **O gap de PnL bruta (+$2,67 live vs +$24,22 BT) é em grande parte comparação de janelas diferentes**, não prova de que o live captura só ~11% do edge do lab.
3. **Nos mercados comparáveis (mesmo lado, presentes no lake), o gap de qualidade é real:** live **+$0,62** vs BT **+$4,01** em 22 trades (Δ **−$3,39**).
4. **A causa de código A2 (`exitOrderType: FAK` na saída protetora / perna EXIT do REVERSE) está correta** e o patch GTC é justificado como *hardening* de execução.
5. **O lab FAK→GTC valida o valor da proteção, não o fill GTC real.** Tratar +69% de PnL no holdout como forecast pós-deploy é incorreto.
6. **A1 (“8/8 losses sem late-flip”) está corretamente rebaixado a subprovado (A11):** o audit omite ticks quietos; não dá para concluir “nunca cruzou”.
7. **Antes de subir budget:** deploy GTC com monitor de órfãs, breadcrumb de late-flip, forense do winner divergente, funil de cobertura (incl. `entry_retry_gated`), harness diário na **mesma janela**.

### Nota geral dos relatórios

| Dimensão | Nota | Comentário |
|----------|------|------------|
| Rigor metodológico | **A−** | Bom catálogo, revisão A1→A11 honesta |
| Diagnóstico de código (A2) | **A** | Mecanismo FAK + saga sem retry bem amarrado |
| Atribuição de PnL / cobertura | **C+** | 40 vs 125 sem normalizar uptime distorce a narrativa |
| Lab como prova do patch GTC | **B−** | Proxy de “proteção off” ≠ FAK/GTC CLOB |
| Priorização de próximos passos | **A−** | S0→S3→S1 faz sentido; falta A3 e funil de entry no P0 |

---

## 2. Escopo e método desta auditoria

### O que foi feito

1. Leitura integral dos três relatórios comparativos.
2. Releitura dos JSON de paridade, audit, reverse e trades.
3. Recálculo independente de:
   - classes de paridade e totais;
   - PnL same-side e decomposição por causa;
   - taxa de entrada normalizada por slot 5m / uptime;
   - contadores de restart vs protective halt vs FAK miss;
   - casos deep-dive (reverse incompleto, exit path, winner, fill drift).
4. Avaliação da validade do experimento lab `fak-exit-gtc-*`.
5. Consolidação: o que aceitar, o que corrigir, caminho operacional.

### O que *não* foi feito nesta rodada

- Deploy ou mudança de código.
- Replay tick-a-tick dos 8 losses a partir do Postgres/lake.
- Forense completa do settlement do market `1784963700` (winner live ≠ lake).
- Confirmação em runtime do cancel de GTC residual pós-expiry no `data-robot`.

---

## 3. Números de referência (revalidados)

### 3.1 Agregados live × BT

| Métrica | Live (`/trades`) | Backtest full window |
|---------|------------------:|---------------------:|
| Entradas | 40 | 125 |
| Wins / Losses | 32 / 8 | 99 / 26 |
| Win rate | 80,0% | 79,2% |
| PnL líquido reportado | **+$2,67** | **+$24,22** (c/ fees no lab) |
| Profit factor | 1,19 | 1,68 |
| Avg win | ~$0,53 | ~$0,60 |
| Avg loss | **−$1,80** | ~**−$1,37** |

Fontes: `prod-trades.json` summary; `bt-summary-2026-07-24-25.md`; `full-parity-slim.json`.

### 3.2 Classes de paridade (40 markets live)

| Classe | N | Significado |
|--------|--:|------------|
| `near_parity` | 13 | mesmo lado, \|ΔPnL\| < $0,15 |
| `pnl_gap` | 7 | mesmo lado, PnL diverge |
| `exit_path_diff` | 2 | BT reverteu; live hold |
| `bt_no_entry` | 1 | live entrou; BT não |
| `bt_missing` | 17 | evento fora do lake / sem callback |

Totais slim:

- `livePnl` (40): **+$2,6656**
- `btPnlOnLiveMarkets` (22 entrados no BT): **+$4,0102**
- Same-side (22): live **+$0,621** vs BT **+$4,010** → Δ **−$3,390**
- Presentes no lake (23, incl. 1 `bt_no_entry`): live **+$1,026** vs BT **+$4,010**

> Nota: o relatório principal cita “+$1,03 live vs +$4,01 BT nos 23 eventos presentes” — **confirmado**.  
> A frase “same-side” em alguns trechos pode confundir com o total live; o gap de qualidade comparável é o das **22** com entry nos dois lados.

### 3.3 Janela e taxa de entrada (correção central)

| | Live | BT |
|--|-----:|---:|
| Início efetivo | 2026-07-24 **22:15** UTC | 2026-07-24 **00:00** UTC |
| Fim efetivo | 2026-07-25 **16:55** UTC | 2026-07-26 **00:00** UTC |
| Duração | ~**18,7 h** | **48 h** |
| Slots 5m | ~**225** | **576** |
| Entradas | 40 | 125 |
| **Taxa de entrada** | **17,8%** | **21,7%** |
| BT pro-rata na janela live | — | ~**48,8** entradas esperadas |

**Conclusão:** o “40 vs 125” **não** é gap de cobertura de ~68%.  
Normalizado por uptime, live está ~**18% abaixo** da taxa do BT (40 vs ~49), não a 32% da contagem bruta.

### 3.4 Contadores de execução (audit)

| Contador | Valor | Interpretação |
|----------|------:|---------------|
| `engine_started` | 35 | restarts do processo |
| `protective_halt` (`market-rotated-with-position`) | **3** | rotação com posição aberta |
| `fakMisses` (sample ENTER) | 23 | FAK de entrada morta |
| `entry_retry_gated` | **983** | tentativas/gates de retry de entrada |
| `reversesAccepted` / markets | 2 / 2 | só dois mercados com reverse aceito |
| `lateFlipSignals` (actions REVERSE) | 202 | quase todos no market incompleto |
| `position_settled` | 68 | **> 40 trades** → duplicação |
| Settlement prices (wins/loss proxy) | 0.995×47, 0.005×12, 1×7, 0×2 | haircut vs binário 0/1 |
| `orphanOrders` (snapshot status) | 0 | baseline pré-GTC |
| Availability health | ~0,954 | abaixo do SLO 0,995 |

**Correção ao A4 dos relatórios:** “restarts×35” **não** equivale a “35 vezes com posição aberta”. Só **3** protective halts capturam esse caso. Os 35 `engine_started` medem churn do processo.

---

## 4. Avaliação achado a achado

### A1 — Late-flip / losses sem sinal

| Item | Avaliação |
|------|-----------|
| Afirmação original | 8/8 losses sem late-flip; proteção não acionou |
| Status nos relatórios | **Subprovado (A11)** |
| Auditoria | **Concordo com a revisão** |

**Por quê:** `shouldAuditDecision` só grava decision com accept / stateChange / deny de proteção ou entry policy. Ticks “quietos” na janela hot (50 ms) **não deixam rastro**. Scripts que usam `tickCount30s` a partir de `type:decision` medem **ausência de eventos notáveis**, não ausência de avaliação.

Motivos possíveis para loss sem reverse (indistinguíveis hoje):

1. Preço nunca cruzou o floor de late-flip.  
2. Cruzou fora da janela 4–8 s.  
3. Cruzou na janela mas bid < `stopMinBid` / gates falharam.  
4. Processo não avaliou (restart, feed, halt).  

**Ação:** breadcrumb quando `lateFlip.active` (throttle 250–500 ms) **antes** de mais replay (S1).

---

### A2 — FAK na saída → REVERSE incompleto

| Item | Avaliação |
|------|-----------|
| Causa de código | **Correta** |
| Impacto de PnL no sample | **Superestimado se tratado como “sempre perde”** |
| Patch `exitOrderType: GTC` | **Justificado como hardening** |
| “Resolve o gap live×BT” | **Não** |

**Evidência de mecanismo (aceita):**

- Presets `MICRO_AGGRESSIVE` / `MICRO_ROBUST` com `exitOrderType: 'FAK'`.  
- `exitOrderType` alimenta danger / early-warn / late-flip-exit **e** perna EXIT da saga REVERSE.  
- FAK: fill total ou kill; sem retry na saga → `REVERSE_EXIT_INCOMPLETE`.  
- Lab: `ignoreConsumed: true` no reverse → fill sempre no preço cotado.

**Evidência live:**

| Market | Reverse | Terminal | PnL live | PnL BT (se houver) |
|--------|---------|----------|----------:|-------------------:|
| `1784953500` | aceito | **`REVERSE_EXIT_INCOMPLETE`** | **+$0,63** | **−$1,52** (reverse_exit) |
| `1784972100` | aceito | complete (EXIT FAK @0,05 + ENTER @0,97) | **+$0,05** | missing lake |

No caso âncora do bug, o incomplete **deixou a posição no lado vencedor**. O reverse “bem-sucedido” do BT teria virado loss.  
Conclusão: o bug de path é real; o **sinal de PnL deste sample é ambíguo**.

**Exit path com Δ negativo claro (proteção que faltou no live):**

| Market | Live | BT | Δ |
|--------|-----:|---:|--:|
| `1784933100` | hold −1,59 | reverse −0,89 | **−0,70** |
| `1784951400` | hold −1,61 | reverse −0,34 | **−1,27** |
| **Soma** | | | **≈ −1,97** |

Nesses dois, o live **não** tem `REVERSE_EXIT_INCOMPLETE` no diagnosis — o reverse **nem chegou a ser o path dominante no audit de losses**. Podem ser: flip não elegível no live, timing, ou telemetria incompleta (A11). Não atribuir os dois automaticamente a FAK-exit.

**Riscos do patch GTC (relatório complementar — aceitos):**

- Ordem residual no book se não houver contraparte.  
- Precisa cancel/reconcile no expiry/settlement (`orphanOrders`).  
- Não adiciona reprice ativo; GTC passivo ≠ fill garantido.  
- Não corrige FAK na **entrada**.

---

### A3 — Winner live ≠ lake (`1784963700`)

| Item | Avaliação |
|------|-----------|
| Severidade nos relatórios | P0 |
| Auditoria | **P0 confirmado; maior item único do Δ same-side** |

| | Live | BT/lake |
|--|------|---------|
| Side | DOWN @0,69 | DOWN @0,67 |
| Winner | **Up** | **Down** |
| PnL | **−1,35** | **+0,66** |
| Δ | | **−2,01** |

Sem este market, o gap same-side cairia de **−$3,39** para ~**−$1,4**.  
Enquanto A3 estiver aberto, qualquer “paridade de edge” em um dia de amostra curta é **frágil**.

**Ação:** forense oracle/CLOB resolution vs reconstrução do lake; regra canônica de empate/tick final; não misturar com achados de execução até fechar.

---

### A4 / A5 — Cobertura baixa + FAK na entrada + fill drift

| Item | Avaliação |
|------|-----------|
| FAK miss na entrada (23) | **Confirmado** (audit + orders em `prod-status`) |
| Fill drift (retries elevam preço) | **Confirmado** (ex. `1784963700` 0,62→0,57→0,62→fill 0,69; `1784965200` live 0,89 vs BT 0,62) |
| Cobertura “40/125” como gap principal | **Mal enquadrado** (ver §3.3) |
| “Não mudar entry para GTC sem lab” | **Correto** |

**Exemplo fill drift material:**

| Market | Live entry | BT entry | Live PnL | BT PnL | Δ |
|--------|----------:|---------:|---------:|-------:|--:|
| `1784965200` | 0,89 | 0,62 | +0,35 | +1,14 | **−0,80** |

**Funil subexplorado nos relatórios:** `entry_retry_gated` = **983**.  
Isso sugere que a “não-entrada” ou atraso de entrada passa por gates/retries muito mais vezes do que FAK miss (23) ou protective halt (3). Deve entrar no P1/P0 de cobertura como contador de funil, não só como detalhe de log.

---

### A6 — PnL sem fee / settle 0,995

| Item | Avaliação |
|------|-----------|
| Status | **Correto** |

Wins live: maioria `exitPrice = 0,995` (25) vs `1,0` (7).  
Métricas live de avg win ficam **otimistas** se comparadas a payout binário teórico $1, e o BT pode embutir fees de outra forma.  
Comparações futuras devem **normalizar fees + settlement haircut** nos dois lados.

---

### A7 / F4 — Journal multi-leg / settle duplicado

| Item | Avaliação |
|------|-----------|
| Status | **Correto e operacionalmente perigoso** |

- `/trades`: 40 closed, PnL +$2,67  
- Audit `position_settled`: 68 eventos, PnL +$3,06, 54 wins / 14 losses  
- `lossSettles` com markets repetidos (ex. `1784971800`, `1784963700`)

**Regra:** qualquer agregação de PnL/loss **só** via `/trades` (ou dedup por `marketId`+intent) até o journal ser corrigido.  
`prod-audit-summary.json` **não** é fonte de verdade de PnL.

---

### A8 — Lake incompleto (17/40)

| Item | Avaliação |
|------|-----------|
| Status | **Confirmado** |

17/40 = **42,5%** dos trades live sem contraparte no lake.  
A paridade “mesma janela, mesmos markets” está **estruturalmente incompleta**. Harness diário e repair de ingestão são pré-requisito de paridade contínua, não nice-to-have.

---

### A9 — Janela late-flip 4–8 s

| Item | Avaliação |
|------|-----------|
| Status nos relatórios | P2, lab antes de alargar |
| Auditoria | **Mantém P2; não tocar sem S3** |

Alargar a janela no escuro aumenta reverse “ruim” (como o path BT em `1784953500`). Só com breadcrumb + ablação lab.

---

### A10 — Seleção ≠ execução

| Item | Avaliação |
|------|-----------|
| 1 `bt_no_entry` | Confirmado (`1784958000`, live +$0,41) |
| 125 vs 40 | Em parte janela, em parte execução/feeds |

Há divergência real de entrada (timing, FAK, feeds), mas a magnitude foi exagerada pela contagem bruta.

---

### A11 — Audit omite ticks quietos

| Item | Avaliação |
|------|-----------|
| Status | **P0 de telemetria — aceito integralmente** |

É o achado metodológico mais importante do complementar.  
Bloqueia diagnóstico acionável de A1 e de parte dos `exit_path_diff`.

---

## 5. Decomposição do gap de PnL (visão do auditor)

### 5.1 Gap “headline” +$2,67 vs +$24,22

Não é um único fenômeno. Ordem de importância **corrigida**:

| # | Componente | Efeito | Comentário |
|---|------------|--------|------------|
| 1 | **Janela / uptime** | Domina o headline | Live ~19 h vs BT 48 h |
| 2 | **Qualidade por trade** | Gap real | avg $0,067 vs $0,194 |
| 3 | **Dados (winner, lake)** | Contamina paridade | A3, A8 |
| 4 | **Cobertura residual** | ~18% na taxa | FAK miss, gates, feeds 95% |
| 5 | **Path de saída / reverse** | Material mas não dominante no sample | ~−$2 em 2 holds; 1 incomplete “sortudo” |

Escalas úteis (não são previsões):

- Se live tivesse **125** trades à qualidade live atual: ~**+$8,3** (ainda << +$24).  
- Se live tivesse **40** trades à qualidade BT: ~**+$7,8**.  
- Same-side já isolado: **−$3,39** em 22 trades.

### 5.2 Decomposição same-side (22 markets)

| Bucket | Δ (live − BT) | Exemplos |
|--------|--------------:|----------|
| Winner divergente | **−$2,01** | `1784963700` |
| Exit path (hold vs reverse) | **≈ −$1,97** | `1784933100`, `1784951400` |
| Fill / entry price material | **≈ −$0,5 a −$0,8** | `1784965200` e drifts |
| Reverse incompleto “sortudo” | **+$2,15** | `1784953500` |
| Near-parity + fees/timing | residual | 13 near_parity; entry live ~+3¢ pior em holds vencedores |
| **Total** | **−$3,39** | |

### 5.3 Narrativa “gap = só modelo de execução”

**Parcialmente verdadeira.**

- A favor: WR alinha; fills garantidos no lab; FAK real; ignoreConsumed.  
- Contra: A3 (dados); A11 (não medimos late-flip); incomplete reverse com PnL positivo neste sample; janela enviesada no headline.

Fórmula mais honesta:

```text
Gap observado ≈ f(janela) + f(execução) + f(dados/settlement) + f(telemetria cega) + ruído amostral
```

---

## 6. Lab FAK-exit → GTC (auditoria do desenho)

### 6.1 O que o lab mediu

Variantes (params, não order type CLOB):

| ID | Proxy |
|----|--------|
| `gtc-full-protect` | reverse + exit + danger ON |
| `gtc-reverse-no-danger` | reverse + exit, danger OFF |
| `fak-miss-exit-only` | reverse OFF, exit + danger ON |
| `fak-miss-hold` | tudo OFF → hold expiry |

### 6.2 Resultados (aceitos como reportados)

**Janela live (24–25/07, 125 entries lab):**

| Variante | PnL | PF | Max DD |
|----------|----:|---:|-------:|
| gtc-reverse-no-danger | 25,54 | 1,73 | 4,11 |
| fak-miss-exit-only | 25,56 | 1,83 | 5,12 |
| gtc-full-protect | 24,22 | 1,68 | 4,11 |
| fak-miss-hold | 21,77 | 1,59 | 7,86 |

**Holdout jul (01–22/07, 2101 entries):**

| Variante | PnL | PF | Max DD |
|----------|----:|---:|-------:|
| gtc-reverse-no-danger | 431,43 | 1,60 | 15,78 |
| gtc-full-protect | 417,86 | 1,58 | 15,60 |
| fak-miss-exit-only | 298,59 | 1,45 | 13,17 |
| fak-miss-hold | 246,89 | 1,33 | 17,15 |

Δ full-protect vs hold (holdout): **+$171 (+69%)**; valor do reverse (full − exit-only) ≈ **+$119**.

### 6.3 O que o lab **não** prova

1. Que `exitOrderType: GTC` preenche como o proxy “protect ON”.  
2. Comportamento de partial fill + residual GTC + orphan cancel.  
3. Que reverse sempre melhora PnL na janela live curta (no lab, exit-only ≈ full-protect nesses 2 dias).  
4. Que o deploy recupera 40% do PnL do canário.

### 6.4 Veredito lab

| Afirmação do LAB | Veredito |
|------------------|----------|
| Proteção (esp. reverse) tem valor no holdout | **Aceita** |
| Deploy GTC justificado | **Aceita com ressalva** — como fix de path, não como forecast de +69% |
| Reverse é a peça cara | **Aceita no holdout**; na janela live sample-dependent |
| Limite do proxy reconhecido no próprio lab | **Correto e deve ser repetido em qualquer comunicação** |

---

## 7. Scorecard das conclusões dos relatórios

| # | Conclusão reportada | Veredito do auditor | Ajuste |
|---|---------------------|---------------------|--------|
| C1 | Edge direcional vivo (WR) | **Aceita** | — |
| C2 | Gap PnL = cobertura + path saída + dados | **Parcial** | Reordenar: **janela** > qualidade/dados > cobertura residual > path |
| C3 | FAK exit é causa raiz de reverse incompleto | **Aceita** | Impacto PnL no sample não generaliza |
| C4 | GTC exit corrige A2 e deve deployar | **Aceita** | Com monitor orphan + preferência a fallback reprice (S2b) |
| C5 | Lab valida a correção GTC | **Parcial** | Valida valor da proteção; proxy ≠ GTC |
| C6 | A1 subprovado por A11 | **Aceita** | Prioridade alta |
| C7 | Não entry-GTC sem lab | **Aceita** | — |
| C8 | 35 restarts explicam cobertura | **Rejeitada / superestimada** | 35 starts; **3** halts com posição; olhar `entry_retry_gated` |
| C9 | Ordem S0 deploy → S3 breadcrumb → S1 replay | **Aceita** | Incluir A3 e funil entry no mesmo horizonte |
| C10 | Subir budget só depois | **Aceita** | Critérios objetivos em §9 |

---

## 8. O que ainda atentar / corrigir / melhorar

### P0 — agora (bloqueia escala e confiança)

| ID | Item | Por quê | Aceite |
|----|------|---------|--------|
| P0.1 | Deploy `exitOrderType: GTC` (já em código local) | Fecha path FAK kill na saída | incomplete ↓; suite verde |
| P0.2 | Confirmar cancel/reconcile GTC EXIT no expiry | Evita orphanOrders pós-binary settle | orphanOrders≈0 em 24–48 h |
| P0.3 | Breadcrumb `lateFlip.active` (throttle) | Torna A1 acionável | losses com trilha ≥1 Hz na janela |
| P0.4 | Forense winner `1784963700` | Maior Δ same-side | regra canônica documentada |
| P0.5 | Não agregar PnL do audit bruto | Evita decisões em dados duplicados | só `/trades` ou dedup |

### P1 — em seguida (fecha gap mensurável)

| ID | Item | Por quê |
|----|------|---------|
| P1.1 | Funil cobertura: elegível → gate → submit → fill | `entry_retry_gated` 983 é pista principal subexplorada |
| P1.2 | Política de retry FAK **entrada** (cap + não chase) | Fill drift e miss sem virar GTC resting |
| P1.3 | Fallback saga reverse (S2b): reprice / EXIT-only | GTC passivo pode ficar morto |
| P1.4 | Harness diário live×BT **mesma janela UTC** | Acaba com 40 vs 125 enganoso |
| P1.5 | Dedup `position_settled` no journal | Telemetria confiável |
| P1.6 | Modelar FAK-miss / partial no lab (S6) | Paridade de execução, não só de sinal |

### P2 — robustez

| ID | Item |
|----|------|
| P2.1 | Lake: não omitir eventos do canário live |
| P2.2 | Settlement 0/1 canônico + fees alinhados no report |
| P2.3 | Reduzir restarts mid-position (ops) |
| P2.4 | Availability feeds → SLO 0,995 |
| P2.5 | Lab janela late-flip / earlyWarn **só com** breadcrumb |

### Explicitamente **não** fazer agora

- Subir hardCap / entry budget.  
- `entryOrderType: GTC` sem experimento de adverse selection.  
- Alargar late-flip 4–8 s no escuro.  
- Comunicar “+69% PnL pós-GTC” com base no lab proxy.  
- Otimizar hiperparâmetros no lab puro sem modelo de fill.

---

## 9. Caminho correto recomendado

```text
Fase 0 — Freeze de escala
  • Canário permanece $2 / $4
  • Decisões de PnL só via /trades

Fase 1 — Harden saída (0–2 dias)
  1. Validar cancel GTC EXIT no market expiry (código + teste)
  2. Deploy exitOrderType: GTC
  3. Monitor 24–48 h:
       - REVERSE_EXIT_INCOMPLETE
       - REVERSE complete rate
       - orphanOrders
       - avg loss / PF

Fase 2 — Enxergar (paralelo ou imediato pós-deploy)
  4. Breadcrumb lateFlip (S3)
  5. Dedup settlement journal (F4)
  6. Forense A3 winner 1784963700

Fase 3 — Remedir (2–3 dias de canário instrumentado)
  7. Harness diário:
       - taxa entry por slot na janela uptime
       - paridade same-side
       - FAK miss rate entrada
       - reverse success / incomplete
       - missing lake %
  8. Replay losses com breadcrumb (S1) — agora com evidência

Fase 4 — Fechar lab ↔ live
  9. Fill model (miss, partial, latency) no lab
 10. Fallback reverse S2b se incomplete residual > 0
 11. Experimento entry (retry policy) — só depois

Fase 5 — Gate de budget
  Critérios sugeridos (todos):
    • PF live (3d) ≥ ~1,4
    • incomplete reverse ≈ 0
    • orphanOrders ≈ 0
    • |ΔPnL| same-side médio estável e sem A3 aberto
    • taxa entry live ≥ ~85% da taxa BT na mesma janela
    • availability ≥ SLO ou justificada
  → só então aumentar budget gradualmente
```

### Princípios de decisão

1. **Uma variável de execução por vez** (saída GTC ≠ entrada GTC ≠ janela late-flip).  
2. **Comparar sempre mesma janela e mesma lista de markets.**  
3. **Lab mede sinal + teto de proteção; live mede fill.** O gap entre os dois é feature a modelar, não bug a ignorar.  
4. **Telemetria antes de hipótese** (A11 → A1, não o contrário).  
5. **Dados de settlement errados invalidam paridade** até A3 fechar.

---

## 10. Deep-dive revalidado (tabela canônica)

| Market | Live | BT | ΔPnL | Classificação auditor | Notas |
|--------|-----:|---:|-----:|----------------------|-------|
| 1784933100 | −1,59 hold | −0,89 reverse | −0,70 | exit_path | proteção BT melhor; sem incomplete logado |
| 1784951400 | −1,61 hold | −0,34 reverse | −1,27 | exit_path | maior Δ de path “puro” |
| 1784963700 | −1,35 (winner Up) | +0,66 (winner Down) | −2,01 | **dados/settlement** | A3 P0 |
| 1784953500 | +0,63 (rev incomplete) | −1,52 reverse | +2,15 | path diverge; live sortudo | **não** usar como “FAK custou $” |
| 1784965200 | +0,35 @0,89 | +1,14 @0,62 | −0,80 | fill drift | A5 |
| 1784947200 | +1,07 @0,77 | +0,64 @0,84 | +0,43 | fill a favor live | simétrico ao drift |
| 1784958000 | +0,41 | no_entry | +0,41 | seleção | A10 |

JSON trade-a-trade: `full-parity-report.json` / `full-parity-slim.json`.

---

## 11. Limitações desta auditoria

1. Amostra live curta (~40 trades, ~1 dia efetivo de canário).  
2. 42% dos trades live sem lake → paridade incompleta.  
3. Não se reexecutou o motor lab nesta sessão; números do LAB-FAK confiam nos reports Brutus citados.  
4. Patch GTC está reportado no complementar; validação de presença no deploy de produção **não** foi rechecada aqui.  
5. `entry_retry_gated=983` não foi decomposto por reason code (próximo trabalho de funil).  
6. Timestamps de market id em epoch usados como proxy de janela — alinhados aos trades, suficientes para taxa, não para SLA de segundo.

---

## 12. Conclusão final

Os relatórios comparativos estão **substancialmente corretos no diagnóstico de engenharia** (FAK na saída, ignoreConsumed, audit quieto, fees/settlement, journal duplicado) e **parcialmente incorretos na narrativa de negócio do gap de PnL** (cobertura 40 vs 125 sem normalizar janela; lab GTC como se fechasse o buraco).

**O que fazer:**

1. Tratar o canário como **sinal direcional válido sob micro budget**.  
2. Deployar GTC na saída com disciplina de órfãs e telemetria.  
3. Parar de usar headline +$2,67 vs +$24,22 como KPI de falha sem normalizar.  
4. Fechar A3 e A11 para que a próxima rodada de paridade seja **científica**, não arqueológica.  
5. Só então atacar funil de entrada e modelo de fill no lab — e só depois falar em scale.

**Arquivos desta auditoria:**

- Este relatório: `scratch/live-vs-backtest/RELATORIO-AUDITORIA-CONCLUSOES-LIVE-VS-BT.md`  
- Base: `RELATORIO-MIDAS-LIVE-VS-BT.md`, `RELATORIO-COMPLEMENTAR-CORRECAO-FAK-EXIT.md`, `LAB-FAK-EXIT-GTC.md`

---

*Fim do relatório de auditoria.*
