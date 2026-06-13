# Operações remotas — Brutus

Scripts shell para rodar no host Brutus (via SSH). Executam `docker exec` no container `data-backtest`.

## Arquivos

| Script | Uso |
|---|---|
| `run-queue.sh` | Roda fila de experimentos (`LAB_QUEUE`) |
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

Variáveis úteis: `LAB_CONTAINER`, `VARIANT_WORKERS`, `DATASET_CACHE_MAX_MB`, `LAB_QUEUE`, `LAB_LOG`, `LAB_WAIT_MARKER`, `LAB_NEXT_SCRIPT`.
