# Arquitetura Do Backtest Studio Programavel

## Objetivo

Transformar o `data-backtest` em um ambiente controlado de criacao, execucao, comparacao e visualizacao de estrategias versionadas, sem prender o sistema a uma estrategia especifica como `edge-sniper-v2`.

O objetivo nao e apenas ter estrategias hardcoded no codigo do projeto. O objetivo e ter um sistema onde o usuario possa:

- criar uma estrategia dentro da propria UI;
- editar a logica em um editor de codigo simples;
- reutilizar funcoes/blocos comuns;
- salvar a estrategia;
- abrir versoes anteriores;
- executar em qualquer range de dados disponivel no lakehouse;
- ver resultado agregado;
- ver cada evento individual;
- ver pontos de entrada, saida, stop, take profit, reversao e logs sobre o grafico;
- comparar runs e parametros.

Referencia mental: algo parecido com MetaTrader/TradingView para execucao reproduzivel, mas focado no dominio GoldenLens/Polymarket crypto-updown e usando o lakehouse Parquet/DuckDB como fonte.

Este documento nao descreve os laboratorios livres de pesquisa. Laboratorios devem existir como Research Labs externos, usando framework/scripts/notebooks para descoberta de estrategias. O Backtest Studio recebe estrategias candidatas quando elas precisam virar codigo salvo, versionado, executavel e comparavel.

## Separacao De Responsabilidades

O sistema fica dividido em camadas:

```text
data-colector
  coleta oficial
  Postgres operacional
  archive status
  retencao opcional desativada por padrao

data-backtest lakehouse
  sync do Postgres
  Parquet validado
  lake_manifest
  DuckDB query layer

data-backtest Backtest Studio
  editor de codigo (UI)
  biblioteca de blocos/funcoes
  compilador/validador
  engine programavel
  backtest runs
  trace por evento
  visualizacao
```

Regra principal:

```text
O Backtest Studio nunca le direto do Postgres.
Ele executa sobre datasets validos resolvidos pelo lake_manifest.
```

## Research Labs Externos

Laboratorios sao ambientes de estudo e descoberta. Eles podem usar diversos recursos, frameworks, notebooks, scripts, tuning, otimizacao e fontes auxiliares.

Eles nao devem ficar dentro do Backtest Studio porque possuem objetivos diferentes:

- Research Labs aceitam experimentacao rapida e codigo descartavel.
- Backtest Studio exige estrategia salva, versionada, reproduzivel e explicavel.
- Research Labs podem quebrar e mudar rapido.
- Backtest Studio deve ser estavel para comparar resultados.

Contrato entre eles:

```text
Research Labs externos
  usam lakehouse/API/framework
  descobrem ideias
  geram estrategia candidata

Backtest Studio
  recebe a candidata
  salva versao
  valida codigo
  executa em dados strict
  registra run e trace
```

## Problema Atual

Hoje temos `edge-sniper-v2` nativa dentro do codigo.

Isso foi correto como primeiro passo porque:

- serviu como golden test;
- validou o lakehouse;
- validou `backtest_ticks`;
- provou que DuckDB + Parquet alimenta um backtest real.

Mas isso nao deve virar o modelo final.

O modelo final precisa permitir que novas estrategias sejam escritas e modificadas sem alterar o codigo fonte do `data-backtest`.

## Modelo Alvo

Uma estrategia passa a ser um documento salvo no sistema.

Ela contem:

- nome;
- descricao;
- codigo fonte;
- parametros editaveis;
- versao;
- tags;
- autor/origem;
- data de criacao;
- data de ultima alteracao;
- status: `draft`, `validated`, `archived`;
- engine/language version usada para executar.

Exemplo conceitual:

```text
Strategy
  id: 12
  slug: edge-sniper-experimental
  version: 4
  language: gls-v1
  source: codigo da estrategia
  params_schema: parametros editaveis
  created_at
  updated_at
```

## Linguagem Da Estrategia

### Decisao Recomendada

Criar uma linguagem simples propria, inicialmente pequena, chamada aqui de `GLS` (`GoldenLens Strategy`).

Ela deve parecer uma linguagem de programacao comum, mas com API limitada e segura.

Nao devemos comecar permitindo JavaScript livre no servidor, porque isso abre riscos:

- acesso indevido a arquivos;
- acesso a rede;
- loops infinitos sem controle;
- uso excessivo de memoria;
- dependencia de APIs internas do Node;
- dificuldade de reproduzir runs no futuro.

Em vez disso, a estrategia deve rodar em um runtime controlado.

### Caracteristicas Da GLS V1

- Sintaxe parecida com JavaScript/PineScript, mas menor.
- Sem acesso a filesystem, rede ou variaveis de ambiente.
- Sem import arbitrario.
- Sem `eval`.
- Sem async.
- Sem estado global fora do contexto do run.
- Funcoes puras sempre que possivel.
- Hooks fixos: `onEventStart`, `onTick`, `onEventEnd`.
- API de ordens controlada: `enter`, `exit`, `reverse`, `mark`, `log`.
- Biblioteca padrao de blocos disponivel por namespace.
- Limites de execucao por tick/evento.

## Exemplo De Estrategia

Exemplo didatico de codigo no editor:

```js
strategy "PTB Momentum" {
  param minDistanceAbs = 50
  param minEdge = 0.07
  param maxAsk = 0.58
  param stopBid = 0.18
  param takeProfitBid = 0.92
  param maxOrderValue = 15

  onEventStart(event) {
    state.lastPrice = null
    state.entered = false
  }

  onTick(tick, event) {
    let secondsLeft = time.secondsUntil(event.end, tick.ts)
    let distance = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
    let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
    let probUp = prices.marketProbUp(tick)
    let ask = book.ask(side, tick)
    let bid = book.bid(side, tick)
    let edge = signals.directionalEdge(side, probUp, ask)

    if (!state.entered && secondsLeft <= 105 && secondsLeft >= 4) {
      if (distance >= params.minDistanceAbs && edge >= params.minEdge && ask <= params.maxAsk) {
        enter(side, {
          price: ask,
          budget: params.maxOrderValue,
          reason: "distance_edge_entry"
        })
        state.entered = true
        mark("entry_candidate")
      }
    }

    if (position.open) {
      if (bid <= params.stopBid) {
        exit({ price: bid, reason: "stop_bid" })
      }
      if (bid >= params.takeProfitBid) {
        exit({ price: bid, reason: "take_profit" })
      }
    }
  }

  onEventEnd(event) {
    closeOpenPosition({ reason: "event_end" })
  }
}
```

O usuario ve codigo, mas o sistema entende isso como uma arvore de execucao controlada.

## Blocos/Funcoes Reutilizaveis

O termo "bloco" nao precisa significar blocos visuais estilo Scratch. No nosso caso, o melhor caminho inicial e:

```text
bloco = funcao reutilizavel documentada + testada + disponivel no editor
```

O usuario programa com funcoes prontas.

Exemplos:

```js
market.distanceFromPtb(price, ptb)
market.sideFromPrice(price, ptb)
prices.marketProbUp(tick)
book.ask("UP", tick)
book.bid("DOWN", tick)
book.spread("UP", tick)
book.availableQty("UP", maxPrice, tick)
signals.momentum(samples, seconds)
signals.volatility(samples, seconds)
risk.sizeByBudget(price, budget)
risk.sizeByLiquidity(side, tick, budget)
time.secondsUntil(event.end, tick.ts)
time.inWindow(secondsLeft, start, end)
```

Assim, a estrategia fica didatica e modificavel, mas a parte dificil fica encapsulada em blocos confiaveis.

## Categorias De Blocos

> As assinaturas canonicas (com argumentos e a separacao MVP vs estendido) ficam em `docs/implementacao-editor-backtest.md`, secao "Biblioteca Padrao De Blocos". Esta secao e a visao conceitual por categoria. Em caso de divergencia, vale o documento de implementacao.

### `market`

Funcoes relacionadas ao mercado/evento.

```text
distanceFromPtb
directionFromPtb
sideFromPrice
isAbovePtb
isBelowPtb
eventElapsedSeconds
secondsRemaining
```

### `prices`

Funcoes de preco UP/DOWN.

```text
mid
marketProbUp
normalizedProb
priceForSide
oppositeSide
```

### `book`

Funcoes sobre order book.

```text
ask
bid
spread
availableQty
liquidityRatio
consumeAsks
```

### `signals`

Indicadores e sinais.

```text
momentum
slowMomentum
volatility
zScore
directionalEdge
trendStrength
```

### `risk`

Tamanho, stop e gestao.

```text
sizeByBudget
sizeByLiquidity
capOrderValue
stopBid
takeProfit
trailingStop
stopReverseTrigger
```

### `time`

Janelas temporais.

```text
secondsUntil
secondsSince
inWindow
isNearExpiry
```

### `debug`

Observabilidade da estrategia.

```text
log
mark
metric
```

## Hooks Da Estrategia

### `onEventStart(event)`

Chamado uma vez no inicio de cada evento.

Uso:

- inicializar estado do evento;
- zerar buffers;
- definir variaveis temporarias.

### `onTick(tick, event)`

Chamado para cada tick do evento.

Uso:

- calcular sinais;
- abrir posicao;
- fechar posicao;
- marcar pontos no grafico;
- registrar logs.

### `onEventEnd(event)`

Chamado no fim do evento.

Uso:

- fechar posicoes abertas;
- registrar motivo final;
- calcular metricas finais do evento.

## API Disponivel Dentro Da Estrategia

### Estado

```js
state.foo = 123
```

`state` e isolado por run/evento conforme configuracao do runtime.

Recomendacao V1:

- `state` e reiniciado por evento;
- se precisarmos de memoria entre eventos, criar `runState` explicitamente depois.

### Posicao Atual

```js
position.open
position.side
position.entryPrice
position.shares
position.pnl
```

### Ordens Simuladas

```js
enter("UP", { price, budget, reason })
exit({ price, reason })
reverse("DOWN", { price, budget, reason })
closeOpenPosition({ reason })
```

Essas funcoes nao executam mercado real. Elas apenas criam eventos simulados no backtest.

### Marcacoes Para Grafico

```js
mark("entry_candidate")
mark("stop_zone", { color: "red" })
log("distance", distance)
metric("edge", edge)
```

Essas chamadas alimentam o trace visual.

## Trace De Execucao

Para cada run, o sistema deve registrar nao apenas o resultado final, mas tambem o que aconteceu.

Exemplo:

```text
backtest_run
  summary
  events
  equity

backtest_event_traces
  run_id
  condition_id
  event_start
  ticks_count
  entries
  exits
  marks
  logs
  metrics
  final_pnl
```

O trace permite responder perguntas como:

- por que entrou nesse evento?
- por que nao entrou?
- qual condicao falhou?
- onde estava o preco do BTC?
- qual era o spread?
- qual era a liquidez?
- quando bateu stop?
- quando teria revertido?

## Visualizacao Por Evento

A tela de resultado deve ter dois niveis.

### Nivel 1: Resumo Do Run

Mostrar:

- estrategia;
- versao;
- parametros;
- dataset usado;
- range;
- total de eventos;
- entradas;
- wins;
- losses;
- PnL;
- max drawdown;
- media por evento;
- tempo de execucao;
- quantidade de ticks lidos.

### Nivel 2: Event Explorer

Para cada evento:

- grafico do preco do ativo vs `price_to_beat`;
- linha vertical de entrada;
- linha vertical de saida;
- marcadores de stop/take profit/reverse;
- serie UP/DOWN;
- spread;
- liquidez;
- logs da estrategia;
- motivo da decisao;
- resultado do evento.

Representacao conceitual:

```text
BTC price
  |              entry
  |                v
  |       /
  |      /  \          exit
  | ----/----\----------v-------- price_to_beat
  |
  +-------------------------------- time

Markers:
  entry_candidate
  entry_filled
  stop_bid
  take_profit
```

## Persistencia Recomendada

Adicionar tabelas ao SQLite do `data-backtest`.

### `strategy_definitions`

```text
id
slug
name
description
status
created_at
updated_at
```

### `strategy_versions`

```text
id
strategy_id
version
language
source_code
params_schema_json
compiled_json
validation_json
created_at
```

`created_by` fica reservado para autenticacao futura; nao entra no MVP.

### `strategy_blocks`

Para funcoes/blocos criados pelo usuario no futuro.

```text
id
slug
name
category
language
source_code
signature_json
description
status
created_at
updated_at
```

### `backtest_runs`

Ja existe base inicial. Hoje persiste `summary_json` e um `result_json` com `events`, `equity` e `log` do runner nativo.

Deve evoluir para guardar:

```text
id
strategy_id
strategy_version_id
strategy_snapshot_json
dataset_request_json
params_json
summary_json
result_json
created_at
```

### `backtest_event_traces`

```text
id
run_id
condition_id
event_start
event_end
summary_json
orders_json
marks_json
logs_json
metrics_json
chart_series_path nullable
created_at
```

Observacao: traces grandes podem ir para Parquet/JSONL no lakehouse, e o SQLite guarda apenas ponteiros.

## Arquivos De Trace No Lakehouse

Para runs grandes, nao colocar tudo no SQLite.

Layout sugerido:

```text
/lake/backtest_runs/run_id=<id>/
  summary.json
  events.parquet
  orders.parquet
  marks.parquet
  metrics.parquet
  logs.jsonl
```

O SQLite guarda metadados e paths.

## Editor Na UI

### MVP

Usar um editor de codigo no browser, como CodeMirror ou Monaco.

Funcionalidades iniciais:

- criar estrategia;
- abrir estrategia;
- salvar nova versao;
- validar codigo;
- listar parametros;
- executar backtest;
- ver resumo;
- ver eventos;
- ver logs.

### UX Alvo

Tela proposta:

```text
Estrategias
  lista lateral
  botao nova estrategia
  status draft/validated

Editor
  codigo
  parametros detectados
  erros de validacao
  autocomplete de blocos

Backtest
  dataset/range/book_depth
  botao preparar dados
  botao executar

Resultados
  resumo
  equity
  tabela de eventos
  event explorer
```

## Validacao Do Codigo

Antes de executar, o sistema deve validar:

- sintaxe;
- hooks obrigatorios/opcionais;
- parametros duplicados;
- chamadas a funcoes inexistentes;
- tipos basicos;
- uso de variaveis nao definidas;
- limites de complexidade;
- compatibilidade com a versao da linguagem;
- datasets necessarios.

Exemplo de erro:

```text
Line 18: function book.bestAsk does not exist. Did you mean book.ask?
```

## Execucao Segura

Cada run deve ter limites:

- maximo de ticks;
- maximo de eventos;
- timeout por run;
- timeout por evento;
- limite de memoria;
- limite de logs por evento;
- limite de marks por evento;
- limite de operacoes por tick.

Se passar do limite, o run falha com status controlado:

```text
failed_resource_limit
```

## Modelo De Ordens Simuladas

Inicialmente o motor pode continuar simples:

- entrada compra no ask;
- saida vende no bid;
- slippage configuravel;
- consumo de liquidez usando book top-N;
- uma posicao por evento;
- sem alavancagem.

Depois pode evoluir para:

- multiplas entradas;
- partial fill;
- scale-in/scale-out;
- fee model;
- latency model;
- fila no order book;
- simulacao de cancelamento.

## Como O Edge Sniper Entra Nesse Modelo

`edge-sniper-v2` nao deve ser o centro da arquitetura.

Ele deve virar uma estrategia salva no novo sistema.

Fases:

1. Manter `edge-sniper-v2` nativo como golden test.
2. Implementar blocos equivalentes ao que ele usa hoje.
3. Reescrever `edge-sniper-v2` em GLS.
4. Comparar resultado GLS vs nativo.
5. Quando houver paridade, tratar a versao GLS como estrategia editavel principal.
6. Manter o nativo apenas como teste/regressao ou remover depois.

## Relacao Com Blocos Visuais

Nao devemos comecar com editor visual de blocos.

Motivo:

- estrategias ficam complexas rapidamente;
- codigo textual e mais rapido para iterar;
- fica mais facil versionar;
- fica mais facil copiar/colar;
- fica mais facil comparar diffs.

Mas a arquitetura deve permitir um editor visual no futuro.

Como?

```text
codigo GLS <-> AST <-> blocos visuais
```

Se a linguagem tiver AST bem definida, podemos criar visualizacao em blocos depois sem reescrever o engine.

## APIs Futuras

### Estrategias

```text
GET    /api/strategies
POST   /api/strategies
GET    /api/strategies/:id
PATCH  /api/strategies/:id
POST   /api/strategies/:id/versions
GET    /api/strategies/:id/versions
POST   /api/strategies/validate
```

### Blocos

```text
GET    /api/strategy-blocks
POST   /api/strategy-blocks
GET    /api/strategy-blocks/:id
PATCH  /api/strategy-blocks/:id
```

### Backtests

```text
POST   /api/backtest/run
GET    /api/backtest/runs
GET    /api/backtest/runs/:id
GET    /api/backtest/runs/:id/events
GET    /api/backtest/runs/:id/events/:eventTraceId
GET    /api/backtest/runs/:id/chart-data?condition_id=...
```

Detalhe de evento usa `eventTraceId` (PK de `backtest_event_traces`). `chart-data` continua filtrando por `condition_id`.

## Fases De Implementacao

> Equivalencia com `docs/implementacao-editor-backtest.md`: Fase A→B1, B→B3, C→B4, D→B5, E→B6, F→B7, G→pos-MVP.

### Fase A: Fundacao Do Backtest Studio — pendente (B1; traces em pre-B1)

- Criar tabelas `strategy_definitions` e `strategy_versions`.
- Criar CRUD basico de estrategias.
- Criar tela simples com lista e editor.
- Salvar codigo como texto.
- Criar versoes imutaveis ao salvar.

### Fase B: Linguagem GLS V1 — pendente (B3)

- Definir gramatica minima.
- Criar parser.
- Criar validador.
- Criar AST.
- Criar interpretador seguro.
- Implementar `params`, `state`, `position`, `onEventStart`, `onTick`, `onEventEnd`.

### Fase C: Biblioteca Padrao De Blocos — pendente (B4)

- Implementar blocos `market`.
- Implementar blocos `prices`.
- Implementar blocos `book`.
- Implementar blocos `signals`.
- Implementar blocos `risk`.
- Implementar blocos `time`.
- Documentar cada bloco no autocomplete.

### Fase D: Engine Programavel — pendente (B5)

- Criar runner que executa GLS sobre `DuckDbTickProvider`.
- Garantir modo strict antes de rodar.
- Registrar resumo do run.
- Registrar eventos e ordens.
- Registrar logs/marks/metrics.
- Aplicar limites de seguranca.

### Fase E: Visualizacao — pendente (pre-B1 + B6)

- Tela de resumo do run.
- Tabela de eventos.
- Event explorer.
- Grafico BTC vs PTB.
- Marcadores de entrada/saida/stop/take profit.
- Logs por tick/evento.

### Fase F: Migracao Do Edge Sniper — pendente (B7)

O nativo usa stop-reverse interno (`src/strategies/stopReverse.js`), nao a API GLS `reverse()`. Na migracao, mapear para blocos `risk.stopReverseTrigger` / budget equivalentes ou manter logica encapsulada no simulador.

- Mapear todos os componentes usados pelo `edge-sniper-v2` nativo.
- Criar blocos equivalentes.
- Reescrever em GLS.
- Rodar paridade contra o nativo.
- Registrar diferencas esperadas.

### Fase G: Estrategias Do Usuario — pos-MVP

- Permitir duplicar estrategia.
- Permitir comparar versoes.
- Permitir comparar parametros.
- Permitir exportar/importar estrategia como arquivo.
- Permitir marcar versao como `validated`.

## MVP Recomendado

Para nao travar em uma linguagem grande demais, o MVP deve ser:

1. CRUD de estrategia com codigo salvo.
2. Editor CodeMirror/Monaco.
3. Validador simples.
4. Runtime GLS minimo.
5. Blocos suficientes para reescrever parte do `edge-sniper-v2`.
6. Execucao em `backtest_ticks` validado.
7. Persistencia de run.
8. Trace basico: entradas, saidas, marks e logs.
9. Event explorer simples.

Nao incluir no MVP:

- editor visual de blocos;
- multi-asset complexo;
- live trading;
- permissao para JS arbitrario;
- otimizador genetico;
- portfolio multi-estrategia.

## Criterios De Aceite

- Uma estrategia pode ser criada pela UI.
- O codigo pode ser salvo e reaberto.
- Cada alteracao salva cria uma versao rastreavel.
- O sistema valida sintaxe antes de executar.
- O backtest bloqueia se os dados nao estiverem prontos no manifest.
- A estrategia executa sobre `backtest_ticks` via DuckDB.
- O run fica salvo em `backtest_runs`.
- Cada evento tem trace suficiente para explicar a decisao.
- A UI mostra grafico do evento com entrada e saida.
- O usuario consegue duplicar uma estrategia e alterar parametros/codigo.
- O `edge-sniper-v2` pode ser reimplementado nessa linguagem com resultado comparavel ao nativo.

## Decisoes Em Aberto

- Nome final da linguagem: `GLS`, `GoldenScript`, `StrategyScript` ou outro.
- Usar parser proprio pequeno ou uma sintaxe baseada em JavaScript restrito.
- Guardar traces grandes em SQLite, JSONL ou Parquet.
- Primeiro grafico: biblioteca simples customizada, Lightweight Charts ou outra.
- Nivel de tipagem da linguagem V1.
- Se blocos criados pelo usuario entram na V1 ou somente depois da linguagem estabilizar.

## Resumo

O `data-backtest` deve evoluir de "um lugar que roda edge-sniper-v2" para um Backtest Studio programavel de estrategias versionadas.

O lakehouse continua sendo a base de dados confiavel.

O Backtest Studio fica acima dele.

As estrategias viram codigo salvo, versionado e executavel.

Os blocos viram funcoes reutilizaveis que deixam o codigo simples e didatico.

Os backtests deixam de retornar apenas PnL e passam a explicar cada decisao tomada em cada evento.
