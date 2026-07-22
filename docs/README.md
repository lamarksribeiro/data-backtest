# Documentação do data-backtest

Lakehouse OLAP + Backtest Studio do ecossistema GoldenLens. Este índice organiza a
documentação por finalidade: **arquitetura** (decisões e planos), **implementação**
(o que foi construído, fase a fase), **operação** (runbooks) e **referência**
(manuais e contratos).

## Comece por aqui

| Quero… | Documento |
|--------|-----------|
| Simular ordens resting (maker LIMIT + stop-buy) e preset TFC V6 Hybrid | [arquitetura/extensao-order-simulator-maker-limit.md](arquitetura/extensao-order-simulator-maker-limit.md) |
| Corrigir a lentidão da UI durante jobs Parquet e backtests (isolamento de jobs) | [arquitetura/arquitetura-v5-isolamento-jobs.md](arquitetura/arquitetura-v5-isolamento-jobs.md) |
| Entender a correção definitiva de performance do backtest (hot path colunar) | [arquitetura/arquitetura-v4-hot-path-colunar.md](arquitetura/arquitetura-v4-hot-path-colunar.md) |
| Desacoplar estratégias do deploy usando Strategy JS no editor | [arquitetura/arquitetura-v6-strategy-js-editor.md](arquitetura/arquitetura-v6-strategy-js-editor.md) |
| Entender o plano de evolução atual (Estúdio único, Dados simples, biblioteca de estratégias) | [arquitetura/arquitetura-v3-consolidacao-ux.md](arquitetura/arquitetura-v3-consolidacao-ux.md) |
| Ver o que a V2 entregou (motor rápido, SSE, Estúdio) | [arquitetura/arquitetura-v2-performance-ux.md](arquitetura/arquitetura-v2-performance-ux.md) |
| Usar o Backtest Studio (escrever estratégias GLS, rodar backtests) | [referencia/manual-backtest-studio.md](referencia/manual-backtest-studio.md) |
| Criar e testar novos laboratórios de estratégias | [referencia/guia-criacao-e-teste-de-laboratorios.md](referencia/guia-criacao-e-teste-de-laboratorios.md) |
| Seguir boas práticas de performance no laboratório (sweeps) | [referencia/guia-performance-laboratorio.md](referencia/guia-performance-laboratorio.md) |
| Operar o lakehouse (sync, validação, rebuild, backup) | [operacao/operacao-lakehouse.md](operacao/operacao-lakehouse.md) |
| Atualizar BTC 5m local (atalho) | [operacao/atualizar-btc-5m-local.md](operacao/atualizar-btc-5m-local.md) |
| Baixar Parquet do Brutus para o PC local | [operacao/lake-pull-brutus.md](operacao/lake-pull-brutus.md) |
| Consultar endpoints e schemas | [referencia/contratos-api-schemas.md](referencia/contratos-api-schemas.md) |
| Ler teoria e resultados das estratégias (implementadas, backlog, rejeitadas) | [estrategias/README.md](estrategias/README.md) |
| Entender como os dados são armazenados (schemas Parquet, semântica, leitura) | [analise-quantitativa/dicionario-dados-lakehouse.md](analise-quantitativa/dicionario-dados-lakehouse.md) |
| Construir/operar o sistema de descoberta de padrões e anomalias BTC 5m | [analise-quantitativa/guia-sistema-descoberta-padroes.md](analise-quantitativa/guia-sistema-descoberta-padroes.md) |

## Estratégias — teorias e resultados

| Documento | Conteúdo |
|-----------|----------|
| [estrategias/README.md](estrategias/README.md) | Índice por estágio: implementadas no Studio, backlog de port, rejeitadas |
| [estrategias/analise-comparativa-estrategias.md](estrategias/analise-comparativa-estrategias.md) | Comparativo de janelas, gatilhos e sinergia entre teorias |
| [analise-quantitativa/dicionario-dados-lakehouse.md](analise-quantitativa/dicionario-dados-lakehouse.md) | Dicionário de dados do lakehouse: schemas, semântica BTC 5m, qualidade, como consultar |
| [analise-quantitativa/guia-sistema-descoberta-padroes.md](analise-quantitativa/guia-sistema-descoberta-padroes.md) | Blueprint do sistema de descoberta de padrões/anomalias: cubo de features, mineração, validação, anti-overfitting |
| [analise-quantitativa/catalogo-anomalias.md](analise-quantitativa/catalogo-anomalias.md) | Registro central das anomalias mineradas (promovidas, rejeitadas, sob análise) |
| [estrategias/implementadas/README.md](estrategias/implementadas/README.md) | Índice das 19 docs de estratégias portadas |
| [analise-quantitativa/estudo-correlacao-binance-polymarket.md](analise-quantitativa/estudo-correlacao-binance-polymarket.md) | Estudo lead-lag Binance (origem BS-Lead) |
| [estrategias/nao-implementadas/](estrategias/nao-implementadas/) | Teorias com lab no polymarket-test, pendentes de port |
| [rejeitadas/](rejeitadas/) | Teorias arquivadas e estudos de falha |

Catálogo de port (status, prioridade, `sourceDoc`): `labs/strategies/_catalog/port-catalog.json`.

## Arquitetura — decisões e planos

| Documento | Conteúdo |
|-----------|----------|
| [extensao-order-simulator-maker-limit.md](arquitetura/extensao-order-simulator-maker-limit.md) | **Proposta de execução maker**: estender o orderSimulator com LIMIT buy pré-posicionada (resting orders, fill por atravessamento do book, posição em dois lotes/hedge, maker fee zero) para comparar TFC taker 8→4 vs LIMIT com números; fases F1–F5 |
| [arquitetura-v5-isolamento-jobs.md](arquitetura/arquitetura-v5-isolamento-jobs.md) | **Proposta de responsividade**: por que jobs de preparação (Parquet) e backtests travam o dashboard (event loop bloqueado, SQLite síncrono, amplificação no frontend) e como corrigir — prepare jobs em worker_thread, progress/jobs slim, frontend orientado a SSE, coverage limitada, fases I0–I6 |
| [arquitetura-v6-strategy-js-editor.md](arquitetura/arquitetura-v6-strategy-js-editor.md) | **Proposta de desacoplamento de estratégias**: trocar GLS como linguagem principal por Strategy JS (subconjunto seguro de JavaScript no editor), manter compilação para `compiled-soa`, remover seeds como fonte primária, migrar modelos específicos para código versionado no banco e preservar performance |
| [arquitetura-v4-hot-path-colunar.md](arquitetura/arquitetura-v4-hot-path-colunar.md) | **Plano de performance atual (prioridade máxima)**: correção definitiva — fronteira colunar DuckDB→TypedArrays (Parquet permanece o único formato em disco), hot loop Struct-of-Arrays sem objetos por tick, codegen GLS v2, paralelismo por evento com SharedArrayBuffer, fases F0–F5 |
| [arquitetura-v3-consolidacao-ux.md](arquitetura/arquitetura-v3-consolidacao-ux.md) | **Plano diretor de UX**: Estúdio como tela única de backtest, view Dados com 3 estados derivados + correção em 1 clique, biblioteca de estratégias com stats/fork/diff/versões, fases U1–U7 |
| [arquitetura-v2-performance-ux.md](arquitetura/arquitetura-v2-performance-ux.md) | Plano V2 (implementado): compilador GLS→JS, pipeline com prefetch, fila + SSE, Estúdio de painel único, comparador de runs, fases R1–R9 |
| [arquitetura-lakehouse-backtest.md](arquitetura/arquitetura-lakehouse-backtest.md) | Visão original do lakehouse: Postgres → Parquet/DuckDB, manifest, validação, fases 0–13 |
| [arquitetura-editor-estrategias.md](arquitetura/arquitetura-editor-estrategias.md) | Visão original do Backtest Studio: linguagem GLS v1, blocos, runtime, traces |
| [arquitetura-backtest-v2.md](arquitetura/arquitetura-backtest-v2.md) | Nota histórica: direção inicial da V2 (Data/Execution/Experience Plane); superseded pela V2/V3 |
| [refatoracao-melhorias.md](arquitetura/refatoracao-melhorias.md) | Nota histórica: backlog de melhorias que originou a V2; superseded pela V2/V3 |

## Implementação — o que está construído

| Documento | Conteúdo |
|-----------|----------|
| [implementacao-lakehouse.md](implementacao/implementacao-lakehouse.md) | Fases L1–L8 do lakehouse: state store, sync, exports Parquet, query layer, API/UI |
| [implementacao-editor-backtest.md](implementacao/implementacao-editor-backtest.md) | Fases Pre-B1 e B1–B7 do Studio: CRUD de estratégias, editor, parser/validador/runtime GLS, execução, visualização. Inclui o **catálogo canônico da biblioteca padrão GLS v1** |

## Operação — runbooks

| Documento | Conteúdo |
|-----------|----------|
| [operacao-lakehouse.md](operacao/operacao-lakehouse.md) | Rotinas: sync incremental, reconciliação, marcação de stale, rebuild, backup/restore, `ops:check` |
| [atualizar-btc-5m-local.md](operacao/atualizar-btc-5m-local.md) | Atalho: `npm run lake:update-btc-5m` (sem dry-run/availability manual) |
| [lake-pull-brutus.md](operacao/lake-pull-brutus.md) | `npm run lake:pull` genérico: filtros, container após redeploy, full pull |
| [deploy-coolify.md](operacao/deploy-coolify.md) | Deploy em produção via Coolify: volumes `/lake` e `/state`, envs, healthcheck |

## Referência — manuais e contratos

| Documento | Conteúdo |
|-----------|----------|
| [manual-backtest-studio.md](referencia/manual-backtest-studio.md) | Manual do usuário: UI, fluxo de backtest, sintaxe GLS, exemplos |
| [guia-criacao-e-teste-de-laboratorios.md](referencia/guia-criacao-e-teste-de-laboratorios.md) | Guia prático de criação, otimização (sweeps) e testes de laboratórios |
| [guia-performance-laboratorio.md](referencia/guia-performance-laboratorio.md) | Recomendações e boas práticas de performance de processamento no lab |
| [contratos-api-schemas.md](referencia/contratos-api-schemas.md) | Contratos HTTP (request/response) e schemas SQLite |
| [contrato-archive-retencao.md](referencia/contrato-archive-retencao.md) | Contrato de archive com o `data-colector` e retenção opcional |
| [paridade-edge-sniper-v2.md](referencia/paridade-edge-sniper-v2.md) | Evidência do golden test de paridade da estratégia seed Edge Sniper V2 |

## Convenções

- Documentos de **arquitetura** registram intenção e decisões; os de
  **implementação** registram o que existe no código — em divergência, vale a
  implementação.
- Notas históricas: `arquitetura-editor-estrategias.md` e
  `implementacao-editor-backtest.md` mantêm os nomes antigos ("editor"); o
  conteúdo descreve o Backtest Studio.
- Ao alterar API ou schema, atualizar `referencia/contratos-api-schemas.md` no
  mesmo PR.
