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

### Como configurar no Coolify (recomendado)

Em cada app: **Configuration → Resource Limits** (nao deixar `0` = ilimitado).

| App | Number of CPUs | Memory limit (MB) |
|-----|----------------|-------------------|
| `data-backtest-app` | `12` | `10240` |
| `data-collector-app` | `4` | `2048` |
| `data-collector-db` | `0` (ilimitado) | `0` (ilimitado) |

Salve e **Redeploy** o app. Confira no servidor:

```bash
docker inspect <container> --format 'cpus={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}}'
```

Evite duplicar com **Custom Docker Options** (`--cpus`/`--memory`); use so Resource Limits.

### data-backtest-app — env de runtime (alem dos limites)

```text
NODE_OPTIONS=--max-old-space-size=7168
SYNC_BATCH_SIZE=50000
SYNC_MAX_POOL=2
SYNC_STATEMENT_TIMEOUT_MS=600000
PREPARE_MAX_CONCURRENT=2
SYNC_DUCKDB_THREADS=4
DUCKDB_THREADS=4
```

**Orçamento de CPU (V5):** `SYNC_DUCKDB_THREADS × PREPARE_MAX_CONCURRENT + DUCKDB_THREADS + BACKTEST_WORKERS × MAX_CONCURRENT_BACKTESTS ≤ vCPUs` do container.

Com `PREPARE_RUNNER=worker` (default), o export pesado roda fora do HTTP — pode usar `PREPARE_MAX_CONCURRENT=2` e `SYNC_DUCKDB_THREADS=4`–`6` em producao (12 vCPU). Use `PREPARE_MAX_CONCURRENT=1` e `SYNC_DUCKDB_THREADS=2` apenas se ainda estiver em `PREPARE_RUNNER=inline` ou em container muito limitado.

**Desempenho do sync**

| Variavel | Recomendado | Efeito |
|----------|-------------|--------|
| `NODE_OPTIONS` | `--max-old-space-size=7168` | heap Node para Parquet/DuckDB (ajuste ~70% da RAM do container) |
| `SYNC_STATEMENT_TIMEOUT_MS` | `600000` (10 min) | timeout das queries no Postgres fonte; sync real conta ticks |
| `SYNC_MAX_POOL` | `2` | conexoes RO ao colector; nao subir muito |
| `SYNC_BATCH_SIZE` | `50000` | reservado para batching futuro no export |
| `PREPARE_MAX_CONCURRENT` | `2` (producao com worker) | dias/particoes em paralelo no job |
| `SYNC_DUCKDB_THREADS` | `4`–`6` (producao) / `2` (container minimo) | threads DuckDB na escrita Parquet |
| `DUCKDB_THREADS` | `2`–`4` | pool de leitura (coverage, backtest) |
| `PREPARE_RUNNER` | `worker` (default) | `inline` apenas para rollback/debug |

**Dry-run** usa apenas `event_quality` (rapido). **Sync real** valida contando ticks — 1 dia BTC 15m leva ~1–3 min; ranges grandes rodam **1 particao/dia** em sequencia (nao precisa baixar dia a dia na UI, mas jobs muito longos podem ser melhor fatiados por semana).

**Intervalo na UI:** use `5m` / `15m` / `1h` / `4h`. Campo **Resolucao** so vale para dataset `ohlc`, nao para `backtest_ticks`.

## Variaveis Obrigatorias

```env
LAKE_ROOT=/lake
STATE_DB_PATH=/state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=25
DATA_BACKTEST_PORT=3100
NODE_ENV=production
SEED_PROMOTED_STRATEGIES=1
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

Se Resource Limits estiverem em `0` na UI, o container sobe sem teto. Fallback manual (so se a UI nao aplicar):

```bash
ssh Brutus 'BT=$(docker ps --filter name=le4sptof36h14ry6s5zet5v0 -q | head -1); DC=$(docker ps --filter name=du0z38giulbmy1jeexsxswba -q | head -1); docker update --cpus=12 --memory=10g --memory-swap=10g "$BT"; docker update --cpus=4 --memory=2g --memory-swap=2g "$DC"'
```

## Postgres: erro de shared memory no sync

Se o job de preparacao/sync falhar com:

```text
could not resize shared memory segment "/PostgreSQL...." to N bytes: No space left on device
```

**Nao e falta de disco.** O container `data-collector-db` usa o padrao Docker de **64 MiB** em `/dev/shm`. Consultas pesadas do sync (varios dias BTC 5m) pedem segmentos POSIX maiores e o Postgres estoura esse limite.

Conferir no servidor:

```bash
ssh Brutus 'docker inspect vgiav63o4y359d73hvzx3d1y --format "ShmSize={{.HostConfig.ShmSize}}"; docker exec vgiav63o4y359d73hvzx3d1y df -h /dev/shm'
```

Correcao persistente no Coolify:

1. Abra **data-collector-db** → **Configuration** → **Custom Docker Options**
2. Adicione: `--shm-size=1g` (ou `512m` minimo)
3. **Restart** o banco (recria o container com o novo `/dev/shm`; dados no volume permanecem)

O host tem ~16 GiB de `/dev/shm`; so o container do Postgres estava limitado.

## Backup

Antes de jobs grandes:

```bash
npm run ops:check
# backup de /data/goldenlens/lakehouse e /data/goldenlens/backtest-state
```
