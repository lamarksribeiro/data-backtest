# Contratos De API E Schemas

## Objetivo

Centralizar os contratos de API e os schemas principais do `data-backtest`.

Este documento e uma referencia de implementacao. A arquitetura conceitual fica nos outros documentos.

## Convencoes Gerais

### Datas

Entrada aceita:

```text
YYYY-MM-DD
ISO timestamp
```

Internamente normalizar para ISO UTC:

```text
2026-05-29T00:00:00.000Z
```

### Underlying

Sempre normalizar para uppercase:

```text
BTC
ETH
```

### Erro Padrao

```json
{
  "error": {
    "code": "REQUEST_FAILED",
    "message": "Human readable message"
  }
}
```

### Status HTTP

```text
200 sucesso
202 job aceito
400 request invalido ou confirmacao ausente
404 recurso nao encontrado
409 dados indisponiveis para execucao strict
500 erro inesperado
```

## Dataset Request

Formato canonico usado por availability, prepare, query e backtest:

```json
{
  "dataset": "backtest_ticks",
  "from": "2026-05-29T00:00:00.000Z",
  "to": "2026-05-30T00:00:00.000Z",
  "underlying": "BTC",
  "interval": "5m",
  "bookDepth": 10,
  "resolution": null,
  "limit": 1000,
  "offset": 0,
  "rebuild": false
}
```

Query params equivalentes:

```text
dataset=backtest_ticks
from=2026-05-29
to=2026-05-30
underlying=BTC
interval=5m
book_depth=10
resolution=1m
limit=1000
offset=0
rebuild=true
```

## Lakehouse API

### `GET /healthz`

Response:

```json
{
  "status": "ok",
  "lake_root": "/lake",
  "state_db_path": "/state/data-backtest.db",
  "backtest_data_mode": "strict",
  "manifest": {
    "partitions": 1,
    "rows": 5729,
    "by_status": {
      "valid": 1
    }
  }
}
```

### `GET /api/manifest`

Query params:

```text
status optional
limit optional
```

Response:

```json
{
  "stats": {
    "partitions": 1,
    "rows": 5729,
    "by_status": { "valid": 1 }
  },
  "partitions": []
}
```

### `GET /api/availability`

Response:

```json
{
  "availability": {
    "ok": true,
    "dataset": "backtest_ticks",
    "underlying": "BTC",
    "interval": "5m",
    "resolution": null,
    "book_depth": 10,
    "from": "2026-05-29T00:00:00.000Z",
    "to": "2026-05-30T00:00:00.000Z",
    "expected_partitions": ["2026-05-29"],
    "files": ["/lake/backtest_ticks/.../part.parquet"],
    "missing": [],
    "unavailable": []
  }
}
```

Unavailable item:

```json
{
  "dt": "2026-05-29",
  "status": "stale",
  "active_path": "/lake/.../part.parquet"
}
```

### `GET /api/prepare`

Response ready:

```json
{
  "result": {
    "mode": "prepare",
    "ready": true,
    "status": "ready",
    "availability": {},
    "preparation": []
  }
}
```

Response prepare required:

```json
{
  "result": {
    "mode": "prepare",
    "ready": false,
    "status": "prepare_required",
    "reason": "dataset_not_available",
    "availability": {},
    "preparation": [
      {
        "command": "sync:backfill-backtest-ticks",
        "args": ["--from", "...", "--to", "...", "--underlying", "BTC", "--interval", "5m", "--book-depth", "10"]
      }
    ]
  }
}
```

### `POST /api/prepare/run`

Request:

```json
{
  "request": {
    "dataset": "backtest_ticks",
    "from": "2026-05-29",
    "to": "2026-05-30",
    "underlying": "BTC",
    "interval": "5m",
    "book_depth": 10,
    "rebuild": false
  },
  "dry_run": true,
  "mode": "prepare"
}
```

Real rebuild exige:

```json
{
  "dry_run": false,
  "confirm_rebuild": "REBUILD_PARTITIONS"
}
```

Response:

```json
{
  "job": {
    "id": 1,
    "status": "queued",
    "dry_run": true,
    "request": {},
    "plan": {},
    "result": null,
    "error": null,
    "created_at": "..."
  }
}
```

### `GET /api/prepare/jobs`

Query params:

```text
limit optional
```

Response:

```json
{
  "jobs": []
}
```

### `GET /api/prepare/jobs/:id`

Response:

```json
{
  "job": {}
}
```

## Backtest API Atual

### `GET /api/backtest/strategies`

Response:

```json
{
  "strategies": ["edge-sniper-v2", "edgeSniperV2"]
}
```

### `POST /api/backtest/run`

Request nativo atual:

```json
{
  "strategy": "edge-sniper-v2",
  "from": "2026-05-29",
  "to": "2026-05-30",
  "underlying": "BTC",
  "interval": "5m",
  "book_depth": 10,
  "batch_size": 5000,
  "params": {}
}
```

Response sucesso:

```json
{
  "run": {
    "id": 1,
    "strategy": "EDGE_SNIPER_V2",
    "source": "lakehouse",
    "underlying": "BTC",
    "interval": "5m",
    "bookDepth": 10,
    "ticks": 5729,
    "batches": 2,
    "summary": {}
  },
  "result": {}
}
```

Response sem dados:

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

### `GET /api/backtest/runs`

Response:

```json
{
  "runs": [
    {
      "id": 1,
      "strategy": "EDGE_SNIPER_V2",
      "source": "lakehouse",
      "underlying": "BTC",
      "interval": "5m",
      "bookDepth": 10,
      "from": "2026-05-29T00:00:00.000Z",
      "to": "2026-05-30T00:00:00.000Z",
      "ticks": 5729,
      "batches": 2,
      "summary": {},
      "created_at": "..."
    }
  ]
}
```

## Backtest API Futura Do Strategy Lab

### `GET /api/backtest/runs/:id`

Response:

```json
{
  "run": {
    "id": 1,
    "strategy_id": 12,
    "strategy_version_id": 44,
    "summary": {},
    "result": {}
  }
}
```

### `GET /api/backtest/runs/:id/events`

Query params:

```text
result optional: win/loss/no_entry/error
limit optional
offset optional
```

Response:

```json
{
  "events": [
    {
      "id": 1,
      "run_id": 1,
      "condition_id": "...",
      "event_start": "...",
      "entries_count": 1,
      "exits_count": 1,
      "final_pnl": 2.4,
      "result": "win",
      "reason": "take_profit"
    }
  ]
}
```

### `GET /api/backtest/runs/:id/events/:eventTraceId`

Response:

```json
{
  "event": {
    "summary": {},
    "orders": [],
    "marks": [],
    "logs": [],
    "metrics": {}
  }
}
```

### `GET /api/backtest/runs/:id/chart-data`

Query params:

```text
condition_id required
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

## Strategy API Futura

### `GET /api/strategies`

Response:

```json
{
  "strategies": [
    {
      "id": 12,
      "slug": "simple-ptb",
      "name": "Simple PTB",
      "description": "...",
      "status": "draft",
      "tags": [],
      "latest_version": 3,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

### `POST /api/strategies`

Request:

```json
{
  "name": "Simple PTB",
  "slug": "simple-ptb",
  "description": "...",
  "tags": []
}
```

Response:

```json
{
  "strategy": {}
}
```

### `PATCH /api/strategies/:id`

Campos permitidos:

```json
{
  "name": "New name",
  "description": "...",
  "status": "validated",
  "tags": ["btc", "5m"]
}
```

### `POST /api/strategies/:id/versions`

Request:

```json
{
  "language": "gls-v1",
  "source_code": "strategy \"Simple\" { ... }"
}
```

Response:

```json
{
  "version": {
    "id": 44,
    "strategy_id": 12,
    "version": 4,
    "language": "gls-v1",
    "params_schema": {},
    "validation": { "ok": true },
    "checksum": "...",
    "created_at": "..."
  }
}
```

### `POST /api/strategies/validate`

Request:

```json
{
  "language": "gls-v1",
  "source_code": "strategy \"Simple\" { ... }"
}
```

Response:

```json
{
  "validation": {
    "ok": true,
    "errors": [],
    "warnings": [],
    "params_schema": {}
  }
}
```

## SQLite Schemas Consolidados

### `lake_manifest`

Ver `docs/implementacao-lakehouse.md` para detalhes completos.

### `prepare_jobs`

Ver `docs/implementacao-lakehouse.md` para detalhes completos.

### `backtest_runs`

Campos atuais:

```text
id
strategy
source
underlying
interval
book_depth
from_ts
to_ts
batch_size
params_json
batches
summary_json
result_json
created_at
```

Campos futuros:

```text
strategy_id
strategy_version_id
strategy_snapshot_json
dataset_request_json
trace_root_path
status
error
duration_ms
```

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
checksum
created_at
```

### `backtest_event_traces`

```text
id
run_id
condition_id
market_id
event_start
event_end
side
entries_count
exits_count
final_pnl
result
reason
ticks_count
summary_json
orders_json
marks_json
logs_json
metrics_json
chart_series_path
created_at
```

## Compatibility Rules

- Nao remover campos existentes de resposta sem migracao clara.
- Novos campos devem ser opcionais inicialmente.
- Strategy Lab deve aceitar runs nativos antigos sem `strategy_id`.
- UI deve tratar `strategy_id=null` como estrategia nativa/legacy.
- `book_depth` deve continuar aceitando `book_depth` na API e `bookDepth` internamente.
- Datas devem sair sempre em ISO UTC.

## Checklist De Implementacao De Endpoint

- [ ] Valida input.
- [ ] Normaliza datas e underlying.
- [ ] Nao revela secrets.
- [ ] Retorna erro padrao.
- [ ] Tem teste de sucesso.
- [ ] Tem teste de erro.
- [ ] Tem documentacao neste arquivo.
- [ ] Nao bypassa manifest para leitura de Parquet.
