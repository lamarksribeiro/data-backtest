# Documentação do data-backtest

Lakehouse OLAP + Backtest Studio do ecossistema GoldenLens. Este índice organiza a
documentação por finalidade: **arquitetura** (decisões e planos), **implementação**
(o que foi construído, fase a fase), **operação** (runbooks) e **referência**
(manuais e contratos).

## Comece por aqui

| Quero… | Documento |
|--------|-----------|
| Entender o plano de evolução atual (performance + UX) | [arquitetura/arquitetura-v2-performance-ux.md](arquitetura/arquitetura-v2-performance-ux.md) |
| Usar o Backtest Studio (escrever estratégias GLS, rodar backtests) | [referencia/manual-backtest-studio.md](referencia/manual-backtest-studio.md) |
| Operar o lakehouse (sync, validação, rebuild, backup) | [operacao/operacao-lakehouse.md](operacao/operacao-lakehouse.md) |
| Consultar endpoints e schemas | [referencia/contratos-api-schemas.md](referencia/contratos-api-schemas.md) |

## Arquitetura — decisões e planos

| Documento | Conteúdo |
|-----------|----------|
| [arquitetura-v2-performance-ux.md](arquitetura/arquitetura-v2-performance-ux.md) | **Plano diretor atual**: diagnóstico de gargalos, compilador GLS→JS, pipeline com prefetch, fila + SSE, Estúdio de painel único, comparador de runs, fases R1–R9 |
| [arquitetura-lakehouse-backtest.md](arquitetura/arquitetura-lakehouse-backtest.md) | Visão original do lakehouse: Postgres → Parquet/DuckDB, manifest, validação, fases 0–13 |
| [arquitetura-editor-estrategias.md](arquitetura/arquitetura-editor-estrategias.md) | Visão original do Backtest Studio: linguagem GLS v1, blocos, runtime, traces |

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
