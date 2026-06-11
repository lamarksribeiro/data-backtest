# Refatoração e melhorias do data-backtest

Este documento organiza a evolução do projeto em prioridades práticas para velocidade, simplicidade e design.

## Eixos de melhoria

### 1. Velocidade de backtest

| # | Melhoria | Onde | Esforço | Ganho esperado |
|---|----------|------|---------|----------------|
| P1 | Projeção GLS-aware de colunas | `src/query/duckdbQuery.js` | Médio | 2–5× menos I/O |
| P2 | Remover caminho legado no hot path | `src/backtest/tickProvider.js` | Baixo | Menos alocação JS |
| P3 | Cursor sequencial otimizado | `src/query/duckdbQuery.js` | Baixo | Mais throughput em runs longos |
| P4 | Modo `fast_run` | `src/backtest/engine.js` | Médio | Menos gravação pós-run |
| P5 | Persistência assíncrona de traces | `src/backtest/worker.js` | Médio | Menor latência percebida |
| P6 | Cache de chart no trace | `src/backtestStudio/state/eventTraces.js` | Baixo | Explorer mais rápido |
| P7 | Dataset lite no sync | `src/sync/*` | Alto | Menor lake + queries rápidas |
| P8 | Prepare paralelo | `src/prepare/runner.js` | Médio | Dados prontos mais cedo |
| P9 | GLS bytecode (fase 2) | `src/backtestStudio/gls/` | Alto | 3–10× processMs |
| P10 | Benchmark harness | `tests/benchmark/` | Baixo | Regressão detectável |

### 2. Simplicidade de uso

- Reativar context bar global.
- Criar wizard “Novo backtest”.
- Adicionar botão “Testar” no editor de estratégias.
- Melhorar o seletor de versão e presets de período.
- Preparar dados inline sem trocar de aba.

### 3. Design e frontend

- Extrair design tokens.
- Componentizar cards e painéis.
- Melhorar run detail com abas.
- Reduzir estilos inline e densidade visual.
- Unificar status e notificação de jobs.

## Roadmap

- R0: quick wins.
- R1: performance core.
- R2: UX completa.
- R3: data plane avançado.
- R4: polish e design system.

## Critérios de aceite

- Backtest 7d BTC 5m < 60s em ambiente de referência.
- Evento visualizado com 1 clique e sem loading bloqueante.
- Comparador de runs disponível e útil.
- Re-run com mesmo dataset sem reprocessar toda a leitura.
