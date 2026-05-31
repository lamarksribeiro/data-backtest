# Arquitetura e Plano de Implementacao: Data Backtest Lakehouse

## Objetivo

Implementar uma arquitetura dual-store para o ecossistema GoldenLens:

- `data-colector`: fonte oficial OLTP, escrita confiavel, retencao operacional e API administrativa.
- `data-backtest`: lakehouse OLAP com Parquet/DuckDB, backtests rapidos, estrategias em blocos, UI visual e retencao segura do historico.

O Postgres continua sendo a fonte de verdade enquanto os dados estao na janela operacional. O lakehouse e derivado, validado e reconstruivel. Depois da validacao, dados antigos podem ser removidos do Postgres conforme configuracao administrativa.

## Principios

- O caminho de escrita do coletor nao deve ser alterado nas fases iniciais.
- Backtests nao devem competir com a coleta 24x7.
- Parquet deve ser a camada principal para historico analitico.
- Postgres deve manter uma janela quente configuravel.
- Exclusao do Postgres deve ser opcional, auditavel e condicionada a validacao do lakehouse.
- Opcao padrao deve ser retencao indefinida.
- Estrategias devem usar uma query layer unica, independente da origem fisica dos dados.
- Lakehouse deve ser reconstruivel a partir do Postgres enquanto os dados ainda existirem nele ou a partir de backups.

## Arquitetura Alvo

```text
data-colector
  PostgreSQL OLTP
  ticks
  events
  event_quality
  gap_audit
  retention_config
  event_archive_status
  API REST
  painel administrativo

data-backtest
  sync incremental
  manifest/checkpoints
  lakehouse Parquet
  DuckDB query layer
  engine de backtest
  estrategias em blocos
  API/UI
```

## Armazenamento No Coolify

Os arquivos Parquet devem ficar em volume persistente do host, fora da imagem Docker e fora do volume do Postgres.

Caminho recomendado no host:

```text
/data/goldenlens/lakehouse
```

Caminho dentro do container:

```text
/lake
```

Variaveis:

```env
LAKE_ROOT=/lake
STATE_DB_PATH=/state/data-backtest.db
```

Volumes recomendados:

```yaml
volumes:
  - /data/goldenlens/lakehouse:/lake
  - /data/goldenlens/backtest-state:/state
```

Layout:

```text
/lake/
  scalars/
  books/
  backtest_ticks/
  ohlc/
  features/
  manifests/
```

## Datasets Parquet

### `scalars`

Dataset leve para filtros, previews, OHLC e estrategias que nao precisam de profundidade completa.

Colunas:

```text
market_id
underlying
interval
condition_id
event_start
event_end
ts
underlying_price
price_to_beat
up_price
down_price
up_best_bid
up_best_ask
down_best_bid
down_best_ask
coverage
degraded
```

Layout:

```text
/lake/scalars/underlying=BTC/interval=5m/dt=2026-05-31/part-000.parquet
```

### `books`

Dataset com book completo, separado por ser pesado.

Colunas iniciais:

```text
market_id
underlying
interval
condition_id
event_start
ts
up_book_asks
up_book_bids
down_book_asks
down_book_bids
```

Layout:

```text
/lake/books/underlying=BTC/interval=5m/dt=2026-05-31/part-000.parquet
```

### `backtest_ticks`

Dataset otimizado para estrategias, especialmente porque quase todas usam book.

Recomendacao: nao armazenar book como JSON para o caminho rapido. Criar colunas flattenadas para top N niveis.

Exemplo para `book_depth=10`:

```text
up_ask_px_1
up_ask_sz_1
up_ask_px_2
up_ask_sz_2
...
up_bid_px_1
up_bid_sz_1
...
down_ask_px_1
down_ask_sz_1
...
down_bid_px_1
down_bid_sz_1
...
```

Layout:

```text
/lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=10/dt=2026-05-31/part-000.parquet
```

### `ohlc`

Dataset para graficos e preview rapido.

Resolucoes:

```text
1s
5s
1m
5m
```

Layout:

```text
/lake/ohlc/resolution=1s/underlying=BTC/interval=5m/dt=2026-05-31/part-000.parquet
```

## Manifest

O manifest controla quais particoes foram materializadas e validadas.

Pode comecar como SQLite ou DuckDB local em:

```text
/state/data-backtest.db
```

Tabela sugerida:

```text
lake_manifest
id
dataset
market_id
underlying
interval
dt
path
rows
events_count
min_ts
max_ts
coverage_min
has_degraded
status
created_at
verified_at
error
```

Status:

```text
missing
pending
writing
valid
invalid
rebuilding
stale
```

Semantica dos status:

```text
missing = ainda nao existe Parquet para a particao solicitada
pending = particao identificada e aguardando processamento
writing = escrita em andamento em arquivo temporario
valid = particao pronta, validada e liberada para backtest
invalid = tentativa falhou ou a validacao nao bateu
rebuilding = particao valida sendo reconstruida explicitamente
stale = origem mudou depois da materializacao e exige rebuild
```

O backtest deve consultar o manifest antes de executar. O caminho normal de execucao e sempre DuckDB + Parquet validado.

## Politica De Disponibilidade Dos Dados

O objetivo operacional e ter todo o historico existente no Postgres materializado em Parquet depois do backfill inicial. No primeiro deploy isso nao sera instantaneo: o `data-backtest` precisara converter o historico em lotes.

Depois do backfill, o sync incremental deve manter o lakehouse atualizado com pequeno atraso:

```text
evento fecha -> event_quality e gerado -> sync espera margem -> Parquet validado -> backtest disponivel
```

Backtests oficiais devem usar somente particoes `valid`. Se o periodo solicitado tiver particoes ausentes ou invalidas, o sistema deve bloquear a execucao normal e oferecer a preparacao dos dados.

Modos de dados suportados:

```text
strict = padrao; roda apenas se todo o periodo estiver em Parquet validado
prepare = enfileira sync/rebuild das particoes ausentes e roda depois que ficarem validas
hybrid = usa Parquet onde existe e Postgres onde falta; permitido apenas para debug/desenvolvimento
```

Configuracao recomendada para producao:

```env
BACKTEST_DATA_MODE=strict
```

Na UI de backtest, quando faltar dado, mostrar:

```text
Periodo solicitado
Particoes prontas
Particoes ausentes
Particoes invalidas
Acoes: preparar dados ausentes, reprocessar invalidos, rodar somente periodo disponivel
```

## Controle De Arquivamento

Criar tabela no `data-colector` para permitir retencao segura:

```text
event_archive_status
condition_id
market_id
event_start
event_end
scalars_status
books_status
backtest_ticks_status
ohlc_status
ticks_recorded
rows_scalars
rows_books
rows_backtest_ticks
manifest_path
archived_at
verified_at
created_at
updated_at
```

A retencao so pode excluir dados do Postgres quando o evento estiver validado.

## Retencao Configuravel Do Postgres

Criar configuracao administrativa persistida.

Campos sugeridos:

```text
retention_enabled boolean
postgres_retention_days integer nullable
require_lakehouse_archive boolean
require_books_archive boolean
require_backtest_ticks_archive boolean
delete_degraded_events boolean
dry_run boolean
delete_batch_size integer
retention_run_hour_utc integer
updated_at timestamptz
updated_by uuid
```

Semantica:

```text
retention_enabled = false significa nao excluir nunca
postgres_retention_days = null significa retencao indefinida
dry_run = true simula exclusao sem apagar
```

Defaults seguros:

```text
retention_enabled = false
postgres_retention_days = null
require_lakehouse_archive = true
require_books_archive = true
require_backtest_ticks_archive = true
delete_degraded_events = false
dry_run = true
delete_batch_size = 50000
retention_run_hour_utc = 3
```

## Tela De Configuracoes

Criar uma tela ou aba:

```text
Banco de Dados > Retencao
```

Controles:

```text
Nao excluir dados do Postgres
Excluir dados antigos apos N dias
So excluir eventos arquivados no lakehouse
Exigir books arquivados
Exigir backtest_ticks arquivado
Permitir excluir eventos degradados
Rodar em dry-run
Hora de execucao UTC
Tamanho do lote
Executar verificacao agora
Executar dry-run agora
```

Mostrar resumo:

```text
Eventos elegiveis para exclusao
Ticks elegiveis
Espaco estimado liberavel
Eventos bloqueados por falta de Parquet
Ultima execucao
Ultimo erro
```

## Fluxo De Sync

```text
1. data-colector grava ticks normalmente.
2. Evento termina.
3. event_quality registra cobertura.
4. data-backtest identifica eventos selados.
5. data-backtest gera scalars, books, backtest_ticks e ohlc.
6. data-backtest valida contagem contra event_quality.ticks_recorded.
7. data-backtest grava manifest local.
8. data-backtest informa event_archive_status no data-colector.
9. RetentionJob passa a considerar o evento elegivel.
```

## Backfill Historico Inicial

Como ja existe grande volume de dados no Postgres, a primeira carga do lakehouse deve ser um backfill historico controlado, nao uma conversao unica gigante.

Unidade de processamento:

```text
underlying + interval + dt
```

Exemplo de comando futuro:

```bash
data-backtest sync backfill --from 2026-05-01 --to 2026-05-31 --underlying BTC --interval 5m
```

Fluxo por dia/mercado/intervalo:

```text
1. Buscar eventos do dia em event_quality.
2. Buscar ticks desses eventos no Postgres.
3. Escrever Parquet em diretorio temporario.
4. Validar contagem, eventos, min_ts e max_ts.
5. Mover atomicamente para o path final.
6. Registrar lake_manifest como valid.
7. Publicar event_archive_status quando todos os datasets exigidos estiverem validos.
```

Arquivos temporarios:

```text
/lake/.tmp/<dataset>/<run-id>/part-000.parquet
```

Path final somente depois da validacao:

```text
/lake/<dataset>/underlying=BTC/interval=5m/dt=2026-05-31/part-000.parquet
```

Se o processo cair no meio, particoes `writing` ou `invalid` devem ser reprocessadas na proxima execucao. Particoes `valid` devem ser ignoradas, exceto quando o comando pedir `--rebuild`.

Para simplificar no inicio, o sync incremental pode regravar a particao diaria inteira enquanto o dia ainda esta aberto. Se isso ficar caro, evoluir para escrita por partes e compactacao diaria.

Configuracoes sugeridas:

```env
SYNC_MAX_PARALLEL_DAYS=1
SYNC_BATCH_SIZE=50000
SYNC_STATEMENT_TIMEOUT_MS=120000
SYNC_MARGIN_MINUTES=2
```

O paralelismo deve comecar baixo para nao pressionar o Postgres. Se houver replica de leitura, aumentar gradualmente.

## Fluxo De Retencao

```text
1. RetentionJob carrega retention_config.
2. Se retencao estiver desativada, nao faz nada.
3. Calcula cutoff por postgres_retention_days.
4. Busca eventos com event_end menor que cutoff.
5. Exige event_quality existente.
6. Exige event_archive_status validado conforme configuracao.
7. Se dry_run estiver ativo, apenas registra estimativa.
8. Se dry_run estiver desativado, apaga ticks em lotes.
9. Registra auditoria.
```

## Fases De Implementacao

### Fase 0: Decisoes E Preparacao

- [ ] Confirmar nome do novo projeto: `data-backtest`.
- [ ] Confirmar caminho do lakehouse no Coolify: `/data/goldenlens/lakehouse`.
- [ ] Confirmar caminho interno do container: `/lake`.
- [ ] Confirmar se o primeiro deploy usara o Postgres primario read-only ou uma replica.
- [ ] Confirmar janela inicial de retencao sugerida: indefinida.
- [ ] Confirmar book depth padrao para `backtest_ticks`: 10.
- [ ] Confirmar modo padrao de dados para backtest: `strict`.
- [ ] Confirmar data inicial do backfill historico a partir do primeiro evento no Postgres.

### Fase 1: Estado E Manifest Do Data-Backtest

- [ ] Criar estrutura inicial do `data-backtest`.
- [ ] Criar configuracao `LAKE_ROOT`.
- [ ] Criar configuracao `STATE_DB_PATH`.
- [ ] Criar banco local de estado.
- [ ] Criar tabela `lake_manifest`.
- [ ] Implementar status `missing`, `pending`, `writing`, `valid`, `invalid`, `rebuilding` e `stale`.
- [ ] Criar utilitario para resolver paths Hive partitioned.
- [ ] Criar healthcheck verificando acesso a `/lake`.
- [ ] Criar comando CLI para listar manifest.
- [ ] Criar comando CLI para validar permissoes de escrita.

### Fase 2: Backfill E Sync Inicial De Scalars

- [ ] Criar cliente read-only para Postgres do `data-colector`.
- [ ] Criar query de eventos selados baseada em `event_quality`.
- [ ] Criar comando `sync backfill --from --to --underlying --interval`.
- [ ] Criar export diario de `scalars`.
- [ ] Escrever primeiro em `/lake/.tmp` e mover para o path final apenas apos validacao.
- [ ] Escrever Parquet ZSTD com DuckDB.
- [ ] Registrar particao em `lake_manifest`.
- [ ] Validar `rows == sum(event_quality.ticks_recorded)`.
- [ ] Validar quantidade de eventos, `min_ts` e `max_ts`.
- [ ] Ignorar particoes `valid` em execucoes repetidas.
- [ ] Reprocessar particoes `writing` e `invalid`.
- [ ] Suportar rebuild de particao diaria.
- [ ] Suportar dry-run do sync.
- [ ] Implementar sync incremental com margem configuravel apos `event_quality`.
- [ ] Criar logs estruturados de sync.

### Fase 3: Books E Backtest Ticks

- [ ] Criar export Parquet de `books`.
- [ ] Definir parser de JSONB do book.
- [ ] Criar flatten do book para top N niveis.
- [ ] Criar dataset `backtest_ticks`.
- [ ] Validar contagem do `backtest_ticks`.
- [ ] Medir tamanho do Parquet gerado.
- [ ] Medir tempo de leitura DuckDB.
- [ ] Comparar performance contra leitura atual do Postgres.

### Fase 4: OHLC

- [ ] Criar geracao de candles 1s.
- [ ] Criar geracao de candles 5s.
- [ ] Criar geracao de candles 1m.
- [ ] Criar geracao de candles 5m.
- [ ] Criar query layer para candles.
- [ ] Substituir preview de grafico por OHLC onde aplicavel.
- [ ] Validar candles contra ticks brutos.

### Fase 5: Query Layer

- [ ] Criar interface `TickProvider`.
- [ ] Criar `DuckDbTickProvider`.
- [ ] Criar `PostgresTickProvider` para fallback.
- [ ] Criar `HybridTickProvider` futuro para live-tail.
- [ ] Criar verificador de disponibilidade no manifest antes de iniciar backtest.
- [ ] Implementar modo `strict` para bloquear execucao se faltar Parquet validado.
- [ ] Implementar modo `prepare` para enfileirar sync/rebuild antes de rodar.
- [ ] Restringir modo `hybrid` a debug/desenvolvimento.
- [ ] Implementar `streamTicks`.
- [ ] Implementar `streamEvents`.
- [ ] Implementar `streamCandles`.
- [ ] Implementar `includeBooks`.
- [ ] Implementar filtros por underlying, interval, from e to.
- [ ] Criar testes de paridade com dados pequenos.

### Fase 6: Integracao Com Labs Legados

- [ ] Mapear `getTicksForBacktestBatches` do `polymarket-test`.
- [ ] Criar adapter compativel no `data-backtest`.
- [ ] Migrar um lab simples para a query layer nova.
- [ ] Migrar `edgeSniper` como primeiro golden test.
- [ ] Comparar resultado antigo vs novo.
- [ ] Registrar divergencias conhecidas.
- [ ] Migrar labs restantes por prioridade.

### Fase 7: Controle De Arquivamento No Data-Colector

- [ ] Criar migracao `event_archive_status`.
- [ ] Criar endpoint admin para receber status de arquivamento.
- [ ] Validar autenticacao administrativa/API key server-side.
- [ ] Criar endpoint de consulta por periodo.
- [ ] Criar auditoria para atualizacoes de arquivamento.
- [ ] Atualizar `data-backtest` para publicar status validado.
- [ ] Criar testes de integracao.

### Fase 8: Retencao Configuravel

- [ ] Criar migracao de `retention_config`.
- [ ] Criar servico para ler e atualizar configuracao.
- [ ] Criar endpoint `GET /api/admin/retention/config`.
- [ ] Criar endpoint `PATCH /api/admin/retention/config`.
- [ ] Criar endpoint `POST /api/admin/retention/dry-run`.
- [ ] Criar endpoint `POST /api/admin/retention/run`.
- [ ] Alterar `retentionJob` para usar configuracao global.
- [ ] Garantir default de retencao indefinida.
- [ ] Garantir `dry_run = true` por padrao.
- [ ] Adicionar audit log para alteracoes.

### Fase 9: Tela De Retencao

- [ ] Criar aba `Retencao` em `Banco de Dados`.
- [ ] Renderizar configuracao atual.
- [ ] Permitir alternar retencao indefinida.
- [ ] Permitir configurar numero de dias.
- [ ] Permitir configurar requisitos de lakehouse.
- [ ] Mostrar estimativa de exclusao.
- [ ] Mostrar eventos bloqueados por falta de arquivamento.
- [ ] Mostrar se particoes Parquet ausentes/invalidas impedem exclusao.
- [ ] Adicionar botao de dry-run.
- [ ] Adicionar confirmacao forte para execucao real.
- [ ] Mostrar historico das ultimas execucoes.

### Fase 9.1: UI De Preparacao De Dados Para Backtest

- [ ] Mostrar disponibilidade do periodo solicitado antes de rodar backtest.
- [ ] Mostrar particoes prontas, ausentes e invalidas.
- [ ] Adicionar acao `Preparar dados ausentes e rodar`.
- [ ] Adicionar acao `Reprocessar invalidos`.
- [ ] Bloquear execucao normal no modo `strict` quando faltar Parquet.
- [ ] Exibir progresso do sync/rebuild antes da execucao do backtest.

### Fase 10: Exclusao Segura Do Postgres

- [ ] Criar query de eventos elegiveis.
- [ ] Criar delete em lotes por `condition_id`.
- [ ] Proteger contra exclusao de eventos nao arquivados.
- [ ] Proteger contra exclusao se `event_quality` estiver ausente.
- [ ] Registrar quantidade apagada por evento.
- [ ] Registrar espaco estimado liberado.
- [ ] Registrar erros por evento sem abortar tudo.
- [ ] Adicionar metricas no health.
- [ ] Testar com dry-run.
- [ ] Habilitar execucao real somente apos validacao.

### Fase 11: Operacao No Coolify

- [ ] Criar volume persistente `/data/goldenlens/lakehouse`.
- [ ] Criar volume persistente `/data/goldenlens/backtest-state`.
- [ ] Configurar `LAKE_ROOT=/lake`.
- [ ] Configurar `STATE_DB_PATH=/state/data-backtest.db`.
- [ ] Configurar credenciais read-only do Postgres.
- [ ] Configurar healthcheck do `data-backtest`.
- [ ] Configurar backup do lakehouse ou snapshot do disco.
- [ ] Documentar restauracao.
- [ ] Documentar rebuild do lakehouse.
- [ ] Documentar limpeza manual segura.

### Fase 12: Live-Tail Futuro

- [ ] Implementar view DuckDB com Parquet selado.
- [ ] Adicionar uniao com Postgres recente.
- [ ] Definir janela live-tail, exemplo 15 ou 30 minutos.
- [ ] Garantir deduplicacao por `condition_id` e `ts`.
- [ ] Medir impacto no Postgres.
- [ ] Tornar opcional por configuracao.

### Fase 13: Split Vertical Futuro No Data-Colector

- [ ] Criar tabela `tick_books`.
- [ ] Criar view `ticks_full`.
- [ ] Alterar recorder para dual-write.
- [ ] Manter compatibilidade das rotas atuais.
- [ ] Medir reducao de heap/cache em `ticks`.
- [ ] Nao remover JSONB antigo ate validacao completa.
- [ ] Fazer expand-contract sem alteracao bloqueante.
- [ ] Decidir se vale manter ou descartar apos o lakehouse.

## Criterios De Aceite

- [ ] O coletor continua gravando sem alteracao de performance perceptivel nas fases iniciais.
- [ ] O `data-backtest` gera Parquet para pelo menos um dia completo de BTC 5m.
- [ ] O backfill historico consegue retomar apos falha sem duplicar particoes validas.
- [ ] A contagem do Parquet bate com `event_quality.ticks_recorded`.
- [ ] Particoes ausentes ou invalidas bloqueiam backtest no modo `strict`.
- [ ] O modo `prepare` enfileira sync/rebuild e so roda depois da validacao.
- [ ] O DuckDB le o range com performance superior ao Postgres.
- [ ] O dataset `backtest_ticks` consegue alimentar uma estrategia que usa book.
- [ ] A retencao padrao e indefinida.
- [ ] Nenhum dado e apagado sem evento arquivado e validado.
- [ ] A tela permite configurar retencao e dry-run.
- [ ] Toda exclusao gera auditoria.
- [ ] O lakehouse pode ser reconstruido por particao.

## Riscos E Mitigacoes

| Risco | Mitigacao |
|---|---|
| Muitos arquivos pequenos | Comecar com particao diaria e compactar depois |
| Parquet com JSON lento | Criar `backtest_ticks` flattenado |
| Sync competir com coleta | Usar read-only pool baixo ou replica |
| Exclusao acidental | Default indefinido, dry-run, confirmacao forte e exigencia de archive |
| Divergencia entre Postgres e Parquet | Manifest, contagem, min/max ts e golden tests |
| Lakehouse corrompido | Rebuild por particao a partir do Postgres ou backup |
| Backtest rodar com dados incompletos | Modo `strict` como padrao e bloqueio por manifest |
| Backfill historico demorar muito | Processar por dia/mercado, retomar de checkpoint e aumentar paralelismo aos poucos |
| Complexidade excessiva | Entregar scalars primeiro, depois books, depois retencao real |

## Ordem Recomendada De Execucao

1. Criar `data-backtest` com estado, manifest e escrita em `/lake`.
2. Implementar backfill historico de `scalars` por dia a partir de `event_quality`.
3. Implementar sync incremental para manter o lakehouse atualizado apos o backfill.
4. Exportar `books` e `backtest_ticks`.
5. Criar query layer DuckDB com checagem de disponibilidade por manifest.
6. Implementar modos `strict` e `prepare`.
7. Migrar um lab legado e validar paridade.
8. Criar `event_archive_status`.
9. Criar configuracao e tela de retencao.
10. Ativar dry-run de retencao.
11. Ativar exclusao real somente apos validacao operacional.
12. Avaliar live-tail e split vertical depois.
