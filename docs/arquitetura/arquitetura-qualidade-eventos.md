# Qualidade de eventos — normalização nativa no sync

## Objetivo

O `data-backtest` lê ticks brutos do Postgres do `data-colector` e **normaliza automaticamente** antes de gravar Parquet. Não altera o coletor.

## Pipeline

1. `getScalarTicksForEvents` / `getTicksWithBooksForEvents` — leitura bruta
2. `applyTickNormalization` — por evento (`condition_id`)
3. `writeScalarsParquet` / derivados — só ticks exportáveis
4. `lake_manifest.quality_details_json` — relatório `normalization`

## Decisão por evento

| % ticks ruins | Ação |
|---------------|------|
| `< SYNC_NORMALIZE_OMIT_EVENT_RATIO` (padrão 50%) | **trim** — exporta ticks bons |
| `≥` limiar | **omit** — evento inteiro fora do Parquet |
| 0% | **keep** |

## Tick ruim

- `null_underlying` — quotes sem underlying
- `outcome_missing` — underlying sem up/down
- `ptb_missing` — sem price_to_beat válido (> 1000)
- `quote_invalid` — bid/ask inválidos
- `clob_stale` — streak ≥ `SYNC_NORMALIZE_MIN_STALE_SEC` (30s) com quotes idênticos e underlying se movendo

## Status do manifest

Após normalização, divergência de contagem vs `event_quality` é **esperada** → partição fica `valid`.

`needs_review` só se:

- zero eventos exportados, ou
- `skip_ratio` do dia > `SYNC_NORMALIZE_DAY_OMIT_RATIO` (50%)

## Re-sync

Fingerprint do Postgres muda → partição `stale` → rebuild re-normaliza. Se o banco foi corrigido, o Parquet reflete sem aprovação manual.

## Variáveis de ambiente

```env
SYNC_NORMALIZE_OMIT_EVENT_RATIO=0.5
SYNC_NORMALIZE_DAY_OMIT_RATIO=0.5
SYNC_NORMALIZE_MIN_STALE_SEC=30
SYNC_NORMALIZE_MIN_PTB=1000
SYNC_NORMALIZE_UNDERLYING_EPSILON=0.01
```

## Exclusão manual (Q5)

Operador pode excluir um `condition_id` quando a normalização automática não detecta o problema.

1. `POST /api/quality/exclude` grava em `event_exclusions` (SQLite) e marca a partição do dia como `stale`
2. Um job `prepare` re-sincroniza só aquele `dt`
3. `applyTickNormalization` aplica `manualExcludedConditionIds` **depois** da normalização automática — evento não entra no Parquet
4. `POST /api/quality/restore` remove a exclusão e dispara re-sync

### API

| Rota | Uso |
|------|-----|
| `GET /api/quality/day-events?dt=&underlying=&interval=` | Eventos do Postgres + status auto + exclusões |
| `GET /api/quality/exclusions?dt=&underlying=&interval=` | Só exclusões manuais |
| `POST /api/quality/exclude` | Body: `condition_id`, `event_start`, `dt`, `underlying`, `interval`, `book_depth` |
| `POST /api/quality/restore` | Body: `condition_id`, `dt`, `underlying`, `interval` |

Requer `DATA_COLLECTOR_DATABASE_URL`.

### UI (tela Dados)

Drawer do dia na grade de cobertura:

- heatmap por hora (`keep` / `trim` / `omit` / `manual`)
- tabela de eventos com botões Excluir / Restaurar
- filtro por hora ao clicar no heatmap

## Módulos

- `src/quality/tickUsable.js`
- `src/quality/clobStale.js`
- `src/quality/normalizeEvent.js`
- `src/quality/normalizePartition.js`
- `src/quality/dayEvents.js`
- `src/sync/applyNormalization.js`
- `src/state/eventExclusions.js`
- `src/api/qualityHandlers.js`
