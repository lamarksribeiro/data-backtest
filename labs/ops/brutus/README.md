# Operações remotas — Brutus

Scripts shell para rodar no host Brutus (via SSH). Executam `docker exec` no container `data-backtest`.

## Arquivos

| Script | Uso |
|---|---|
| `run-queue.sh` | Roda fila de experimentos (`LAB_QUEUE`) |
| `run-benchmark-ab.sh` | Benchmark ou sweep único; `LAB_MAX_MODE=1` usa 28 workers (32−4 reservados) |
| `run-remaining.sh` | Atalho: fila `brutus-remaining.txt` |
| `run-relaxed-only.sh` | Só relaxed-entry-finder |
| `wait-then-run.sh` | Espera marker no log e dispara próximo script |
| `pull-reports.sh` | `docker cp` dos relatórios para o PC |
| `common.env.sh` | Variáveis compartilhadas (container, workers, cache) |

## Filas por estratégia

Listas de experimentos ficam junto da estratégia:

```text
labs/strategies/<family>/<strategy-id>/queues/brutus-full.txt
labs/strategies/<family>/<strategy-id>/queues/brutus-remaining.txt
```

## Deploy no Brutus

```bash
# No repo local (paths relativos ao data-backtest)
scp labs/ops/brutus/*.sh Brutus:/tmp/labs-brutus/
ssh Brutus "sed -i 's/\r$//' /tmp/labs-brutus/*.sh ; chmod +x /tmp/labs-brutus/*.sh"

# Rodar fila completa (log opcional)
ssh Brutus "LAB_LOG=/tmp/lab-edge-sniper-brutus.log /tmp/labs-brutus/run-queue.sh" >> lab.log 2>&1

# Orquestrar relaxed após quality terminar
ssh Brutus "nohup /tmp/labs-brutus/wait-then-run.sh >> /tmp/lab-edge-sniper-brutus.log 2>&1 &"
```

Variáveis úteis: `LAB_CONTAINER`, `VARIANT_WORKERS`, `LAB_MAX_MODE`, `RESERVE_CPUS`, `BACKTEST_WORKERS`, `DATASET_CACHE_MAX_MB`, `LAB_QUEUE`, `LAB_LOG`, `LAB_WAIT_MARKER`, `LAB_NEXT_SCRIPT`.

## Performance (validado jun/2026)

Sweeps grandes rodam **mais rápido no Brutus** que no PC local:

| Ambiente | Workers | Modo | 375 variantes BTC |
|---|---|---|---|
| PC local | 8 | single-pass | ~15 min |
| Brutus | 28 | chunked-1d (`dailyMetrics: true`) | **~5,4 min** |

Recomendação:
- Reservar **4 CPUs** para `data-colector` → `RESERVE_CPUS=4` → **28 variant workers**
- `BACKTEST_WORKERS=1`, `DUCKDB_THREADS=4`
- Sweeps grandes: `"dailyMetrics": true` no JSON do experimento
- Fila default em `run-queue.sh`: `nproc - 4` workers se `VARIANT_WORKERS` não for passado

```bash
# Capacidade máxima (um experimento)
ssh Brutus "nohup env LAB_MAX_MODE=1 RESERVE_CPUS=4 BACKTEST_WORKERS=1 \
  LAB_EXPERIMENT=labs/strategies/edge/edge-sniper-v3/experiments/meu-sweep.json \
  LAB_LOG=/tmp/lab-benchmark.log /tmp/labs-brutus/run-benchmark-ab.sh >> /tmp/lab.nohup 2>&1 &"
```
