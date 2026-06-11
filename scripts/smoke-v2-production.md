# Smoke V2 — produção (L8)

Checklist para validar `backtest.fracta.online` após deploy da Arquitetura V2.

## Pré-requisitos

- Volumes Coolify: `/lake` e `/state`
- `SESSION_SECRET`, credenciais admin, `DATA_COLLECTOR_DATABASE_URL`
- `MAX_CONCURRENT_BACKTESTS=1` (default)
- Proxy com SSE: `X-Accel-Buffering: no` no path `/api/stream`

## Passos

1. `npm run ops:check` no container (ou health local equivalente)
2. Login em `/login`
3. Abrir `#/studio` — layout 3 zonas carrega sem erro de console
4. Preparar dados (dry-run depois real) para janela BTC 5m
5. Rodar backtest GLS async — status `running` → `completed` via SSE
6. Abrir evento no drawer — série pré-computada (< 100ms, sem `/chart-data`)
7. Comparar 2 runs (Shift+clique no painel lateral)
8. Backup `/lake` + `/state` documentado em `docs/operacao/operacao-lakehouse.md`

## Regressão

- `npm test` verde no CI
- `npm run bench:backtest -- --save` com dados preparados (baseline em `reports/bench/`)
