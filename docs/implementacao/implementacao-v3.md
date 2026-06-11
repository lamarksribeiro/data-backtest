# Implementação V3 — Consolidação UX

> Plano diretor: [arquitetura-v3-consolidacao-ux.md](../arquitetura/arquitetura-v3-consolidacao-ux.md)

## Objetivo

Consolidar a UI do `data-backtest` em três frentes: Estúdio único, Dados simples e Biblioteca de estratégias.

## Deploy produção (V2 pré-requisito)

- [ ] Push na branch configurada no Coolify (`backtest.fracta.online`)
- [ ] Validar [scripts/smoke-v2-production.md](../../scripts/smoke-v2-production.md)
- [x] Incrementar `?v=` em `public/index.html` após mudanças estáticas (`?v=5`)

> Deploy operacional documentado aqui; execução manual fora do escopo do agente.

---

## U0 — Pré-requisitos

- [x] `docs/implementacao/implementacao-v3.md` com checklists U1–U7
- [x] `manual-backtest-studio.md` fluxo Estúdio-first
- [x] Componentes extraídos: `runMetrics.js`, `noEntryDiagnostic.js`, `executionTimeline.js`, `eventChartMarkers.js`

## U1 — Paridade Estúdio (§2.2)

- [x] Stats agregadas de runs (chips colapsáveis no painel de runs)
- [x] Filtros/sort da lista (status, PnL, só desta estratégia)
- [x] Sublinha versão + período por run
- [x] Indicador DATA_NOT_READY / cobertura no CONFIG
- [x] Batch size em seção Avançado
- [x] Timing detalhado na tab Análise
- [x] Diagnóstico nenhuma entrada (`entries == 0`)
- [x] Métricas agrupadas (Geral / Assertividade / Médias) + toggle JSON
- [x] Timeline cronológica no drawer (+ modo tabela)
- [x] Diagnósticos e logs enriquecidos no drawer
- [x] Breakdown de fees no drawer
- [x] Markers tipados no gráfico uPlot
- [x] Paginação de eventos com offset (sem limite fixo 500)

## U2 — Remover legado

- [x] Deletar `backtests.js`, `run-detail.js`, `event-detail.js`, `chart.js`
- [x] Deletar `lakehouse.js`, `jobs.js` (substituídos por `data.js`)
- [x] Limpar `app.js` (redirects `#/backtests*` → studio)
- [x] Sidebar 4 itens: Estúdio · Estratégias · Dados · Visão Geral
- [x] Redirect `#/jobs` → `#/data`
- [x] Remover Chart.js CDN
- [x] `npm test` verde (79 testes)

## U3 — Dados unificados

- [x] `src/query/coverageUi.js` (mapeamento 9→3 estados)
- [x] `GET /api/data/coverage`
- [x] `public/js/views/data.js` (lakehouse + jobs + calendário)
- [x] `overview.js` só saúde do sistema
- [x] Redirect `#/jobs` → `#/data`

## U4 — Corrigir em 1 clique

- [x] `src/data/fixPipeline.js`
- [x] `POST /api/data/fix`
- [x] Indicador verde/azul/âmbar no CONFIG do Estúdio
- [x] Botão Corrigir + run dependente de job (`depends_on_job_id`)
- [x] SSE `data:stale` (opcional) + toast ao concluir fix

## U5 — Biblioteca de estratégias

- [x] Migração índice `backtest_runs(strategy_id, strategy_version_id, created_at)`
- [x] Migração `strategy_definitions.pinned`
- [x] `src/backtestStudio/state/strategyStats.js`
- [x] `GET /api/strategies?stats=1` e `GET /api/strategies/:id/stats`
- [x] Modo Biblioteca em `strategies.js` (cards, sparkline, favoritos, ordenação)
- [x] Botão ▶ Rodar → `#/studio?strategy=:id`

## U6 — Versões, notas e fork

- [x] Migração `strategy_versions.notes`
- [x] `POST /api/strategies/:id/fork`
- [x] Seletor de versão em `strategyPicker.js`
- [x] Campo notas ao salvar versão
- [x] `#/studio?strategy=&version=` pré-seleção

## U7 — Diff e evolução

- [x] Painel diff entre versões no editor
- [x] Gráfico Evolução (win_rate / avg_pnl por versão)

---

## Componentes extraídos (U0)

| Arquivo | Origem |
|---------|--------|
| `public/js/components/runMetrics.js` | `run-detail.js` |
| `public/js/components/noEntryDiagnostic.js` | `run-detail.js` |
| `public/js/components/executionTimeline.js` | `event-detail.js` |
| `public/js/components/eventChartMarkers.js` | `chart.js` |

## Documentação por fase

| Fase | Atualizar |
|------|-----------|
| U0–U2 | `manual-backtest-studio.md` ✓ |
| U3–U4 | `contratos-api-schemas.md`, manual §Dados ✓ |
| U5–U7 | `contratos-api-schemas.md`, manual §Biblioteca ✓ |
