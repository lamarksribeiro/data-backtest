# Documentação do data-backtest

Lakehouse OLAP + Backtest Studio do ecossistema GoldenLens. Este índice organiza a
documentação por finalidade: **arquitetura** (decisões e planos), **implementação**
(o que foi construído, fase a fase), **operação** (runbooks) e **referência**
(manuais e contratos).

## Comece por aqui

| Quero… | Documento |
|--------|-----------|
| Corrigir a lentidão da UI durante jobs Parquet e backtests (isolamento de jobs) | [arquitetura/arquitetura-v5-isolamento-jobs.md](arquitetura/arquitetura-v5-isolamento-jobs.md) |
| Entender a correção definitiva de performance do backtest (hot path colunar) | [arquitetura/arquitetura-v4-hot-path-colunar.md](arquitetura/arquitetura-v4-hot-path-colunar.md) |
| Entender o plano de evolução atual (Estúdio único, Dados simples, biblioteca de estratégias) | [arquitetura/arquitetura-v3-consolidacao-ux.md](arquitetura/arquitetura-v3-consolidacao-ux.md) |
| Ver o que a V2 entregou (motor rápido, SSE, Estúdio) | [arquitetura/arquitetura-v2-performance-ux.md](arquitetura/arquitetura-v2-performance-ux.md) |
| Usar o Backtest Studio (escrever estratégias GLS, rodar backtests) | [referencia/manual-backtest-studio.md](referencia/manual-backtest-studio.md) |
| Operar o lakehouse (sync, validação, rebuild, backup) | [operacao/operacao-lakehouse.md](operacao/operacao-lakehouse.md) |
| Consultar endpoints e schemas | [referencia/contratos-api-schemas.md](referencia/contratos-api-schemas.md) |

## Arquitetura — decisões e planos

| Documento | Conteúdo |
|-----------|----------|
| [arquitetura-v5-isolamento-jobs.md](arquitetura/arquitetura-v5-isolamento-jobs.md) | **Proposta de responsividade**: por que jobs de preparação (Parquet) e backtests travam o dashboard (event loop bloqueado, SQLite síncrono, amplificação no frontend) e como corrigir — prepare jobs em worker_thread, progress/jobs slim, frontend orientado a SSE, coverage limitada, fases I0–I6 |
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
| [deploy-coolify.md](operacao/deploy-coolify.md) | Deploy em produção via Coolify: volumes `/lake` e `/state`, envs, healthcheck |

## Referência — manuais e contratos

| Documento | Conteúdo |
|-----------|----------|
| [manual-backtest-studio.md](referencia/manual-backtest-studio.md) | Manual do usuário: UI, fluxo de backtest, sintaxe GLS, exemplos |
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
