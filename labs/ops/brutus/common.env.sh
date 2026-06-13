# Variáveis compartilhadas pelos scripts Brutus (source via . common.env.sh)

: "${LAB_CONTAINER:=le4sptof36h14ry6s5zet5v0-200808843339}"
: "${VARIANT_WORKERS:=32}"
: "${SWEEP_MAX_VARIANTS:=2000}"
: "${DUCKDB_THREADS:=8}"
: "${DUCKDB_MEMORY_LIMIT:=4GB}"
: "${DATASET_CACHE_MAX_MB:=4096}"
