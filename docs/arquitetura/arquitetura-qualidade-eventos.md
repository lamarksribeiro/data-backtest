# Qualidade de eventos — normalização nativa no sync



## Objetivo



O `data-backtest` lê ticks brutos do Postgres do `data-colector` e **normaliza automaticamente** antes de gravar Parquet. Não altera o coletor.



## Pipeline



1. `getScalarTicksForEvents` / `getTicksWithBooksForEvents` — leitura bruta

2. `applyTickNormalization` — por evento (`condition_id`)

3. `writeScalarsParquet` / derivados — só ticks exportáveis

4. `lake_manifest.quality_details_json` — relatório `normalization`



## Decisão por evento



A decisão de trim/omit usa **dois detectores espelhados** de dessincronia entre fontes. PTB ausente, feed incompleto nas bordas etc. **não** cortam ticks.



| % ticks a remover (`clob_stale` ∪ `underlying_stale`) | Ação |

|-------------------------------------------------------|------|

| `0%` | **keep** — exporta todos os ticks |

| `> 0%` e `< SYNC_NORMALIZE_OMIT_EVENT_RATIO` (padrão 50%) | **trim** — remove só os trechos ruins |

| `≥` limiar | **omit** — evento inteiro fora do Parquet |



## Análise 1 — `clob_stale` (CLOB travado, spot vivo)



Segmentos com up/down idênticos por ≥ `SYNC_NORMALIZE_MIN_STALE_SEC` (padrão 30s):



| Classificação | Trim? | Critério |

|---------------|-------|----------|

| `confirmed_quiet_market` | não | underlying também parado no trecho |

| `book_active` | não | mids planos mas bid/ask ainda mudam |

| `noise` | não | underlying moveu pouco demais |

| `clob_stale` | sim | mids **e** book planos, underlying moveu o suficiente |



## Análise 2 — `underlying_stale` (spot travado, CLOB vivo)



Segmentos com underlying estável por ≥ `SYNC_NORMALIZE_MIN_STALE_SEC`:



| Classificação | Trim? | Critério |

|---------------|-------|----------|

| `confirmed_quiet_market` | não | up/down também parados — mercado quieto |

| `noise` | não | CLOB moveu pouco demais |

| `underlying_stale` | sim | spot congelado mas up/down ou book mudam o suficiente |



Esse caso cobre falha de **uma fonte** (ex.: feed do BTC parado) enquanto o Polymarket continua atualizando — perigoso para backtests que usam `distanceFromPtb`.



## Limiares automáticos



| Sinal | Escala automática | Env opcional |

|-------|-------------------|--------------|

| Spot parado | ~0,008% do preço (mín. $5) | `SYNC_NORMALIZE_QUIET_UNDERLYING_MAX` |

| Spot moveu (CLOB stale) | ~0,025% do preço (mín. $20) | `SYNC_NORMALIZE_MIN_UNDERLYING_MOVE` |

| CLOB moveu (underlying stale) | 0,003 em probabilidade (0,3¢) | `SYNC_NORMALIZE_MIN_QUOTE_MOVE` |

| Duração mínima do trecho | 30s | `SYNC_NORMALIZE_MIN_STALE_SEC` |



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

SYNC_NORMALIZE_MIN_UNDERLYING_MOVE=

SYNC_NORMALIZE_QUIET_UNDERLYING_MAX=

SYNC_NORMALIZE_MIN_QUOTE_MOVE=

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



- heatmap por hora (`keep` / `omit` / `manual` — trim é automático e não altera a cor da hora)

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


