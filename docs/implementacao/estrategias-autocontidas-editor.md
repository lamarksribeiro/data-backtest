# Estrategias Autocontidas No Editor

Status: documento operacional para concluir o desacoplamento de estrategias no `data-backtest`.

Data: 2026-06-19.

Objetivo: permitir que qualquer estrategia nova ou antiga seja criada, salva, validada e executada no Backtest Studio apenas pelo editor, sem alterar o motor de backtest, sem criar arquivo novo no repositorio e sem fazer deploy para mudar logica de estrategia.

## 1. Decisao Principal

O Backtest Studio deve funcionar como uma plataforma de estrategias, parecido com a separacao mental do MetaTrader:

| Camada | Responsabilidade | Pode conter regra de estrategia? |
|---|---|---|
| Lakehouse | Dados historicos, manifest, disponibilidade, DuckDB/Parquet, cobertura | Nao |
| Motor de backtest | Loop temporal, eventos, ticks, order simulator, fees, portfolio, traces, metricas, isolamento de job | Nao |
| Runtime de estrategia | Parser, validador, compilador, sandbox, API publica estavel | Nao, apenas primitivas genericas |
| Estrategia salva | Codigo fonte, parametros default, hooks, helpers, dependencias declaradas, versao | Sim |
| Preset | Valores de parametros para uma versao de codigo | Sim, como configuracao da estrategia |
| Biblioteca versionada | Funcoes reutilizaveis declaradas pela estrategia | Sim, se for dependencia explicita e versionada |

Regra de ouro:

```text
Uma estrategia nova nao pode exigir alteracao em src/backtest, src/backtestStudio/gls/standardLibrary.js,
src/backtestStudio/gls/blocks.js, src/strategies ou qualquer runner especifico do motor.
```

O que pode continuar dentro do backtest:

```text
- acesso a dados dos ativos;
- normalizacao de tick/evento;
- calendario/janela do dataset;
- simulacao de ordens e posicoes;
- modelo de taxas/fees;
- leitura de book e scalars;
- validacao de cobertura;
- runtime seguro e deterministico;
- primitivas genericas documentadas.
```

O que nao pode ficar escondido no backtest:

```text
- decisao de entrada/saida de uma estrategia;
- score especifico de uma familia;
- filtro especifico de uma estrategia;
- roteamento por nome de estrategia;
- parametros campeoes hardcoded;
- dependencias invisiveis carregadas automaticamente sem snapshot no run.
```

## 2. Estado Atual Real

O projeto ja esta muito mais perto do alvo do que a documentacao historica indicava. O que existe hoje:

| Area | Estado atual | Arquivos principais |
|---|---|---|
| Strategy JS | Implementado como linguagem principal de autoria | `src/backtestStudio/strategyJs/*` |
| Parser seguro | Acorn, limite de tamanho, limite de AST, wrapper `strategy({...})` | `strategyJs/parser.js` |
| Validador | Bloqueia import, require, eval, async, Date.now, Math.random, rede, timers, acesso dinamico a tick | `strategyJs/validator.js` |
| Lowering | Strategy JS baixa para AST GLS para reutilizar o runtime atual | `strategyJs/lowerToGlsAst.js` |
| Helpers | Funcoes auxiliares puras de topo podem ser inlinadas antes da analise | `strategyJs/inlineHelpers.js` |
| Compilacao | Gera metadados `compiled_json`, analise de colunas, paralelismo e checksum | `strategyJs/compile.js` |
| Persistencia | `strategy_versions` guarda `language`, `source_code`, `params_schema_json`, `compiled_json`, `validation_json`, `checksum` | `src/state/sqlite.js`, `state/strategies.js` |
| Editor UI | Novas estrategias usam Strategy JS, CodeMirror em modo JS, validacao, salvar versao, testar, runtime panel | `public/js/views/strategies.js` |
| Contrato para IA | `/api/strategy-runtime/capabilities` retorna template, blocos e contrato copiavel | `strategyJs/index.js`, `api/server.js` |
| Conversor GLS | Endpoint e funcao `glsToStrategyJs` existem | `strategyJs/glsToStrategyJs.js`, `api/server.js` |
| Presets | Tabela, API e UI para salvar parametros sem recriar codigo | `state/strategyPresets.js`, `public/js/views/strategies.js` |
| Bibliotecas nativas | Existe tabela e seed de `edge-sniper-models` como biblioteca nativa versionada | `state/strategyLibrary.js`, `nativeLibrary/*` |
| File loaders | Caminho por arquivo/modulo fica bloqueado fora de `TEST_MODE` ou flag explicita | `src/backtest/strategyLoader.js` |
| Seed automatico | Promoted strategies so rodam no boot em `TEST_MODE` ou `SEED_PROMOTED_STRATEGIES=1` | `src/server.js` |
| Scripts | Existem migracao GLS->JS, benchmark Strategy JS e verificacao no lake real | `scripts/migrate-strategies-to-js.js`, `scripts/bench-strategy-js.js`, `scripts/verify-strategy-js-backtest.js` |
| Testes | Existem suites especificas para Strategy JS, presets, biblioteca nativa e loader | `tests/strategyJs*.test.js`, `tests/strategyPresets.test.js`, `tests/strategyLibrary.test.js` |

Conclusao do estado atual:

```text
O caminho Strategy JS ja existe. O trabalho restante nao e comecar do zero.
O trabalho restante e fechar lacunas de contrato, cache, dependencias explicitas,
migracao das estrategias antigas e remover excecoes que ainda escondem logica fora do editor.
```

## 3. Arquitetura Alvo

Fluxo final de uma estrategia criada no editor:

```text
Editor
  -> source_code Strategy JS
  -> POST /api/strategies/validate
  -> parse AST JS
  -> validacao segura
  -> lowering para IR canonico
  -> analise de colunas
  -> analise de paralelismo
  -> codegen compiled-soa
  -> compiled artifact persistido
  -> strategy_version salva
  -> backtest por strategy_id + strategy_version_id + preset_id/opcional params
  -> run snapshot imutavel
  -> traces e metricas
```

O motor nao deve saber qual estrategia esta rodando. Ele deve receber um artefato validado com:

```json
{
  "language": "strategy-js-v1",
  "source_checksum": "sha256",
  "language_version": "strategy-js-v1",
  "stdlib_version": "stdlib-v3",
  "compiler_version": "compiler-soa-v2",
  "ir_checksum": "sha256",
  "dependencies": [],
  "column_analysis": {},
  "parallelism": {},
  "generated_source": "function generated...",
  "compile": {
    "ok": true,
    "mode": "compiled-soa"
  }
}
```

No curto prazo, o IR pode continuar sendo o AST GLS existente. No alvo profissional, `GLS AST` deve virar detalhe legado e as duas sintaxes devem convergir para um `Strategy IR` canonico:

```text
Strategy JS parser ----\
                     Strategy IR -> validators -> compilers -> runner
GLS legacy parser ----/
```

## 4. Contrato Da Estrategia

Toda estrategia nova deve usar este formato de autoria:

```js
export default strategy({
  name: "Minha Estrategia",

  params: {
    minDistanceAbs: 50,
    maxAsk: 0.58,
    budget: 15,
  },

  onEventStart({ state }) {
    state.entered = false;
  },

  onTick(ctx) {
    const { tick, event, state, params, position } = ctx;

    const distance = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat);
    const side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat);
    const ask = book.ask(side, tick);

    if (!state.entered && distance >= params.minDistanceAbs && ask <= params.maxAsk) {
      const bought = orders.enter(side, {
        price: ask,
        budget: params.budget,
        reason: "distance_entry",
      });

      if (bought) {
        state.entered = true;
        trace.mark("entry", { side, ask });
      }
    }
  },

  onEventEnd() {
    orders.closeOpenPosition({ reason: "event_end" });
  },
});
```

Contrato obrigatorio:

| Item | Regra |
|---|---|
| Fonte | `source_code` salvo em `strategy_versions` e nunca executado diretamente como Node.js livre |
| Hooks | `onEventStart`, `onTick`, `onEventEnd` |
| Estado | `state` por evento, `runState` por run quando a estrategia assumir perda de paralelismo |
| Ordens | `orders.enter`, `orders.exit`, `orders.reverse`, `orders.closeOpenPosition` |
| Explicabilidade | `trace.mark`, `trace.log`, `trace.metric` |
| Dados | `tick`, `event`, `position`, `params`, `samples` quando disponivel |
| Parametros | Defaults no objeto `params`, overrides via preset ou payload de run |
| Dependencias | Declaradas explicitamente e salvas no snapshot do run |
| Performance | Compilavel para `compiled-soa` ou rejeitado na validacao de producao |

Proibido:

```text
import, require, fetch, filesystem, process, env, eval, Function, async, await,
Promise, Date.now, Math.random, timers, acesso dinamico tick[field], loops sem bound,
arrays/metodos de array no hot path onTick, mutacao fora de state/runState.
```

## 5. Fronteira Do Motor

O motor deve expor uma API publica pequena e estavel. Essa API e a unica dependencia permitida para o codigo de estrategia.

| Namespace | Deve conter | Nao deve conter |
|---|---|---|
| `market` | Distancia do PTB, lado UP/DOWN, direcao, comparacoes genericas | Score de uma estrategia |
| `prices` | Probabilidade implicita, mid, preco por lado, lado oposto | Regras de entrada especificas |
| `book` | Best bid/ask, spread, liquidez agregada, profundidade | Filtros campeoes de uma estrategia |
| `time` | Janela, segundos ate fim, segundos desde inicio | Decisao de timing de uma estrategia |
| `risk` | Sizing generico, cap, stops genericos | Plano de risco especifico e parametrizado sem estar no codigo da estrategia |
| `math` | Funcoes puras deterministicas | Aleatoriedade ou funcoes nao whitelisted |
| `orders` | Simulacao de ordens | Regra de quando operar |
| `trace` | Logs, marks, metricas | Calculo oculto de decisao |

`model.*` nao deve ser um namespace generico para logica especifica de estrategia. Se uma funcao for realmente um modelo de estrategia, ela deve virar dependencia explicita versionada.

## 6. Dependencias Versionadas

Existe um meio termo profissional entre colocar tudo dentro do motor e colocar codigo pesado no Strategy JS:

```text
biblioteca versionada = dependencia explicita da estrategia, com slug, versao,
checksum, contrato e snapshot no run.
```

Isso e aceitavel para modelos numericos pesados quando:

```text
- a estrategia declara a dependencia;
- a dependencia aparece no snapshot do run;
- existe versao imutavel;
- existe teste de paridade;
- a funcao nao e carregada implicitamente pelo motor para todas as estrategias;
- o usuario sabe que parte da logica vive em uma biblioteca versionada.
```

Estado atual:

```text
edge-sniper-models v1 ja existe como biblioteca nativa seedada,
mas standardLibrary ainda injeta esses modelos automaticamente em model.*.
```

Alvo:

```js
export default strategy({
  name: "Edge Sniper V3",
  dependencies: {
    edgeModels: nativeLibrary("edge-sniper-models", 1),
  },
  params: {},
  onTick(ctx) {
    const score = edgeModels.scoreSides(ctx.samples, ctx.tick, ctx.event, ctx.params);
  },
});
```

Observacao: a sintaxe final pode ser diferente, mas a semantica precisa ser essa. Dependencia deve ser explicita, versionada e auditavel.

## 7. Lacunas Que Ainda Precisam Ser Fechadas

### P0 - Correcoes De Contrato E Consistencia

| Lacuna | Impacto | Acao necessaria |
|---|---|---|
| `resolveVersionForBacktest` olha `compiled_json`, mas `getStrategyVersion` retorna `compiled` no objeto API | Cache de compilacao tende a nunca dar hit pelo caminho HTTP normal | Aceitar ambos os formatos ou padronizar objeto interno diferente do objeto API |
| `resolveStrategyAst` recompila mesmo quando o artefato existe | `compiled_json` ainda e mais metadata do que cache real | Persistir `generated_source`/IR e usar cache em RAM por checksum |
| Quando `createStrategyVersion` recebe GLS e converte para JS, checksum pode ser calculado sobre a fonte original | Artefato compilado e checksum da versao podem divergir | Calcular checksum sempre sobre `finalCode`, depois da conversao |
| UI valida sempre como `strategy-js-v1` | Versao GLS antiga pode ter comportamento confuso no editor | Tornar GLS read-only com botao converter, ou validar por `state.editorLanguage` |
| `Math.*` whitelist nao esta totalmente refletida em `standardLibrary`/`blocks` | IA pode gerar `Math.floor` e receber erro apesar de documentacao permitir | Completar `math.*` ou reduzir whitelist ao que existe |
| Validator permite parte de `for`, mas lowerer nao implementa `ForStatement` | Erro aparece tarde como lowering failure | Implementar lowering/codegen de `for` estatico ou rejeitar todos os `for` na V1 |

### P1 - Fazer `compiled_json` Ser Artefato Real

Hoje `compiled_json` guarda metadados, checksums, analise de colunas e paralelismo. Para nivel profissional, ele deve guardar tambem um artefato executavel ou reconstituivel sem reparse completo.

Entregas:

| Entrega | Descricao |
|---|---|
| `generated_source` | Codigo JS gerado pelo compilador controlado, nunca a fonte do usuario |
| `ir_json` ou `ir_checksum` | Representacao canonica para validar recompilacao |
| `dependencies_json` | Lista de bibliotecas usadas com slug, versao e checksum |
| `compile_cache_key` | Chave por source checksum + compiler + stdlib + dependencies |
| `compileCacheHit` real | Run deve reportar quando pulou parse/lowering/codegen |
| `compileMs` separado | Medir parse/validate/lowering/codegen separadamente se possivel |

Regra de seguranca do artefato:

```text
new Function so pode receber codigo gerado pelo compilador, nunca source_code do usuario.
Todo literal emitido deve usar JSON.stringify.
Todo identificador emitido deve passar em whitelist/regex.
Toda chamada emitida deve vir de tabela estatica de primitivas permitidas.
```

### P2 - Criar Um `Strategy Package` Imutavel

O run precisa guardar um snapshot completo para reproducibilidade.

Modelo alvo do snapshot:

```json
{
  "strategy_id": 12,
  "strategy_version_id": 44,
  "language": "strategy-js-v1",
  "source_code": "export default strategy({...})",
  "source_checksum": "...",
  "params_schema": {},
  "params_effective": {},
  "preset": {
    "id": 3,
    "name": "agressivo BTC"
  },
  "dependencies": [
    {
      "slug": "edge-sniper-models",
      "version": 1,
      "checksum": "...",
      "kind": "native-bundled"
    }
  ],
  "compiler_version": "compiler-soa-v2",
  "stdlib_version": "stdlib-v3",
  "column_analysis": {},
  "parallelism": {}
}
```

Sem isso, runs antigos podem ficar explicaveis visualmente, mas nao 100% reproduziveis quando a stdlib ou biblioteca nativa evoluir.

### P3 - Remover Logica Especifica De `standardLibrary`

Estado atual aceitavel como transicao:

```text
standardLibrary cria lib.model.directionProbability,
lib.model.scoreSides,
lib.model.scoreImpulseElasticitySides via native registry.
```

Estado final:

```text
standardLibrary contem apenas primitives genericas.
modelos especificos sao dependencias declaradas pela estrategia.
```

Tarefas:

| Tarefa | Resultado esperado |
|---|---|
| Separar `model.orderBookImbalance` como primitive generica | Pode continuar na stdlib |
| Remover auto-injecao invisivel de `edge-sniper-models` | Nenhuma estrategia recebe modelo especifico sem declarar |
| Criar sintaxe/metadata de dependencias | Estrategia declara `edge-sniper-models@1` |
| Resolver dependencias no compile/save | Erro se dependencia nao existir ou versao estiver invalida |
| Resolver dependencias no run | Snapshot inclui versao e checksum |
| Mostrar dependencias na UI | Usuario ve exatamente o que esta fora do source |

### P4 - Migrar Estrategias Antigas Para Strategy JS

Ordem recomendada:

| Ordem | Estrategia | Caminho |
|---|---|---|
| 1 | Estrategias GLS simples criadas no editor | Converter automaticamente e salvar nova versao JS |
| 2 | VSMR | Converter, validar, rodar paridade smoke |
| 3 | Impulse Elasticity | Converter, declarar dependencia se usar modelo especifico |
| 4 | Edge Sniper V2/V3 | Converter, usar dependencias versionadas para modelos pesados |
| 5 | Gamma Ladder | Manter como excecao declarada ate existir API multi-posicao suficiente |

Fluxo operacional:

```bash
npm run migrate:strategies-to-js -- --dry-run
npm run migrate:strategies-to-js
npm test
npm run bench:strategy-js
npm run verify:strategy-js-backtest
```

Para cada estrategia migrada:

```text
- salvar versao Strategy JS;
- validar sem warnings criticos;
- comparar contra run GLS anterior quando existir;
- registrar divergencia esperada ou exigir paridade;
- marcar GLS como legacy/read-only;
- definir default_version_id para a versao JS aprovada.
```

### P5 - Tratar Gamma Ladder Como Excecao Formal Ou Porta-la

Gamma Ladder ainda e caso especial nativo. Isso nao pode ficar escondido.

Estado transitorio correto:

```json
{
  "execution_kind": "native-extension",
  "editable_logic": false
}
```

Para remover a excecao de verdade, faltam primitives genericas:

| Primitive | Por que precisa |
|---|---|
| Multi-posicao por lado | Gamma pode ter exposicao simultanea/escada |
| Inventario por preco medio | Controle de ladder e reducoes parciais |
| Ordens compostas | Entradas/saidas pareadas ou hedges |
| Marcacao de hedge/box | Explicabilidade no chart e timeline |
| Regras de liquidacao por evento | Fechamento consistente no fim do mercado |

Se essas primitives nao forem priorizadas agora, a estrategia deve continuar marcada como extensao nativa e nao deve ser apresentada como totalmente editavel.

### P6 - Promocao De Labs Para Studio Sem Seed Invisivel

O seed automatico em producao ja foi desativado, mas o fluxo final precisa ser explicitamente revisavel.

Alvo:

```text
lab encontra candidata
  -> lab:promote-to-studio gera pacote
  -> usuario ve diff no Studio ou CLI
  -> salvar como nova versao/preset
  -> nunca sobrescrever versao editada sem confirmacao
```

Tarefas:

| Tarefa | Resultado esperado |
|---|---|
| `lab:promote-to-studio --dry-run` com diff | Promocao auditavel |
| Importacao cria versao nova por padrao | Sem overwrite silencioso |
| Importacao de preset separada de codigo | Parametros campeoes nao duplicam fonte |
| Historico de origem | Snapshot mostra lab, experimento e preset origem |

### P7 - UX De Editor No Nivel Plataforma

O editor ja funciona. Para chegar no nivel profissional, falta deixar o contrato impossivel de interpretar errado.

Entregas:

| Entrega | Resultado esperado |
|---|---|
| Language mode claro | `Strategy JS` como default, `GLS legado` como read-only/converter |
| Painel de dependencias | Lista bibliotecas usadas pela versao |
| Linter com `code` e `fix_hint` visiveis | IA e usuario conseguem corrigir rapido |
| Validacao em tempo real com debounce | Menos ciclo manual validar/salvar |
| Botao smoke run sem salvar rascunho? | Opcional, com run temporario nao versionado ou exigindo salvar |
| Comparador de presets | Ja existe base, evoluir para comparacao lado a lado e run por preset |
| Sweep a partir de preset | Otimizacao sem alterar codigo |
| Template copiavel para IA | Ja existe, completar com exemplos e anti-exemplos |

### P8 - Testes E Benchmarks De Aceite

Suites que devem existir ou ser fortalecidas:

| Area | Teste necessario |
|---|---|
| Parser | `export default strategy`, `strategy({...})`, erro de wrapper ausente |
| Seguranca | import, require, fetch, eval, Function, async, Date.now, Math.random, process, global |
| Colunas | tick props conhecidas, tick prop desconhecida, `tick[field]` proibido |
| Math | Cada `Math.*` permitido deve rodar ou ser rejeitado explicitamente na doc |
| Helpers | Inlining antes de column analysis e paralelismo |
| Loops | Rejeicao clara ou suporte real a bound estatico |
| Artefato | Cache hit real por checksum, invalida por compiler/stdlib/dependency |
| API | salvar Strategy JS, executar, snapshot completo, preset merge |
| UI | criar, validar, salvar, converter GLS, rodar smoke, ver dependencies |
| Paridade | Strategy JS vs GLS nas estrategias migradas |
| Performance | `processMs <= baseline * 1.05`, sem aumento de colunas lidas |

Comandos de gate:

```bash
npm test
npm run bench:strategy-js
npm run bench:backtest
npm run bench:v4
npm run verify:strategy-js-backtest
```

## 8. Plano De Execucao Recomendado

### Fase 1 - Fechar inconsistencias imediatas

Entrega:

```text
- padronizar checksum sobre finalCode;
- fazer resolveVersionForBacktest ler compiled e compiled_json;
- decidir e implementar politica de GLS no editor;
- alinhar Math whitelist com stdlib;
- rejeitar ou implementar for estatico.
```

Aceite:

```text
npm test passa;
uma estrategia Strategy JS salva pelo editor roda com compileCacheHit correto quando aplicavel;
uma GLS antiga abre como legado ou converte sem ambiguidade.
```

### Fase 2 - Artefato compilado profissional

Entrega:

```text
- persistir generated_source/IR suficiente no compiled_json;
- cache em RAM por compile_cache_key;
- metricas parseMs, validateMs, lowerMs, codegenMs, compileMs;
- falhar run se artefato estiver invalido e recompilacao falhar.
```

Aceite:

```text
primeiro run compila;
segundo run usa cache;
sweep com N variantes nao recompila N vezes quando o codigo e igual;
summary.timings.strategyMeta mostra cache e colunas usadas.
```

### Fase 3 - Dependencias explicitas

Entrega:

```text
- definir sintaxe/metadata de dependencies;
- resolver strategy_library_versions no save;
- incluir dependencies no compiled_json e no snapshot do run;
- remover auto-injecao invisivel de modelos especificos;
- manter stdlib so generica.
```

Aceite:

```text
Edge/Impulse/VSMR declaram dependencias se precisarem;
nenhum modelo especifico aparece para uma estrategia sem declaracao;
UI mostra dependencias.
```

### Fase 4 - Migracao das estrategias antigas

Entrega:

```text
- rodar migracao GLS->Strategy JS;
- criar default versions JS;
- paridade por estrategia;
- GLS fica legado/read-only;
- Gamma Ladder marcada como native-extension ou portada.
```

Aceite:

```text
estrategias principais rodam como Strategy JS pelo editor;
nenhuma exige arquivo .gls como fonte primaria;
todo run novo usa strategy_id + strategy_version_id.
```

### Fase 5 - UX e operacao de plataforma

Entrega:

```text
- promote lab com dry-run/diff;
- preset e sweep integrados no fluxo de editor;
- contrato para IA completo;
- docs de Strategy JS como manual principal;
- dashboards mostram linguagem, compiler, stdlib, deps e cache.
```

Aceite:

```text
usuario cola uma estrategia nova no editor, valida, salva e roda;
usuario converte uma antiga, salva e roda;
nenhuma etapa exige deploy para mudar logica;
backtest so fornece dados, execucao e primitivas genericas.
```

## 9. Criterios De Pronto

A meta deste documento esta completa quando todas as afirmacoes abaixo forem verdadeiras:

| Criterio | Verificacao |
|---|---|
| Nova estrategia nasce no editor | Criar Strategy JS do zero, salvar, executar |
| Estrategia antiga roda pelo editor | Converter GLS ou marcar native-extension explicitamente |
| Sem deploy para logica | Nenhuma alteracao em `src/backtest`, `src/strategies` ou stdlib especifica |
| Motor generico | `loadStrategy` em producao so usa version/snapshot validado |
| Snapshot completo | Run guarda source, checksum, params, preset, deps, compiler, stdlib |
| Performance preservada | Benchmarks sem regressao relevante |
| Column pruning seguro | Falha validacao se nao mapear colunas |
| Cache real | `compileCacheHit` funciona e e mensurado |
| Dependencias auditaveis | Bibliotecas aparecem no editor e no run |
| Gamma honesta | Portada ou marcada como `native-extension` |
| Labs explicitos | Promocao nao sobrescreve nada sem confirmacao |

## 10. Proximo Passo Recomendado

Implementar primeiro a Fase 1. Ela e pequena, reduz ambiguidade e evita construir o restante em cima de inconsistencias.

Ordem exata sugerida:

```text
1. Corrigir checksum sobre finalCode em createStrategyVersion.
2. Padronizar resolveVersionForBacktest para aceitar objeto DB e objeto API.
3. Fazer UI validar pela linguagem real ou tornar GLS read-only/converter.
4. Alinhar Math whitelist, blocks e standardLibrary.
5. Rejeitar `for` em Strategy JS v1 ate o lowering suportar loops.
6. Adicionar testes cobrindo essas cinco regras.
```

Depois disso, partir para `compiled_json` como artefato real e dependencias explicitas.
