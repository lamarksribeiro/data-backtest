# Implementacao Do Backtest Studio Programavel

## Objetivo

Este documento descreve como implementar o Backtest Studio do `data-backtest`.

O Backtest Studio e a camada onde o usuario cria, edita, salva, versiona, executa e analisa estrategias de backtest em ambiente controlado.

Research Labs externos continuam separados. Eles sao ambientes livres de pesquisa, tuning e descoberta de estrategias. O Backtest Studio recebe apenas estrategias que devem virar artefatos salvos, versionados, reproduziveis e comparaveis.

O objetivo e sair do modelo:

```text
uma estrategia hardcoded por arquivo/classe
```

e chegar no modelo:

```text
estrategias como documentos salvos, versionados e executados por um runtime controlado
```

## Dependencias

Antes de implementar este documento, o lakehouse deve ter:

- `backtest_ticks` validado;
- `lake_manifest` operacional;
- `DuckDbTickProvider`;
- `backtest_runs` basico;
- API de availability/prepare;
- backtest nativo `edge-sniper-v2` como golden test.

## Desacoplamento Do Golden Test

Estado atual de transicao:

```text
src/backtest/engine.js registra edge-sniper-v2 diretamente.
src/api/server.js e src/cli.js usam edge-sniper-v2 como default quando nenhuma estrategia e informada.
```

Isso e aceitavel apenas enquanto o Backtest Studio ainda nao tem registry de estrategias salvas.

Meta de arquitetura:

```text
Lakehouse core -> fornece dados/manifest/query
Backtest engine -> executa runner recebido por registry generico
Backtest Studio -> escolhe strategy_id/version e fornece codigo/runner ao engine
```

Quando `strategy_definitions`/`strategy_versions` e o runtime GLS existirem, remover o default fixo de `edge-sniper-v2` da API/CLI ou manter apenas como estrategia seed/versionada. O lakehouse core nunca deve importar `src/strategies/*`.

## Status De Implementacao

Status revisado em 2026-06-05: a implementacao MVP do Backtest Studio ja existe no codigo. A tabela abaixo substitui o snapshot historico que marcava todas as fases como pendentes.

| Fase | Status |
|---|---|
| Pre-B1 (traces + endpoints + explorer basico) | concluido |
| B1 Persistencia de estrategias | concluido |
| B2 Editor UI | concluido |
| B3 Validador GLS | concluido |
| B4 Runtime GLS | concluido |
| B5 Execucao sobre lakehouse | concluido |
| B6 Visualizacao | concluido |
| B7 Migracao edge-sniper | concluido como seed GLS |

### Lacunas Reais Ainda Abertas

- Validacao operacional L8 em producao/Coolify, incluindo smoke, backup e restore dos volumes `/lake` e `/state`.
- L5 continua parcial: `PostgresTickProvider`, `HybridTickProvider` e `streamEvents` ainda nao foram implementados.
- O editor GLS e funcional, mas ainda e MVP: nao ha autocomplete rico, diff entre versoes, comparador de runs ou otimizador de parametros.
- O runtime GLS e propositalmente pequeno e seguro; JavaScript livre, imports, rede, filesystem e async continuam fora do escopo.

Hoje, runs nativos ja persistem `events`, `equity` e `log` dentro de `backtest_runs.result_json`. O pre-B1 normaliza isso em `backtest_event_traces` e expoe endpoints de detalhe antes do CRUD de estrategias.

Equivalencia com `docs/arquitetura/arquitetura-editor-estrategias.md`: A→B1, B→B3, C→B4, D→B5, E→pre-B1+B6, F→B7, G→pos-MVP.

## Principios

- Estrategias editaveis nunca leem Postgres diretamente.
- Toda execucao usa dados resolvidos pelo manifest.
- O runtime deve ser seguro e deterministico.
- Codigo de estrategia deve ser salvo e versionado.
- Um run sempre aponta para um snapshot imutavel da estrategia.
- Resultado deve ser explicavel por evento.
- O usuario deve conseguir duplicar uma estrategia e alterar codigo/parametros.
- `edge-sniper-v2` nativo e golden test, nao arquitetura final.

## Arquitetura

```text
UI Backtest Studio
  editor de codigo
  parametros
  selecao de dataset/range
  run history
  event explorer

API Backtest Studio
  CRUD estrategias
  validacao
  execucao
  runs
  traces

Runtime GLS
  parser
  validator
  interpreter
  standard library blocks
  order simulator
  trace collector

Lakehouse
  manifest
  DuckDB
  backtest_ticks
  ohlc/chart data
```

## Estrategia Como Documento

Uma estrategia tem duas entidades:

```text
strategy_definitions
strategy_versions
```

`strategy_definitions` guarda identidade mutavel.

`strategy_versions` guarda snapshots imutaveis do codigo.

## Schema SQLite

### `strategy_definitions`

```sql
CREATE TABLE IF NOT EXISTS strategy_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'archived')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

### `strategy_versions`

```sql
CREATE TABLE IF NOT EXISTS strategy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategy_definitions(id),
  version INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'gls-v1',
  source_code TEXT NOT NULL,
  params_schema_json TEXT NOT NULL DEFAULT '{}',
  compiled_json TEXT,
  validation_json TEXT NOT NULL DEFAULT '{}',
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(strategy_id, version)
);
```

### Evolucao De `backtest_runs`

Adicionar quando o Backtest Studio entrar:

```text
strategy_id INTEGER NULL
strategy_version_id INTEGER NULL
strategy_snapshot_json TEXT NULL
dataset_request_json TEXT NULL
trace_root_path TEXT NULL
status TEXT NOT NULL DEFAULT 'completed'
error TEXT NULL
duration_ms INTEGER NULL
```

### `backtest_event_traces`

```sql
CREATE TABLE IF NOT EXISTS backtest_event_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES backtest_runs(id),
  condition_id TEXT NOT NULL,
  market_id TEXT,
  event_start TEXT NOT NULL,
  event_end TEXT NOT NULL,
  side TEXT,
  entries_count INTEGER NOT NULL DEFAULT 0,
  exits_count INTEGER NOT NULL DEFAULT 0,
  final_pnl REAL NOT NULL DEFAULT 0,
  result TEXT,
  reason TEXT,
  ticks_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  orders_json TEXT NOT NULL DEFAULT '[]',
  marks_json TEXT NOT NULL DEFAULT '[]',
  logs_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  chart_series_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

Indices:

```sql
CREATE INDEX IF NOT EXISTS backtest_event_traces_run_idx ON backtest_event_traces(run_id, event_start);
CREATE INDEX IF NOT EXISTS backtest_event_traces_condition_idx ON backtest_event_traces(condition_id);
```

## Linguagem GLS V1

Nome provisório:

```text
GLS = GoldenLens Strategy
```

### Objetivo Da Linguagem

Permitir que o usuario escreva estrategia de forma parecida com programacao comum, mas dentro de um ambiente seguro.

### Nao Permitido

- acesso a filesystem;
- acesso a rede;
- `eval`;
- imports arbitrarios;
- async;
- loops sem limite;
- acesso a variaveis de ambiente;
- chamadas Node.js;
- mutacao fora de `state`/`runState` permitido.

### Permitido

- declaracao de parametros;
- funcoes/hooks fixos;
- `if/else`;
- operadores matematicos;
- comparacoes;
- variaveis locais;
- chamada a blocos da biblioteca padrao;
- chamada a API de ordens simuladas;
- logs/marks/metrics.

## Sintaxe MVP

Exemplo:

```js
strategy "Simple PTB" {
  param minDistanceAbs = 50
  param maxAsk = 0.58
  param stopBid = 0.18
  param maxOrderValue = 15

  onEventStart(event) {
    state.entered = false
  }

  onTick(tick, event) {
    let secondsLeft = time.secondsUntil(event.end, tick.ts)
    let distance = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
    let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
    let ask = book.ask(side, tick)
    let bid = book.bid(side, tick)

    if (!state.entered && secondsLeft <= 105 && distance >= params.minDistanceAbs && ask <= params.maxAsk) {
      enter(side, { price: ask, budget: params.maxOrderValue, reason: "entry" })
      state.entered = true
      mark("entry")
    }

    if (position.open && bid <= params.stopBid) {
      exit({ price: bid, reason: "stop_bid" })
    }
  }

  onEventEnd(event) {
    closeOpenPosition({ reason: "event_end" })
  }
}
```

## Parser E AST

### MVP Recomendado

Implementar parser simples para GLS em vez de executar JavaScript livre.

Opcoes:

1. Parser proprio recursivo pequeno.
2. Parser baseado em uma gramatica simples com biblioteca leve.
3. Subconjunto JS parseado para AST e validado rigidamente.

Recomendacao inicial:

```text
Subconjunto proprio pequeno, suficiente para hooks, params, if, let e chamadas de funcao.
```

### AST Minima

```json
{
  "type": "Strategy",
  "name": "Simple PTB",
  "params": [
    { "name": "minDistanceAbs", "default": 50 }
  ],
  "hooks": {
    "onEventStart": { "body": [] },
    "onTick": { "body": [] },
    "onEventEnd": { "body": [] }
  }
}
```

## Validador

Validacoes obrigatorias:

- sintaxe valida;
- nome de estrategia presente;
- parametros sem duplicidade;
- hooks conhecidos;
- chamadas de funcao existentes;
- variaveis locais declaradas antes do uso;
- escrita permitida apenas em `state`/`runState`;
- `enter/exit/reverse/closeOpenPosition` usados com argumentos validos;
- limites de complexidade.

Formato de erro:

```json
{
  "ok": false,
  "errors": [
    {
      "line": 18,
      "column": 12,
      "code": "UNKNOWN_FUNCTION",
      "message": "book.bestAsk does not exist. Did you mean book.ask?"
    }
  ],
  "warnings": []
}
```

## Biblioteca Padrao De Blocos

Bloco = funcao reutilizavel, documentada e testada.

> Fonte de verdade: esta secao e o catalogo canonico das assinaturas da biblioteca padrao GLS v1. O documento `docs/arquitetura/arquitetura-editor-estrategias.md` descreve a intencao conceitual e deve seguir estas assinaturas. Se houver divergencia, vale o que esta aqui.

Convencoes:

- `tick` e o registro do dataset `backtest_ticks` (book top-N flattenado).
- `side` e sempre `"UP"` ou `"DOWN"`.
- `samples` e o buffer de ticks recentes mantido pelo runtime.
- Blocos marcados como `[MVP]` sao obrigatorios para reescrever o `edge-sniper-v2` em GLS; os `[estendido]` podem entrar em fases seguintes.

### `market`

```text
distanceFromPtb(price, ptb)        [MVP]   distancia absoluta entre preco do ativo e price_to_beat
directionFromPtb(price, ptb)       [MVP]   "above" | "below"
sideFromPrice(price, ptb)          [MVP]   "UP" | "DOWN" (acima do PTB => UP)
isAbovePtb(price, ptb)             [MVP]
isBelowPtb(price, ptb)             [MVP]
secondsRemaining(event, ts)        [estendido]  atalho para time.secondsUntil(event.end, ts)
eventElapsedSeconds(event, ts)     [estendido]  atalho para time.secondsSince(event.start, ts)
```

Nota: `directionFromPtb` retorna a orientacao textual; `sideFromPrice` ja devolve o lado operavel. Estrategias devem preferir `sideFromPrice` para escolher o lado.

### `prices`

```text
mid(bid, ask)                      [MVP]
marketProbUp(tick)                 [MVP]   probabilidade implicita de UP a partir dos precos do book
priceForSide(side, tick)           [MVP]
oppositeSide(side)                 [MVP]
normalizedProb(probUp)             [estendido]  normaliza probabilidade UP/DOWN para somar 1
```

### `book`

```text
ask(side, tick)                    [MVP]
bid(side, tick)                    [MVP]
spread(side, tick)                 [MVP]
availableQty(side, maxPrice, tick) [MVP]
liquidityRatio(side, tick, budget) [MVP]
consumeAsks(side, shares, tick)    [estendido]  simula consumo de liquidez por niveis
```

### `signals`

```text
momentum(samples, seconds)         [MVP]
slowMomentum(samples, seconds)     [MVP]
volatility(samples, seconds)       [MVP]
directionalEdge(side, probUp, ask) [MVP]
zScore(value, mean, std)           [MVP]
trendStrength(samples, seconds)    [estendido]
```

### `risk`

```text
sizeByBudget(price, budget)             [MVP]
capOrderValue(value, max)               [MVP]
stopBid(position, bid, threshold)       [MVP]
takeProfit(position, bid, threshold)    [MVP]
trailingStop(position, bid, config)     [MVP]
sizeByLiquidity(side, tick, budget)     [estendido]
stopReverseTrigger(ctx)                 [estendido]  ver nota abaixo
```

Nota sobre stop-reverse: o `edge-sniper-v2` nativo (`src/strategies/stopReverse.js`) usa uma assinatura rica (`tick`, `priceToBeat`, `positionSide`, `timeRemainingSec`, `attempts`, `params`). O bloco GLS `[estendido]` deve encapsular essa logica; nao confundir com a API de ordens `reverse()`.

### `time`

```text
secondsUntil(end, ts)              [MVP]
secondsSince(start, ts)            [MVP]
inWindow(secondsLeft, start, end)  [MVP]
isNearExpiry(secondsLeft, threshold) [MVP]
```

### `debug`

```text
log(name, value)                   [MVP]
mark(name, data)                   [MVP]
metric(name, value)                [MVP]
```

## Runtime

Convencao de pastas do Backtest Studio (codigo futuro):

```text
src/backtestStudio/
  runtime/
    parser.js
    validator.js
    interpreter.js
    standardLibrary.js
    orderSimulator.js
    traceCollector.js
  state/
    strategies.js
    eventTraces.js
```

`src/strategies/` permanece apenas como registry nativo transitorio/golden test ate B7. Novo codigo do Studio deve viver em `src/backtestStudio/`.

### Contexto Por Run

```js
{
  params,
  runState,
  limits,
  standardLibrary,
  traceCollector
}
```

### Contexto Por Evento

```js
{
  event,
  state,
  position,
  samples,
  orders,
  marks,
  logs,
  metrics
}
```

### Hooks

Ordem:

```text
onEventStart(event)
onTick(tick, event) para cada tick
onEventEnd(event)
```

Se hook ausente:

- `onEventStart`: no-op;
- `onTick`: obrigatorio para estrategia util, mas pode ser no-op em validacao inicial;
- `onEventEnd`: no-op com fechamento automatico opcional configurado.

## Simulador De Ordens

### API Para Estrategia

```js
enter(side, { price, budget, reason })
exit({ price, reason })
reverse(side, { price, budget, reason })
closeOpenPosition({ reason })
```

### Modelo MVP

- uma posicao por evento;
- compra no ask;
- venda no bid;
- sem fee no primeiro MVP, mas campo reservado;
- slippage configuravel;
- size por budget;
- consumo de liquidez simples usando book top-N;
- partial fill pode ficar para fase futura.

### Ordem Registrada

```json
{
  "type": "entry",
  "side": "UP",
  "ts": "2026-05-29T19:12:30.000Z",
  "price": 0.52,
  "shares": 20,
  "notional": 10.4,
  "reason": "distance_edge_entry"
}
```

## Trace Collector

O trace deve explicar a execucao.

### Marks

```json
{
  "ts": "2026-05-29T19:12:30.000Z",
  "name": "entry_candidate",
  "data": { "distance": 55, "edge": 0.08 }
}
```

### Logs

```json
{
  "ts": "2026-05-29T19:12:30.000Z",
  "level": "info",
  "name": "decision",
  "value": "entered UP"
}
```

### Metrics

```json
{
  "edge": [
    { "ts": "...", "value": 0.08 }
  ],
  "spread": [
    { "ts": "...", "value": 0.03 }
  ]
}
```

## Limites De Seguranca

Configurar por run:

```text
maxTicks
maxEvents
maxRuntimeMs
maxEventRuntimeMs
maxLogsPerEvent
maxMarksPerEvent
maxOrdersPerEvent
maxOperationsPerTick
```

Defaults sugeridos:

```json
{
  "maxRuntimeMs": 120000,
  "maxEventRuntimeMs": 5000,
  "maxLogsPerEvent": 200,
  "maxMarksPerEvent": 200,
  "maxOrdersPerEvent": 20,
  "maxOperationsPerTick": 10000
}
```

Status de falha:

```text
failed_validation
failed_runtime
failed_resource_limit
failed_data_not_ready
```

## API

### Strategies

```text
GET    /api/strategies
POST   /api/strategies
GET    /api/strategies/:id
PATCH  /api/strategies/:id
GET    /api/strategies/:id/versions
POST   /api/strategies/:id/versions
GET    /api/strategies/:id/versions/:versionId
POST   /api/strategies/validate
```

### Blocks

```text
GET /api/strategy-blocks
```

No MVP, blocos podem ser read-only e vir da standard library.

### Backtests

```text
POST /api/backtest/run
GET  /api/backtest/runs
GET  /api/backtest/runs/:id
GET  /api/backtest/runs/:id/events
GET  /api/backtest/runs/:id/events/:eventTraceId
GET  /api/backtest/runs/:id/chart-data?condition_id=...
```

## Request Para Executar Estrategia Salva

```json
{
  "strategy_id": 12,
  "strategy_version_id": 44,
  "from": "2026-05-29",
  "to": "2026-05-30",
  "underlying": "BTC",
  "interval": "5m",
  "book_depth": 10,
  "batch_size": 5000,
  "params": {
    "minDistanceAbs": 50,
    "maxAsk": 0.58
  },
  "trace": true
}
```

## Response De Run

```json
{
  "run": {
    "id": 100,
    "strategy_id": 12,
    "strategy_version_id": 44,
    "status": "completed",
    "ticks": 5729,
    "batches": 2,
    "summary": {
      "totalEvents": 11,
      "totalEntries": 3,
      "wins": 1,
      "losses": 2,
      "totalPnl": -4.2
    }
  }
}
```

## DATA_NOT_READY

Antes de executar qualquer estrategia, a API deve chamar availability strict.

Se faltar dado:

```http
409 Conflict
```

```json
{
  "error": {
    "code": "DATA_NOT_READY",
    "message": "Backtest data is not ready for strict execution"
  },
  "availability": {},
  "preparation": []
}
```

## UI

### Rotas/Telas Sugeridas

```text
/                         dashboard atual
/strategies               lista de estrategias
/strategies/:id           editor
/runs                     historico de runs
/runs/:id                 resultado do run
/runs/:id/events/:eventId event explorer
```

Se a UI continuar single-page sem roteador, usar hash:

```text
#strategies
#strategy/12
#run/100
#event/100/condition-id
```

## Tela De Estrategias

Funcionalidades:

- listar estrategias;
- criar nova;
- duplicar;
- arquivar;
- abrir ultima versao;
- ver status;
- ver tags.

## Editor

Componentes:

- editor de codigo;
- painel de parametros detectados;
- painel de blocos disponiveis;
- botao validar;
- botao salvar nova versao;
- seletor de dataset/range;
- botao preparar dados;
- botao executar backtest.

Biblioteca sugerida:

- CodeMirror para MVP;
- Monaco se autocomplete mais avancado for necessario.

## Event Explorer

### Dados Necessarios

- ticks do evento;
- price_to_beat;
- underlying_price;
- up/down price;
- bid/ask;
- orders;
- marks;
- metrics;
- logs.

### Graficos MVP

1. BTC/ETH vs price_to_beat.
2. UP/DOWN price.
3. Bid/ask do lado operado.
4. Marcadores de entry/exit/stop/take profit.

### Tabela Por Evento

Colunas:

```text
event_start
condition_id
entries
exits
side
pnl
result
reason
ticks_count
```

Filtros:

```text
all
entries only
wins
losses
no_entry
errors
```

## Chart Data

Endpoint:

```text
GET /api/backtest/runs/:id/chart-data?condition_id=...
```

Response:

```json
{
  "event": {},
  "series": {
    "underlying": [],
    "priceToBeat": [],
    "upPrice": [],
    "downPrice": [],
    "bid": [],
    "ask": []
  },
  "orders": [],
  "marks": [],
  "logs": [],
  "metrics": {}
}
```

## Implementacao Em Fases

> Status (jun/2026): todas as fases abaixo estao **concluidas no MVP**. A tabela resumida no topo deste documento e a referencia operacional. Lacunas pos-MVP: autocomplete rico, diff entre versoes, comparador visual de runs, otimizador/tuning de parametros.

### Pre-B1: Traces E Endpoints De Run — concluido

- [x] Extrair/normalizar eventos do runner nativo para `backtest_event_traces` (`src/backtestStudio/state/eventTraces.js`).
- [x] Criar `GET /api/backtest/runs/:id`.
- [x] Criar `GET /api/backtest/runs/:id/events` e `GET /api/backtest/runs/:id/events/:eventTraceId`.
- [x] Criar Event Explorer basico na UI (lista + detalhe de um evento).
- [x] Preparar `GET /api/backtest/runs/:id/chart-data?condition_id=...` para graficos.

### Fase B1: Persistencia De Estrategias — concluido

- [x] Criar tabelas `strategy_definitions` e `strategy_versions`.
- [x] Criar helpers em `src/backtestStudio/state/strategies.js`.
- [x] Criar CRUD API.
- [x] Criar testes de CRUD.
- [x] Criar seed opcional com `edge-sniper-v2` como referencia textual.

### Fase B2: Editor UI — concluido (MVP)

- [x] Adicionar tela/lista de estrategias.
- [x] Adicionar editor simples (CodeMirror).
- [x] Salvar nova versao.
- [x] Abrir versao existente.
- [x] Mostrar parametros detectados de forma simples.
- [x] Testar static UI/API.
- [ ] Autocomplete rico e diff entre versoes (pos-MVP).

### Fase B3: Validador GLS MVP — concluido

- [x] Definir sintaxe minima.
- [x] Implementar parser.
- [x] Implementar validator.
- [x] Expor `POST /api/strategies/validate`.
- [x] Mostrar erros no editor.
- [x] Testar casos validos/invalidos.

### Fase B4: Runtime GLS MVP — concluido

- [x] Implementar interpreter.
- [x] Implementar standard library inicial.
- [x] Implementar order simulator.
- [x] Implementar trace collector.
- [x] Rodar estrategia simples sobre ticks mockados.
- [x] Testar determinismo.

### Fase B5: Execucao Sobre Lakehouse — concluido

- [x] Integrar runtime com `DuckDbTickProvider`.
- [x] Bloquear sem availability strict.
- [x] Persistir run com strategy/version snapshot.
- [x] Persistir event traces.
- [x] Expor detalhes do run.
- [x] Testar com Parquet pequeno.

### Fase B6: Visualizacao — concluido

- [x] Tela de run detail.
- [x] Tabela de eventos.
- [x] Event explorer.
- [x] Chart BTC vs PTB.
- [x] Markers de ordens/marks.
- [x] Logs por evento.
- [ ] Comparador visual entre runs (pos-MVP).

### Fase B7: Migracao Edge Sniper — concluido (seed GLS + paridade)

- [x] Mapear blocos usados pelo nativo.
- [x] Adicionar blocos faltantes.
- [x] Reescrever edge-sniper em GLS (`src/backtestStudio/gls/strategies/edgeSniperV2.gls`).
- [x] Rodar paridade com runner nativo (`tests/edgeSniperGlsParity.test.js`).
- [x] Documentar divergencias (`docs/referencia/paridade-edge-sniper-v2.md`).

## Estrategia De Testes

### Parser/Validator

- codigo valido;
- parametro duplicado;
- funcao inexistente;
- variavel nao declarada;
- hook desconhecido;
- escrita proibida;
- JSON de params invalido.

### Runtime

- onEventStart chamado uma vez;
- onTick chamado para cada tick;
- onEventEnd chamado no final;
- entry cria ordem;
- exit fecha posicao;
- stop funciona;
- limites bloqueiam loop/uso excessivo;
- duas execucoes iguais produzem mesmo resultado.

### API

- CRUD estrategia;
- salvar versao;
- validar estrategia;
- executar sem dados retorna `DATA_NOT_READY`;
- executar com dados cria run;
- run retorna traces;
- chart-data retorna series.

### UI

- abrir lista;
- criar estrategia;
- salvar versao;
- validar e mostrar erro;
- executar backtest;
- abrir run;
- abrir evento.

## Criterios De Aceite Do Backtest Studio MVP

- Usuario cria estrategia pela UI.
- Usuario salva codigo como nova versao.
- Usuario reabre estrategia depois.
- API valida codigo e retorna erros amigaveis.
- Estrategia simples executa sobre `backtest_ticks` validado.
- Run fica salvo em `backtest_runs`.
- Event traces ficam salvos.
- UI mostra resumo do run.
- UI mostra lista de eventos.
- UI mostra grafico de um evento com entry/exit.
- Backtest bloqueia quando dados nao estao prontos.
- `edge-sniper-v2` nativo continua funcionando como golden test.

## Fora Do MVP

- editor visual de blocos;
- JavaScript arbitrario;
- live trading;
- multi-estrategia portfolio;
- otimizador genetico;
- partial fill complexo;
- fila real de order book;
- permissao de rede/filesystem.

## Ordem Recomendada Imediata

0. Normalizar traces a partir do runner nativo (`backtest_event_traces`), sem duplicar o que ja existe em `result_json`.
1. Implementar `backtest_event_traces` para o runner nativo atual.
2. Criar endpoints de detalhes do run (`GET /api/backtest/runs/:id`, eventos e detalhe por `eventTraceId`).
3. Criar Event Explorer basico.
4. Criar CRUD de estrategias.
5. Criar editor simples.
6. Criar GLS MVP.
7. Executar estrategia simples salva.
8. Migrar `edge-sniper-v2` para GLS.

Motivo:

```text
Antes de programar estrategias novas, precisamos conseguir explicar visualmente o que um run fez.
```
