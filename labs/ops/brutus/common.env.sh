# Variáveis compartilhadas pelos scripts Brutus (source via . common.env.sh)

# Resolvido em runtime pelos scripts (docker ps | grep le4sptof36h14ry6s5zet5v0)
# VARIANT_WORKERS: definir na linha de comando ou via run-benchmark-ab.sh (LAB_MAX_MODE=1)
: "${SWEEP_MAX_VARIANTS:=2000}"
: "${DUCKDB_THREADS:=8}"
: "${DUCKDB_MEMORY_LIMIT:=4GB}"
: "${DATASET_CACHE_MAX_MB:=4096}"
