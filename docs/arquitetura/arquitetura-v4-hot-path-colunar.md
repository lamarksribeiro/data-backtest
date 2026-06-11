# Arquitetura V4 — Correção Definitiva de Performance (Hot Path Colunar)

> **Status: PLANO APROVADO — prioridade máxima (viabilidade do produto)**
> Data: 2026-06-11 (rev. 2). Pré-requisito: V2 implementada (R1–R8). Não
> conflita com a V3 (consolidação de UX) — pode ser executada em paralelo.
>
> **Rev. 2**: a primeira versão deste plano propunha um formato binário próprio
> em disco (`.glc`) ao lado do Parquet. Rejeitado: duplicava espaço em disco e
> criava um segundo formato a manter — exatamente o que a migração
> Postgres→Parquet veio eliminar. A análise da fronteira DuckDB→JS (ver §1.2)
> mostrou que o formato em disco nunca foi o problema. Esta revisão mantém o
> Parquet como único formato em disco e corrige o problema onde ele realmente
> está.

## 0. Por que este documento existe

A V2 entregou ganhos reais (compilador GLS→JS, prefetch, cache LRU, fila +
SSE), mas o backtest continua lento demais para o ciclo de iteração que o
produto exige (editar estratégia → rodar → analisar → repetir, dezenas de
vezes por sessão, e futuramente sweeps de parâmetros com centenas de runs).

**Meta de viabilidade (critério de aceite do plano inteiro):**

| Métrica | Hoje (estimado) | Meta V4 |
|---|---|---|
| Throughput de processamento | ~0,1–0,3 M ticks/s | **≥ 2 M ticks/s por core** |
| Run quente (dados em memória), 1 semana (~1–2 M ticks) | dezenas de segundos | **< 1 s** |
| Run frio (primeira leitura da janela) | ~1–2 min | **< 5 s** |
| Variante em sweep de parâmetros (fast-run, dados quentes) | inviável | **< 300 ms** |
| Espaço em disco do lake | Parquet | **Parquet, inalterado (0 bytes extras)** |

Os números de "hoje" são estimativas de inspeção de código — a fase F0 abaixo
estabelece o baseline real antes de qualquer mudança.

---

## 1. Diagnóstico: o gargalo não é o Parquet — é a fronteira DuckDB→JS

### 1.1 O que a migração para Parquet já entregou (e que este plano preserva)

A troca Postgres→Parquet+DuckDB acertou: armazenamento colunar comprimido
(menos disco), decode nativo multi-thread, projection pushdown (só lê as
colunas pedidas) e predicate pushdown (só lê os row groups da janela). **Nada
disso é o gargalo.** O decode de Parquet acontece em C++ dentro do DuckDB e é
rápido.

### 1.2 Onde o trabalho é jogado fora (verificado no código)

O pipeline atual, do disco até a estratégia:

```
Parquet (colunar, comprimido)
  → DuckDB decode nativo (colunar, vetorizado, multi-thread)   ✅ rápido
  → chunks colunares internos do DuckDB (vetores tipados)      ✅ já é o formato ideal
  → yieldRowObjectJs()        ← AQUI: explode cada vetor em    🔴 linhas-objeto JS
  → jsonSafeRow() por linha   ← cópia + normalização por linha 🔴
  → buffer.push(row) por linha                                 🔴
  → datasetCache: converte objetos → colunar (set) e           🔴 colunar → objetos
    materializeBatches() (get) DE NOVO a cada cache hit
  → runner.processTick(tick)  ← lê 5–10 campos de objeto de até 217 props
```

Os dados **nascem colunares no disco e atravessam o DuckDB colunares**; nós os
destruímos na fronteira com o JS (`openBacktestTickSession` em
`src/query/duckdbQuery.js`: `result.yieldRowObjectJs()` + `jsonSafeRow` linha a
linha). Em 1 M de ticks com bookDepth=25 são **1 M de objetos e até 217 M de
propriedades** criados, percorridos e coletados pelo GC — em *todo* run. E o
cache LRU (`src/backtest/datasetCache.js`) agrava: guarda colunar
(`Float64Array`), mas `get()` chama `materializeBatches()` e reconstrói todos
os objetos novamente em cada hit.

### 1.3 Os 4 impostos estruturais

| # | Imposto | Evidência | Sev. |
|---|---------|-----------|------|
| **T1** | Linha→objeto JS na fronteira DuckDB→JS (`yieldRowObjectJs` + `jsonSafeRow` por linha) | `duckdbQuery.js` `openBacktestTickSession`/`fillBuffer` | 🔴 |
| **T2** | Cache LRU re-materializa objetos a cada hit (`materializeBatches`) | `datasetCache.js` `get()` | 🔴 |
| **T3** | Zero paralelismo intra-run: eventos independentes processados em 1 thread | `engine.js` l.84–105 | 🟠 |
| **T4** | GLS "compilado" ainda semi-dinâmico: `__call('lib.x', […])` com dispatch por string, guards `ctx.tick && typeof…` por acesso, locals via `__getLocal`/`__setLocal` | `gls/compiler.js` | 🟡 |

### 1.4 Histórico de decisões de armazenamento (para não regredir)

| Era | Solução | Por que mudou |
|-----|---------|---------------|
| v0 | Postgres relacional | lento para scans analíticos, disco caro (row-oriented, sem compressão colunar) |
| v1 (atual) | Parquet + DuckDB | ✅ scans rápidos, compressão, pushdowns — **mantido como único formato** |
| ~~rejeitado~~ | ~~formato binário próprio `.glc` ao lado do Parquet~~ | duplicava disco, segundo formato a manter, builder/invalidação extras — atacava o sintoma, não a causa (§1.2) |
| **v4 (este plano)** | **Parquet + DuckDB com fronteira colunar** | zero bytes extras em disco; corrige a conversão, não o armazenamento |

---

## 2. O princípio da correção definitiva

> **Os dados são colunares no disco (Parquet) e colunares no DuckDB.
> Eles devem permanecer colunares até a estratégia. O tick nunca vira objeto
> JavaScript no hot path.**

Três pilares, em ordem de dependência:

```
P1  Fronteira colunar: DuckDB chunks → TypedArrays (ColumnSet), sem objetos-linha
     └─ resolve T1 e T2. Parquet intacto. Zero disco extra.
P2  Hot loop Struct-of-Arrays (SoA) + codegen GLS v2
     └─ GLS compilado lê colunas por índice: col_up_price[i]. Resolve T4.
P3  Paralelismo por evento com SharedArrayBuffer + worker pool
     └─ resolve T3. Colunas compartilhadas zero-copy entre N workers.
```

Cada pilar entrega valor sozinho e tem flag de rollback independente.

---

## 3. P1 — Fronteira colunar (DuckDB chunks → `ColumnSet`)

### 3.1 Conceito

O `@duckdb/node-api` expõe o resultado como **chunks colunares** (API de
`fetchChunk`/vetores), com os dados numéricos acessíveis de forma tipada — o
mesmo layout que o DuckDB usa internamente. Em vez de `yieldRowObjectJs()`, o
novo leitor consome chunk a chunk e **copia cada vetor para `TypedArrays`
pré-alocados por coluna** (1 loop tipado por coluna por chunk de ~2048 linhas
— sem alocação por linha, sem hidden classes, sem GC de objetos).

> Spike obrigatório na F1: confirmar na versão instalada
> (`@duckdb/node-api@1.5.x`) o acesso mais barato aos vetores do chunk
> (idealmente view direta no buffer nativo; no pior caso, cópia tipada por
> chunk — ainda assim ordens de magnitude mais barato que objetos por linha).

### 3.2 `ColumnSet` — a estrutura única do hot path

Novo `src/backtest/columnStore.js`:

```js
ColumnSet = {
  length,                                  // nº de ticks
  columns: Map<string, Float64Array>,      // numéricos; null → NaN
  codes:   Map<string, Int32Array>,        // strings dict-encoded (market_id, condition_id…)
  dictionaries: Map<string, string[]>,     // código → string
  flags:   Map<string, Uint8Array>,        // booleanos (degraded)
  events:  [{ conditionCode, startRow, endRow, eventStart, eventEnd, priceToBeat }],
}
```

Decisões de representação:

- **Numéricos** → `Float64Array`; `null` → `NaN` (compatível com os guards do
  GLS; o codegen P2 emite `Number.isNaN` onde necessário).
- **Strings de baixa cardinalidade** → dictionary encoding em memória
  (`Int32Array` de códigos + tabela). No hot loop só circulam inteiros.
- **Índice de eventos** computado durante o load: um único scan O(n) sobre os
  códigos de `condition_id` (dados já vêm ordenados por evento/ts do DuckDB)
  produz os ranges `[startRow, endRow)`. Pré-requisito do P3, sem nenhum
  artefato em disco.
- **Alocação única por coluna**: o total de linhas da janela já é conhecido
  (estimativa de availability); pré-alocar e preencher chunk a chunk (com
  growth fallback se a estimativa divergir).

### 3.3 Cache LRU passa a ser o "formato quente"

`datasetCache.js` é simplificado, não expandido:

- `set()` guarda o `ColumnSet` **como está** (já é o formato final — morre a
  conversão objeto→colunar).
- `get()` retorna o `ColumnSet` **como está** (morre `materializeBatches()`).
- `estimateSize` vira soma real de `byteLength`.
- Run quente = zero conversão, zero alocação de dados, zero GC de ticks.

### 3.4 Memória (e por que não precisamos de cache em disco)

Com column pruning (já existente, R2), estratégias típicas usam 6–9 colunas:
7 dias ≈ 1,5 M ticks × 8 col × 8 B ≈ **~100 MB por janela** — confortável no
budget default de 512 MB (`DATASET_CACHE_MAX_MB`). Estratégias de book
(217 colunas ≈ 2,6 GB/semana) não cabem inteiras: para elas o `ColumnSet` é
processado em **chunks por dia** com streaming (mesmo pipeline, sem cache do
book completo). O run frio dessas é limitado por leitura — que o P1 já torna
barata — então não há justificativa para cache em disco. **O lake permanece
100% Parquet.**

### 3.5 Compatibilidade com estratégias nativas (legacy)

O runner nativo (`edgeSniperV2`) e o modo `interpreter` esperam objeto tick.
Solução: **cursor-view** — *um único* objeto reutilizado por run cujos getters
leem `columns.get(campo)[i]` do índice corrente. Estratégias legacy continuam
funcionando sobre dados colunares sem 1 objeto/tick. O caminho antigo
(`yieldRowObjectJs`) permanece atrás de `BACKTEST_ENGINE=rows` como rollback.

### 3.6 Ajustes Parquet (opcionais, dentro do formato)

Se o bench da F1 mostrar o decode nativo como novo limitante (improvável),
as alavancas são **internas ao Parquet**, não um novo formato: codec
(ZSTD→LZ4 para decode mais rápido), tamanho de row group, e garantia de
ordenação por `condition_id, ts` na escrita (melhora pushdown e o scan do
índice de eventos). Qualquer mudança aqui é medida contra o custo de disco —
o ganho de espaço da migração para Parquet é inegociável.

---

## 4. P2 — Hot loop Struct-of-Arrays + codegen GLS v2

### 4.1 Novo contrato do motor

`engine.js` ganha um caminho novo (flag `BACKTEST_ENGINE=soa`, default após
paridade):

```js
// hoje:  for (const tick of batch) runner.processTick(tick)
// V4:
for (const ev of columnSet.events) {
  runner.beginEvent(ev);                       // onEventStart
  for (let i = ev.startRow; i < ev.endRow; i++) {
    runner.processIndex(i);                    // onTick — SEM objeto tick
  }
  runner.endEvent(ev);                         // onEventEnd
}
```

### 4.2 Codegen GLS v2 (`compiler.js`)

O compilador já faz análise de colunas (`analyzeStrategyColumns`) — ele sabe
exatamente quais campos a estratégia lê. O codegen v2:

1. **Bind de colunas no preâmbulo do hook** (1× por run, não por tick):
   `const __c_up_price = cols.get('up_price');` …
2. **Acesso por índice**: `tick.upPrice` → `__c_up_price[i]`. Acaba o guard
   `ctx.tick && typeof ctx.tick === 'object' ? …`.
3. **Locals viram `let` reais**: o validador GLS já conhece todos os `let` do
   corpo → emitir variáveis JS de verdade. `__getLocal`/`__setLocal` morrem.
4. **Calls da stdlib resolvidos em compile-time**: `__call('market.x', […])`
   → referência direta `__lib_market_x(…)` capturada no closure. O dispatch
   por string morre; V8 inlina.
5. **`state.*` continua objeto** (1 por evento, não por tick — custo ok).
6. **Book**: `book.bidPx(side, level)` → leitura direta na coluna
   `up_bid_px_<level>[i]`; sem materializar arrays de níveis.

Resultado esperado: o corpo do hook vira JS monomórfico que o V8 compila para
loads de `Float64Array` — o tipo de código que o JIT transforma em máquina
próxima de C.

### 4.3 Runtime zero-allocation

- `orderSim`: per-tick hoje cria snapshots (`positionView` com getter).
  Trocar por view mutável reutilizada + invalidação por flag; snapshot real só
  quando `debug.*` ou trace pede.
- **Fast-run de verdade**: em modo sweep (`fastRun: true`), pular toda a
  captura de logs/marks/metrics e sidecar de chart — só PnL/summary. Hoje o
  fast-run ainda paga parte desse custo.
- Datas: hooks que usam tempo recebem epoch-ms (number); `new Date` só em
  formatação de saída.

### 4.4 Paridade (gate obrigatório)

- Mesmo harness da R1: dual-run interpreter × compiled-soa nos testes
  `tests/glsCompiler.test.js` e `tests/edgeSniperGlsParity.test.js`, com
  comparação de summary, eventos, ordens e PnL (tolerância 1e-9).
- `GLS_EXECUTION` ganha o valor `compiled-soa`; `compiled` (atual) e
  `interpreter` permanecem como fallbacks por, no mínimo, um ciclo de release.
- NaN-as-null: suíte específica de casos com `coverage`/`degraded`/preços
  ausentes comparando os três modos.

---

## 5. P3 — Paralelismo por evento (worker pool + SharedArrayBuffer)

### 5.1 Modelo

- O `ColumnSet` é alocado em **`SharedArrayBuffer`** (colunas são read-only no
  hot path) → N workers leem as mesmas colunas **zero-copy**.
- Unidade de trabalho = **evento** (independente por construção). O
  `events` do `ColumnSet` (P1) já dá os ranges; o scheduler distribui fatias
  (work-stealing simples por chunks de ~50 eventos).
- Cada worker roda o mesmo codegen P2 sobre seu subconjunto; resultados
  (eventos finalizados, PnL, traces) voltam por `postMessage` e o thread
  principal agrega na ordem original (resultado determinístico — ordem de
  eventos preservada na agregação, não na execução).
- Implementação: pool próprio sobre `worker_threads` (sem dependência nova;
  ~150 linhas) dentro do worker de backtest atual (`src/backtest/worker.js`
  vira coordenador).

### 5.2 Limites container-safe (lição da V2 — não repetir a regressão)

- **Nunca usar `os.availableParallelism()` como default** (em container
  Coolify reporta cores do host → thrashing; já documentado em
  `docs/arquitetura/arquitetura-v2-performance-ux.md`).
- Nova env `BACKTEST_WORKERS` (default **1** = comportamento atual). Em
  produção dedicada, subir explicitamente (ex.: 4).
- Regra de orçamento de CPU documentada no deploy:
  `BACKTEST_WORKERS × MAX_CONCURRENT_BACKTESTS + DUCKDB_THREADS ≤ vCPUs`.
- Equity/curva agregada: calculada na agregação final (já é `finishMs`, fora
  do loop).

### 5.3 Quando P3 NÃO se aplica

Estratégias com estado *entre* eventos (`runState.*` mutado em um evento e
lido no seguinte). O validador GLS detecta escrita em `runState` → run cai
automaticamente para 1 worker (correção > velocidade). Hoje nenhuma estratégia
seed depende disso; documentar a limitação no manual GLS.

---

## 6. Fases de execução

| Fase | Entrega | Depende de | Risco | Ganho esperado |
|------|---------|-----------|-------|----------------|
| **F0** | Baseline real: rodar `npm run bench:backtest` (janelas 1d/7d/30d, lite e book) e salvar em `reports/bench/`. Sem baseline, nenhuma fase mergeia. | — | nulo | medição |
| **F1** | Fronteira colunar: spike da API de chunks do `@duckdb/node-api` → leitor `ColumnSet` (`columnStore.js`); cache LRU guarda/entrega `ColumnSet` sem materializar; cursor-view para legacy; índice de eventos no load. Flag `BACKTEST_ENGINE`. | F0 | médio | **5–15× no `duckdbReadMs` frio; 3–10× em run quente** |
| **F2** | Codegen GLS v2 (SoA, locals reais, calls estáticos) + gates de paridade. `GLS_EXECUTION=compiled-soa`. | F1 | médio | **3–8× no `processMs`** |
| **F3** | Runtime zero-alloc: positionView reutilizada, fast-run sem traces, datas como number. | F2 | baixo | 1,5–2× no `processMs` |
| **F4** | Worker pool por evento (SAB), `BACKTEST_WORKERS`, fallback runState. | F1+F2 | médio | ~linear por core (até 4× em 4 vCPU) |
| **F5** | Sweep nativo: endpoint de run multi-variante reusa `ColumnSet` quente + fast-run F3 para N conjuntos de params em 1 job. Base do otimizador (R9/V3). | F3 | baixo | sweeps viáveis (centenas de variantes/min) |

Ganho composto estimado (frio, 7 dias, estratégia lite): leitura 20s→~2s,
processamento 30s→~2s em 1 worker, **~1s com 4 workers**. Run quente em sweep:
**dezenas de ms por variante**. Cumpre a meta da §0 com margem — **sem 1 byte
extra em disco**.

### Regras de merge por fase

1. Bench da fase salvo em `reports/bench/` comparando com F0 (mesma janela,
   mesma máquina), incluído no PR.
2. Paridade dual-run verde (F2+) — summary/PnL idênticos ao interpretador.
3. Flag de rollback documentada (`BACKTEST_ENGINE`, `GLS_EXECUTION`,
   `BACKTEST_WORKERS`).
4. Suíte completa verde (`npm test`).
5. **Uso de disco do lake inalterado** (verificável: nenhuma fase escreve no
   lake).

## 7. O que NÃO muda

- **Lake Parquet** — único formato em disco, fonte de verdade, mesmos ganhos
  de espaço e velocidade de scan que motivaram a migração. Zero artefatos
  derivados.
- **DuckDB** — continua sendo o leitor de Parquet (decode nativo, pushdowns) e
  o motor de consultas ad-hoc/validação/coverage. Muda só *como consumimos o
  resultado* (chunks colunares em vez de objetos-linha).
- **API HTTP, SSE, fila, UI do Estúdio** — contratos intactos; a V3 (UX) segue
  em paralelo sem conflito.
- **GLS (linguagem)** — nenhuma mudança de sintaxe ou semântica; só o backend
  de execução.
- **SQLite de traces/runs** — mesmo schema; sidecars de chart idem.

## 8. Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| API de chunks do `@duckdb/node-api` não expor vetores de forma barata | Spike na F1 antes de qualquer refactor; pior caso = cópia tipada por chunk (ainda elimina objetos por linha); rollback `BACKTEST_ENGINE=rows` |
| Divergência numérica compiled-soa × interpreter (NaN vs null) | Gate de paridade obrigatório + suíte NaN dedicada (§4.4); interpreter permanece como oráculo |
| Estouro de memória com book depth 25 | Chunks por dia + streaming (§3.4); budget `DATASET_CACHE_MAX_MB` respeitado |
| Thrashing de CPU em container (regressão tipo DUCKDB_THREADS) | `BACKTEST_WORKERS` default 1, nunca derivado de `os.availableParallelism()`; regra de orçamento no deploy |
| Estratégias com `runState` entre eventos quebrarem no P3 | Detecção estática no validador → fallback automático para 1 worker |
| Estratégias nativas legacy quebrarem sem objeto tick | Cursor-view reutilizado (§3.5) + caminho `rows` mantido como rollback |
| Escopo crescer (reescrever tudo de uma vez) | Fases independentes com flag própria; F1 sozinha já remove T1+T2 e valida a direção |

## 9. Decisões registradas

1. **Sem formato em disco adicional** (rejeitado o `.glc` da rev. 1): o
   Parquet já é colunar e comprimido; o problema era a conversão linha→objeto
   na fronteira DuckDB→JS, não o armazenamento. Um segundo formato duplicaria
   disco e manutenção sem atacar a causa.
2. **Sem Arrow/Feather como camada intermediária**: o consumidor é um só
   (nosso engine); a extração direta de chunks do DuckDB para TypedArrays
   cumpre o papel sem dependência nova nem cópia extra de serialização IPC.
3. **`worker_threads` + SAB em vez de `piscina`/cluster**: pool é trivial,
   evita dependência, e SAB exige `worker_threads` de qualquer forma.
4. **NaN como null** em colunas numéricas: elimina máscaras de validade
   (bitmaps) ao custo de `Number.isNaN` pontual no codegen — irrelevante em
   loops de `Float64Array`.
5. **Interpreter nunca é removido**: é o oráculo de paridade e o executor de
   referência da linguagem GLS.
6. **Cache quente é em RAM, não em disco** (`DATASET_CACHE_MAX_MB`): com a
   leitura fria barata (P1), cache em disco não se justifica e violaria a
   regra de disco inalterado.
