# Deploy Do Data-Backtest No Coolify (Hulw)

## URL

- Producao: `https://backtest.fracta.online`

## Rede Interna

O `data-backtest` e o `data-collector-db` ficam na rede Docker `coolify`. A comunicacao com o Postgres **nao** usa URL publica.

```text
DATA_COLLECTOR_DATABASE_URL=postgres://data_backtest_ro:***@vgiav63o4y359d73hvzx3d1y:5432/data_collector
DATA_COLLECTOR_API_URL=http://du0z38giulbmy1jeexsxswba:3000
```

Hostnames internos (Coolify):

- Postgres: `vgiav63o4y359d73hvzx3d1y` (container `data-collector-db`)
- API data-colector: `du0z38giulbmy1jeexsxswba` (UUID do app)

## Seguranca Do Postgres

- Usuario dedicado `data_backtest_ro` com permissao **somente SELECT**
- Pool limitado (`SYNC_MAX_POOL=2`, maximo 4 no codigo)
- Sessao `default_transaction_read_only = on` em cada conexao
- `statement_timeout` configuravel

## Volumes No Host (Brutus)

```text
/data/goldenlens/lakehouse      -> /lake
/data/goldenlens/backtest-state -> /state
```

## Limites De Recurso (Brutus: 32 vCPU / 32 GiB)

Separacao por papel no host `data-lake-market`. O **backtest** e o app mais pesado (sync Parquet, DuckDB, runs); o **colector** e steady-state; o **robo** (futuro) prioriza latencia, nao batch.

| Servico | CPU (limite) | RAM (limite) | Observacao |
|---------|--------------|--------------|------------|
| `data-collector-db` (Postgres) | sem teto fixo | ~18 GiB em uso | cache de ticks; nao capar abaixo do uso atual |
| `data-collector-app` | 4 | 2 GiB | coleta + API |
| `data-backtest-app` | **12** | **10 GiB** | sync + backtest studio |
| `polymarket-robot` (futuro) | 4 (reservar) | 2 GiB (reservar) | conta real, baixa latencia |

Coolify: `custom_docker_run_options` nos apps (`--cpus=… --memory=…`).

### data-backtest-app (producao)

```text
custom_docker_run_options=--cpus=12 --memory=10g
NODE_OPTIONS=--max-old-space-size=7168
SYNC_BATCH_SIZE=50000
SYNC_MAX_POOL=2
SYNC_STATEMENT_TIMEOUT_MS=180000
```

### data-collector-app

```text
custom_docker_run_options=--cpus=4 --memory=2g
```

## Variaveis Obrigatorias

```env
LAKE_ROOT=/lake
STATE_DB_PATH=/state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=25
DATA_BACKTEST_PORT=3100
NODE_ENV=production
SESSION_SECRET=<segredo-longo>
SESSION_MAX_AGE_SEC=86400
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=<senha-forte>
DATA_COLLECTOR_DATABASE_URL=<interno read-only>
DATA_COLLECTOR_API_URL=http://du0z38giulbmy1jeexsxswba:3000
```

`DATA_COLLECTOR_ARCHIVE_API_KEY` e opcional (publicacao de archive status no colector).

## Healthcheck

- `GET /healthz` na porta `3100`

## Smoke Pos-Deploy

```bash
curl -fsS https://backtest.fracta.online/healthz
# login na UI, aba Dados, dry-run de 1 dia
```

## Backup

Antes de jobs grandes:

```bash
npm run ops:check
# backup de /data/goldenlens/lakehouse e /data/goldenlens/backtest-state
```
