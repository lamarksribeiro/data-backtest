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
401 nao autenticado ou credenciais invalidas
404 recurso nao encontrado
409 dados indisponiveis para execucao strict
500 erro inesperado
```

## Auth API

A UI web e a maioria dos endpoints `/api/*` exigem sessao autenticada (cookie HMAC + bcrypt, mesmo padrao do `data-colector`). Excecoes publicas: `POST /api/login`, `GET /api/me` (retorna `401` sem sessao) e `GET /healthz`. Em `TEST_MODE=true` (`NODE_ENV=test`), o middleware ignora auth.

Variaveis: `SESSION_SECRET` (obrigatorio em producao), `SESSION_MAX_AGE_SEC`, `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD`.

### `POST /api/login`

Request:

```json
{
  "username": "admin",
  "password": "change-me"
}
```

Response sucesso (`200`):

```json
{
  "user": {
    "id": 1,
    "username": "admin"
  }
}
```

Response credenciais invalidas (`401`):

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid credentials"
  }
}
```

Define cookie de sessao via `Set-Cookie`.

### `POST /api/logout`

Response (`200`):

```json
{
  "ok": true
}
```

Limpa o cookie de sessao.

### `GET /api/me`

Response autenticado (`200`):

```json
{
  "principal": {
    "kind": "session",
    "userId": 1,
    "username": "admin"
  }
}
```

Response sem sessao (`401`):

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Not authenticated"
  }
}
```

Demais rotas `/api/*` sem sessao valida retornam `401` com `code: UNAUTHORIZED`. Paginas estaticas (`GET /`, views da UI) redirecionam para `/login`.

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

### `GET /api/context-options`

Opcoes para a barra de contexto e aba Dados. Combina manifest local (`lake`) com dados disponiveis no Postgres do data-colector (`source`). Se `DATA_COLLECTOR_DATABASE_URL` estiver ausente ou a consulta falhar, `source` retorna listas vazias.

Response:

```json
{
  "options": {
    "source": {
      "underlyings": ["BTC", "ETH"],
      "intervals": ["5m", "15m"],
      "book_depths": ["25"],
      "combinations": [
        {
          "underlying": "BTC",
          "interval": "5m",
          "from": "2026-05-01",
          "to": "2026-06-01",
          "partitions": 31
        }
      ]
    },
    "lake": {
      "underlyings": ["BTC"],
      "intervals": ["5m"],
      "book_depths": ["10"],
      "combinations": [
        {
          "underlying": "BTC",
          "interval": "5m",
          "book_depth": "10",
          "from": "2026-05-29",
          "to": "2026-05-30",
          "partitions": 1
        }
      ]
    },
    "underlyings": ["BTC", "ETH"],
    "intervals": ["5m", "15m"],
    "book_depths": ["25"],
    "combinations": []
  }
}
```

Campos de nivel superior (`underlyings`, `intervals`, `book_depths`) sao a uniao de `lake` e `source`. `book_depths` no `source` vem de `markets.book_depth` no Postgres. `combinations` prioriza entradas do `lake`; se vazio, usa `source` (com `book_depth` quando disponivel e `source: "data_collector"`).

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
limit optional (default 20, max 100)
slim optional — default true; use slim=0 para incluir request/plan/result completos
```

Response (slim, default):

```json
{
  "jobs": [
    {
      "id": 1,
      "status": "running",
      "mode": "prepare",
      "dry_run": false,
      "progress": { "percent": 42, "files_count": 3, "bytes_total": 1200000 },
      "error": null,
      "created_at": "...",
      "started_at": "...",
      "completed_at": null
    }
  ]
}
```

`progress.files` mantem no maximo os 5 arquivos mais recentes; contadores `files_count` e `bytes_total` acumulam o job inteiro.

### `GET /api/prepare/jobs/:id`

Response:

```json
{
  "job": {}
}
```

## Backtest API

Status (jun/2026): implementada. Executa estrategias salvas/versionadas via `strategy_id` + `strategy_version_id`. Bloqueia execucao strict sem `backtest_ticks` validos (`409 DATA_NOT_READY`).

### `POST /api/backtest/run`

Request:

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
  "params": {},
  "async": true,
  "fast_run": false
}
```

Campos opcionais V2:

```text
async          — omitido ou true: enfileira (202); false: enfileira e aguarda resultado (200) sem bloquear o event loop
fast_run       — reduz traces/logs no worker
gls_execution  — compiled | interpreter (default: env GLS_EXECUTION)
```

Response async (`202`, default quando `async` omitido ou `true`):

```json
{
  "run": { "id": 1, "status": "running", "progress": {} },
  "queuePosition": 1
}
```

Response sucesso:

```json
{
  "run": {
    "id": 1,
    "strategy": "Minha Estrategia",
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

Query params:

```text
limit optional
strategy_id optional
strategy_version_id optional
status optional: queued/running/completed/partial/failed_runtime/cancelled
underlying optional
interval optional
pnl optional: positive/negative/zero
```

Response:

```json
{
  "runs": [
    {
      "id": 1,
      "strategy": "Minha Estrategia",
      "source": "lakehouse",
      "underlying": "BTC",
      "interval": "5m",
      "bookDepth": 10,
      "from": "2026-05-29T00:00:00.000Z",
      "to": "2026-05-30T00:00:00.000Z",
      "ticks": 5729,
      "batches": 2,
      "summary": {},
      "strategy_id": 12,
      "strategy_version_id": 44,
      "strategy_snapshot": {},
      "status": "completed",
      "created_at": "..."
    }
  ]
}
```

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
    "id": 1,
    "run_id": 1,
    "condition_id": "...",
    "event_start": "...",
    "event_end": "...",
    "side": "UP",
    "entries_count": 1,
    "exits_count": 1,
    "final_pnl": 2.4,
    "result": "win",
    "reason": "take_profit",
    "summary": {},
    "orders": [],
    "marks": [],
    "logs": [],
    "metrics": {}
  }
}
```

### `GET /api/stream`

SSE autenticado (cookie de sessão). Eventos:

```text
run:progress   — { runId, progress }
run:completed  — { runId, run }
run:failed     — { runId, run, error }
job:progress   — { jobId, status, progress }
job:completed  — { jobId, status }
job:failed     — { jobId, status, error }
```

### `GET /api/backtest/compare`

Query: `ids=1,2` (2–4 runs).

Response:

```json
{
  "runs": [{ "id": 1, "summary": {}, "equity": [] }],
  "delta_events": [{ "condition_id": "...", "pnl_a": 1, "pnl_b": 2, "delta": 1 }]
}
```

### `GET /api/backtest/runs/:id/analysis`

Response: `{ "analysis": { "by_reason": [], "worst_events": [], "pnl_by_hour": [], "histogram": [] } }`

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

## Strategy API

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
      "latest_version_id": 44,
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

### `DELETE /api/strategies/:id`

Remove a definicao e todas as versoes salvas da estrategia. Runs antigos continuam preservados em `backtest_runs`, porque guardam snapshot da versao executada.

Response:

```json
{
  "deleted": true,
  "strategy": {}
}
```

### `POST /api/strategies/:id/versions`

Cria um snapshot novo apenas quando `source_code` muda em relacao a versao mais recente. Codigo igual retorna `400 REQUEST_FAILED` com mensagem de `unchanged`.

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

### `DELETE /api/strategies/:id/versions/:versionId`

Remove uma versao somente quando ela nao e a ultima versao da estrategia e nao foi usada por nenhum backtest.

Response:

```json
{
  "deleted": true,
  "version": {}
}
```

Bloqueios retornam `400 REQUEST_FAILED`, por exemplo versao unica ou versao ja usada em runs.

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

### `GET /api/strategy-runtime/capabilities`

Retorna linguagens suportadas, template Strategy JS, blocos e contrato para IA.

Response:

```json
{
  "languages": ["gls-v1", "strategy-js-v1"],
  "default_language": "strategy-js-v1",
  "stdlib_version": "stdlib-v3",
  "compiler_version": "compiler-soa-v2",
  "blocks": [],
  "syntax": { "forbidden": ["import", "require"], "allowedHooks": ["onEventStart", "onTick", "onEventEnd"] },
  "template": "export default strategy({...})",
  "ai_contract": "..."
}
```

### `POST /api/strategies/convert-to-strategy-js`

Converte fonte GLS v1 para Strategy JS v1.

Request: `{ "source_code": "strategy \"X\" { ... }" }`

Response: `{ "source_code": "export default strategy({...})", "language": "strategy-js-v1" }`

### `GET /api/strategy-library`

Lista bibliotecas nativas versionadas (`strategy_library_*`).

Response:

```json
{
  "libraries": [
    {
      "slug": "edge-sniper-models",
      "name": "Edge Sniper Models",
      "versions": [{ "version": 1, "language": "native-bundled" }]
    }
  ]
}
```

### `GET /api/strategy-library/:slug`

Detalhe de uma biblioteca e suas versoes.

### `GET /api/strategies/:id/presets`

Query opcional: `strategy_version_id`. Lista presets da estrategia.

### `POST /api/strategies/:id/presets`

Request:

```json
{
  "strategy_version_id": 12,
  "name": "agressivo",
  "params": { "minEdge": 0.09 },
  "tags": ["btc"]
}
```

### `GET/PATCH/DELETE /api/strategies/:id/presets/:presetId`

CRUD de preset individual.

### Backtest com preset

`POST /api/backtest/run` e `POST /api/backtest/sweep` aceitam `preset_id` (opcional). Os `params` do preset sao mesclados sobre os defaults de `params_schema` da versao; `params` no body ainda pode sobrescrever.

Request exemplo:

```json
{
  "strategy_id": 1,
  "strategy_version_id": 2,
  "preset_id": 5,
  "from": "2026-06-01",
  "to": "2026-06-07",
  "underlying": "BTC",
  "interval": "5m"
}
```

### `GET /api/strategy-blocks`

Lista assinaturas MVP da biblioteca padrao GLS (somente leitura; CRUD de blocos customizados nao faz parte do MVP).

Response:

```json
{
  "blocks": [
    {
      "module": "market",
      "name": "distanceFromPtb",
      "signature": "market.distanceFromPtb(underlyingPrice, priceToBeat)",
      "description": "..."
    }
  ]
}
```

> Endpoints `POST/PATCH /api/strategy-blocks` permanecem fora do escopo MVP; a UI consome apenas `GET`.

## SQLite Schemas Consolidados

### `lake_manifest`

Ver `docs/implementacao/implementacao-lakehouse.md` para detalhes completos.

### `prepare_jobs`

Ver `docs/implementacao/implementacao-lakehouse.md` para detalhes completos.

### `backtest_runs`

Campos (ordem real do schema em `src/state/sqlite.js`, incluindo migracoes):

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
ticks
batches
summary_json
result_json
created_at
strategy_id
strategy_version_id
strategy_snapshot_json
dataset_request_json
status
error
duration_ms
```

`result_json` ainda contem o payload completo do runner, incluindo:

```json
{
  "strategy": "Minha Estrategia",
  "summary": {},
  "events": [],
  "equity": [],
  "log": []
}
```

O Event Explorer consome `backtest_event_traces` e endpoints dedicados (`/api/backtest/runs/:id/events`, `/chart-data`), nao parseia `result_json` na listagem.

`strategy_snapshot_json` guarda o codigo/params da versao GLS executada. Runs antigos podem nao ter snapshot completo e devem continuar legiveis no historico.

### `strategy_definitions`

```text
id
slug
name
description
status
tags_json
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

`created_by` fica reservado para autenticacao futura; nao entra no MVP.

Versoes GLS legadas podem incluir em `validation_json`:

```json
{
  "execution_kind": "native-extension",
  "editable_logic": false
}
```

(Gamma Ladder e outras extensoes nativas.)

### `strategy_library_definitions`

```text
id
slug (unique)
name
description
status
created_at
updated_at
```

### `strategy_library_versions`

```text
id
library_id
version
language
source_code
validation_json
compiled_json
checksum
created_at
```

### `strategy_presets`

```text
id
strategy_id
strategy_version_id
name
params_json
tags_json
created_at
```

Presets separam ajuste de parametros da logica versionada em `strategy_versions`.

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

## Data Coverage API (V3)

### `GET /api/data/coverage`

Query: `underlying`, `interval`, `dataset` (default `backtest_ticks`), `book_depth`, `from`, `to`, `full` (opcional: `1` expande ao historico completo do manifest para heatmap).

Sem `full=1`, responde apenas o intervalo pedido (mais rapido). A UI do heatmap usa `full=1`. Cache TTL 30s no servidor.

Response:

```json
{
  "coverage": {
    "underlying": "BTC",
    "interval": "5m",
    "days": [
      { "dt": "2026-06-01", "ui_state": "ready", "raw_status": "valid", "rows": 12000, "partitions": [] }
    ],
    "summary": { "ready": 1, "processing": 0, "attention": 0, "total": 1 }
  }
}
```

`ui_state` deriva de `manifest.status`: `ready` = valid|accepted; `processing` = pending|writing|rebuilding; `attention` = missing|invalid|needs_review|stale.

### `POST /api/data/fix`

Body: `{ "request": { dataset, from, to, underlying, interval, book_depth }, "dry_run": false, "confirm_rebuild": true }`.

Executa auto-accept (`acceptEligibleReviewPartitions`), monta plano prepare e enfileira job unico. Resposta inclui `summary_lines[]` legiveis.

## Strategy Stats API (V3)

### `GET /api/strategies?stats=1`

Lista estrategias com `stats` embutido (totals, sparkline, by_version).

### `GET /api/strategies/:id/stats`

```json
{
  "stats": {
    "strategy_id": 5,
    "totals": { "runs": 42, "win_rate": 0.58, "best_pnl": 812.4, "last_run_at": "..." },
    "sparkline": [12.5, -4.2],
    "by_version": [{ "version": 7, "runs": 9, "win_rate": 0.61, "avg_pnl": 34.2, "best_pnl": 812.4 }]
  }
}
```

### `POST /api/strategies/:id/fork`

Body opcional: `{ "versionId": 12, "name": "..." }`. Cria slug `*-fork` em status `draft` com v1 = codigo da versao escolhida.

### `strategy_versions.notes`

Campo opcional ao `POST /api/strategies/:id/versions` (`notes` texto).

### `strategy_definitions.pinned`

`PATCH /api/strategies/:id` com `{ "pinned": true }` para favoritos na biblioteca.

### Backtest run dependente de job

`POST /api/backtest/run` aceita `depends_on_job` (ou `wait_for_job`) quando `async: true`; o run permanece `queued` ate `job:completed`.

## Compatibility Rules

- Nao remover campos existentes de resposta sem migracao clara.
- Novos campos devem ser opcionais inicialmente.
- Backtest Studio deve aceitar runs antigos sem `strategy_id`.
- UI deve tratar `strategy_id=null` como historico sem snapshot versionado.
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
