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
- A query layer deve nascer generica para servir backtests, labs e futuro `data-robot`.
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
  features/   (reservado para datasets de features derivadas; fase futura)
  manifests/  (snapshots exportados do manifest para portabilidade/rebuild; a fonte de verdade do manifest vive no SQLite em /state)
  .tmp/       (areas temporarias de escrita antes da publicacao atomica)
```

A fonte de verdade do manifest e o SQLite em `STATE_DB_PATH` (`/state`). O diretorio `/lake/manifests/` guarda apenas copias exportadas para permitir reconstruir o estado junto com os Parquet (ex.: ao restaurar um snapshot do disco).

## Datasets Parquet

### `scalars`

Dataset leve para filtros, previews, OHLC, verificacoes rapidas e estrategias que nao precisam de profundidade completa.

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
/lake/scalars/underlying=BTC/interval=5m/dt=2026-05-31/part-<run-id>.parquet
```

### `books`

Dataset com book completo, separado por ser pesado. Deve ser mantido por decisao explicita enquanto houver espaco, porque serve como arquivo analitico completo e permite reprocessar `backtest_ticks` com outro `book_depth` sem voltar ao Postgres.

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
/lake/books/underlying=BTC/interval=5m/dt=2026-05-31/part-<run-id>.parquet
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
/lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=10/dt=2026-05-31/part-<run-id>.parquet
```

Decisao de storage: manter `scalars`, `books` e `backtest_ticks` no primeiro desenho. Isso aumenta escrita e armazenamento, mas reduz CPU nos backtests, acelera previews/OHLC e preserva book completo para reconstrucoes. Se o espaco virar gargalo, `books` pode virar dataset sob demanda depois.

Precisao numerica: exportar precos como `DOUBLE` inicialmente, alinhado ao legado que usa `parseFloat`. Usar `DECIMAL` so se uma estrategia exigir paridade decimal exata.

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
/lake/ohlc/resolution=1s/underlying=BTC/interval=5m/dt=2026-05-31/part-<run-id>.parquet
```

## State Store E Manifest

O manifest controla quais particoes foram materializadas e validadas.

O state store deve ser SQLite em modo WAL, porque havera multiplos processos lendo e escrevendo metadados: sync, API e workers de backtest. DuckDB deve ser usado como engine de query sobre Parquet, nao como banco concorrente de estado.

Caminho:

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
resolution nullable
book_depth nullable
dt
active_path
run_id
rows
events_count
min_ts
max_ts
coverage_min
has_degraded
source_tick_count
source_condition_count
source_quality_recorded_at_max
source_fingerprint
status
created_at
verified_at
error
```

Campos importantes:

```text
active_path = arquivo versionado atualmente publicado para leitura
run_id = identificador da geracao do arquivo ativo
resolution = usado por OHLC; nulo para scalars/books/backtest_ticks
book_depth = usado por backtest_ticks; nulo para outros datasets
source_fingerprint = carimbo da origem usado para detectar stale
```

Status:

```text
missing
pending
writing
valid
invalid
needs_review
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
needs_review = divergencia operacional exige decisao antes de liberar
rebuilding = particao valida sendo reconstruida explicitamente
stale = origem mudou depois da materializacao e exige rebuild
```

O backtest deve consultar o manifest antes de executar. O caminho normal de execucao e sempre DuckDB + Parquet validado.

O query layer nao deve usar glob bruto como fonte de verdade, porque um rebuild pode deixar arquivos antigos e novos no mesmo diretorio. Ele deve resolver a lista de arquivos pelo manifest e ler apenas `active_path` de particoes `valid`.

Arquivos Parquet devem ser versionados por geracao:

```text
/lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=10/dt=2026-05-31/part-<run-id>.parquet
```

A publicacao e atomica no nivel do manifest:

```text
1. Escrever part-<new-run-id>.parquet em path temporario.
2. Validar arquivo novo.
3. Mover para o diretorio final.
4. Atualizar `active_path` no SQLite em uma transacao.
5. Backtests novos passam a ler o arquivo novo; os antigos seguem com a lista resolvida no inicio do run.
```

## Invalidacao E Stale

Scripts de manutencao do `data-colector`, como `db:backfill-ptb` e `db:repair-gap`, podem alterar ticks/eventos ja arquivados. Isso deve marcar o lakehouse como `stale`, caso contrario o Parquet diverge em silencio do Postgres.

Regras:

```text
1. Cada particao/evento materializado grava um `source_fingerprint`.
2. O fingerprint deve incluir contagem real de ticks, quantidade de condition_id, max(event_quality.recorded_at) e um checksum de valores das colunas mutaveis (ex.: price_to_beat, precos).
3. Scripts de reparo/backfill devem chamar endpoint dedicado para marcar eventos/particoes afetadas como stale.
4. O sync deve reprocessar particoes stale antes de publica-las novamente como valid.
5. Backtest em modo strict deve bloquear particoes stale.
6. Stale/rebuild de uma particao fonte deve cascatear para todos os datasets derivados dela: scalars -> ohlc; books -> backtest_ticks; mudanca na origem (ticks no Postgres) -> scalars, books, backtest_ticks e ohlc do periodo.
```

Atencao a reparos do tipo UPDATE: `db:backfill-ptb` preenche `price_to_beat` em linhas existentes sem mudar a contagem nem, necessariamente, `event_quality.recorded_at`. Um fingerprint baseado apenas em contagem + `recorded_at` nao detecta esse caso. Por isso o fingerprint inclui checksum de valores (regra 2) e os scripts de reparo/backfill devem chamar o endpoint de stale (regra 3) como defesa primaria.

Rede de seguranca - job de reconciliacao: um job periodico deve recalcular o `source_fingerprint` de particoes recentes e marcar `stale` quando houver drift, garantindo a correcao mesmo que algum script de manutencao (ou alteracao manual via SQL) nao tenha chamado o endpoint.

Endpoint dedicado sugerido no `data-colector`:

```text
POST /api/admin/archive/stale
body: { condition_ids: string[], reason: string, source: string }
```

Esse endpoint deve exigir API key de escopo estreito, dedicada ao `data-backtest`/manutencao, e registrar `audit_log`.

## Validacao De Paridade

`event_quality.ticks_recorded` e um indicador importante, mas nao deve ser a unica fonte de verdade de contagem. Ele pode divergir por `ON CONFLICT DO NOTHING`, inserts tardios ou reparos.

Validacao obrigatoria por particao:

```text
contagem real exportada por evento
contagem real total exportada
quantidade de condition_id distintos
min_ts e max_ts
comparacao informativa com event_quality.ticks_recorded
```

`ticks_recorded` deve ser tratado como valor esperado operacional. Se divergir, registrar alerta e marcar a particao como `invalid` ou `needs_review`, conforme tolerancia configurada. Para liberar backtest oficial, a contagem real por evento no Parquet deve bater com a contagem real consultada no Postgres no momento do export.

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
source_fingerprint
stale_reason
archived_at
verified_at
created_at
updated_at
```

A retencao so pode excluir dados do Postgres quando o evento estiver validado.

Status devem aceitar pelo menos:

```text
pending
valid
invalid
needs_review
stale
```

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
6. data-backtest valida contagem real por evento, condition_ids, min_ts, max_ts e compara com event_quality.ticks_recorded.
7. data-backtest grava manifest local com source_fingerprint.
8. data-backtest publica active_path atomicamente no manifest.
9. data-backtest informa event_archive_status no data-colector.
10. RetentionJob passa a considerar o evento elegivel.
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
/lake/.tmp/<dataset>/<run-id>/part-<run-id>.parquet
```

Path final somente depois da validacao:

```text
/lake/<dataset>/underlying=BTC/interval=5m/dt=2026-05-31/part-<run-id>.parquet
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

Observacao sobre liberacao real de espaco: `DELETE` por `condition_id` remove linhas, mas pode gerar bloat e nao devolver espaco ao sistema operacional imediatamente. Como `ticks` e particionada por mes, a forma mais efetiva de liberar espaco e `DROP PARTITION`, quando todos os eventos daquela particao estiverem arquivados e fora da janela quente.

Politica recomendada:

```text
MVP = dry-run + delete em lotes apenas para seguranca funcional
Producao madura = preferir DROP PARTITION inteira quando a particao estiver 100% arquivada
Futuro = avaliar particionamento semanal/diario se a granularidade mensal for grande demais
```

Antes de qualquer `DROP PARTITION`, exigir:

```text
todos os eventos da particao com archive valid
nenhuma particao lakehouse stale/invalid no periodo
backup/snapshot confirmado
dry-run aprovado na UI
confirmacao forte do operador
audit_log completo
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
- [ ] Criar banco local de estado em SQLite.
- [ ] Habilitar SQLite WAL para suportar API, sync e workers concorrentes.
- [ ] Criar tabela `lake_manifest`.
- [ ] Adicionar colunas `resolution`, `book_depth`, `active_path`, `run_id` e `source_fingerprint` no manifest.
- [ ] Implementar status `missing`, `pending`, `writing`, `valid`, `invalid`, `needs_review`, `rebuilding` e `stale`.
- [ ] Implementar publicacao atomica de `active_path` em transacao.
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
- [ ] Nomear arquivos como `part-<run-id>.parquet`.
- [ ] Escrever Parquet ZSTD com DuckDB.
- [ ] Registrar particao em `lake_manifest`.
- [ ] Validar contagem real total consultada no Postgres no momento do export.
- [ ] Validar contagem real por evento.
- [ ] Comparar `event_quality.ticks_recorded` como valor esperado operacional e registrar divergencias.
- [ ] Validar quantidade de eventos, `min_ts` e `max_ts`.
- [ ] Calcular e persistir `source_fingerprint` por particao/evento, incluindo checksum de valores mutaveis (price_to_beat, precos), nao so contagens.
- [ ] Implementar cascata de invalidacao: stale/rebuild da fonte propaga para datasets derivados (scalars->ohlc; books->backtest_ticks).
- [ ] Ignorar particoes `valid` em execucoes repetidas.
- [ ] Reprocessar particoes `writing` e `invalid`.
- [ ] Reprocessar particoes `stale`.
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
- [ ] Registrar cada resolucao de OHLC no manifest usando a coluna `resolution`.
- [ ] Criar query layer para candles.
- [ ] Substituir preview de grafico por OHLC onde aplicavel.
- [ ] Validar candles contra ticks brutos.

### Fase 5: Query Layer

- [ ] Criar interface `TickProvider`.
- [ ] Criar `DuckDbTickProvider`.
- [ ] Criar `PostgresTickProvider` para fallback.
- [ ] Criar `HybridTickProvider` futuro para live-tail.
- [ ] Criar verificador de disponibilidade no manifest antes de iniciar backtest.
- [ ] Resolver arquivos por `active_path` no manifest, nunca por glob bruto.
- [ ] Congelar a lista de arquivos no inicio do run para evitar troca durante rebuild.
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
- [ ] Garantir que o `TickProvider` seja generico o suficiente para futuro `data-robot`.
- [ ] Migrar um lab simples para a query layer nova.
- [ ] Migrar `edgeSniper` como primeiro golden test.
- [ ] Comparar resultado antigo vs novo.
- [ ] Registrar divergencias conhecidas.
- [ ] Migrar labs restantes por prioridade.

### Fase 7: Controle De Arquivamento No Data-Colector

- [ ] Criar migracao `event_archive_status`.
- [ ] Criar endpoint admin para receber status de arquivamento.
- [ ] Validar autenticacao por API key de escopo estreito, dedicada a archive/sync.
- [ ] Criar endpoint de consulta por periodo.
- [ ] Criar endpoint dedicado para marcar eventos/particoes como `stale`.
- [ ] Atualizar scripts de reparo/backfill do `data-colector` para marcar eventos afetados como `stale`.
- [ ] Criar job de reconciliacao periodica que recalcula `source_fingerprint` de particoes recentes e marca `stale` em caso de drift (rede de seguranca).
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
- [ ] Implementar dry-run para identificar particoes Postgres 100% arquivadas.
- [ ] Priorizar `DROP PARTITION` para liberacao real de espaco quando seguro.
- [ ] Manter delete em lotes apenas como alternativa operacional quando `DROP PARTITION` nao for aplicavel.
- [ ] Exigir backup/snapshot e confirmacao forte antes de `DROP PARTITION`.
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

### Fase 12: Opcional - Live-Tail Futuro

Nao bloqueia o MVP. Fazer apenas se for necessario backtest/replay ate os ultimos minutos ainda nao materializados.

- [ ] Implementar view DuckDB com Parquet selado.
- [ ] Adicionar uniao com Postgres recente.
- [ ] Definir janela live-tail, exemplo 15 ou 30 minutos.
- [ ] Garantir deduplicacao por `condition_id` e `ts`.
- [ ] Medir impacto no Postgres.
- [ ] Tornar opcional por configuracao.

### Fase 13: Opcional - Split Vertical Futuro No Data-Colector

Nao bloqueia o MVP. Fazer apenas se o Postgres continuar sofrendo com heap/TOAST/cache depois do lakehouse e da retencao segura.

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
- [ ] A contagem real do Parquet bate com a contagem real consultada no Postgres no momento do export.
- [ ] Divergencia entre contagem real e `event_quality.ticks_recorded` gera alerta e impede liberacao automatica quando ultrapassar tolerancia configurada.
- [ ] Reparo de gap ou backfill de PTB em evento arquivado marca a particao como `stale` e forca rebuild.
- [ ] Backfill de PTB (UPDATE sem mudar contagem) e detectado via checksum de valores no `source_fingerprint`.
- [ ] Stale/rebuild de uma particao fonte cascateia para os datasets derivados (ohlc, backtest_ticks).
- [ ] Job de reconciliacao detecta drift e marca `stale` mesmo sem chamada explicita ao endpoint.
- [ ] O query layer le arquivos resolvidos pelo manifest, nao por glob bruto.
- [ ] Rebuild troca `active_path` atomicamente sem expor arquivo parcial para backtests.
- [ ] Particoes ausentes ou invalidas bloqueiam backtest no modo `strict`.
- [ ] O modo `prepare` enfileira sync/rebuild e so roda depois da validacao.
- [ ] O DuckDB le o range com performance superior ao Postgres.
- [ ] O dataset `backtest_ticks` consegue alimentar uma estrategia que usa book.
- [ ] A retencao padrao e indefinida.
- [ ] Nenhum dado e apagado sem evento arquivado e validado.
- [ ] A tela permite configurar retencao e dry-run.
- [ ] Toda exclusao gera auditoria.
- [ ] Fluxo de retencao identifica quando uma particao Postgres inteira pode ser removida com `DROP PARTITION`.
- [ ] O lakehouse pode ser reconstruido por particao.

## Riscos E Mitigacoes

| Risco | Mitigacao |
|---|---|
| Muitos arquivos pequenos | Comecar com particao diaria e compactar depois |
| Parquet com JSON lento | Criar `backtest_ticks` flattenado |
| Sync competir com coleta | Usar read-only pool baixo ou replica |
| Exclusao acidental | Default indefinido, dry-run, confirmacao forte e exigencia de archive |
| Divergencia silenciosa apos reparo/backfill | Source fingerprint, status `stale` e rebuild obrigatorio |
| UPDATE que nao muda contagem (ex.: backfill PTB) | Checksum de valores no fingerprint + chamada ao endpoint stale + job de reconciliacao |
| Dataset derivado desatualizado apos rebuild da fonte | Cascata de invalidacao scalars->ohlc e books->backtest_ticks |
| Divergencia entre Postgres e Parquet | Contagem real por evento, condition_ids, min/max ts e golden tests |
| DuckDB ler arquivo parcial durante rebuild | Arquivos versionados e resolucao por `active_path` no manifest |
| Travamento do state store | SQLite WAL para metadados e DuckDB apenas para query Parquet |
| Lakehouse corrompido | Rebuild por particao a partir do Postgres ou backup |
| Backtest rodar com dados incompletos | Modo `strict` como padrao e bloqueio por manifest |
| Backfill historico demorar muito | Processar por dia/mercado, retomar de checkpoint e aumentar paralelismo aos poucos |
| DELETE nao liberar espaco real no Postgres | Preferir `DROP PARTITION` quando a particao estiver 100% arquivada |
| Complexidade excessiva | Entregar scalars primeiro, depois books, depois retencao real |

## Ordem Recomendada De Execucao

1. Criar `data-backtest` com estado, manifest e escrita em `/lake`.
2. Implementar SQLite WAL, manifest versionado e resolucao por `active_path`.
3. Implementar backfill historico de `scalars` por dia a partir de `event_quality`.
4. Implementar validacao real por evento e `source_fingerprint`.
5. Implementar sync incremental para manter o lakehouse atualizado apos o backfill.
6. Implementar invalidacao `stale` (com cascata para derivados e job de reconciliacao) para reparos/backfills.
7. Exportar `books` e `backtest_ticks`.
8. Criar query layer DuckDB com checagem de disponibilidade por manifest.
9. Implementar modos `strict` e `prepare`.
10. Migrar um lab legado e validar paridade.
11. Criar `event_archive_status`.
12. Criar configuracao e tela de retencao.
13. Ativar dry-run de retencao.
14. Ativar exclusao real somente apos validacao operacional.
15. Avaliar `DROP PARTITION` para liberar espaco real.
16. Avaliar live-tail e split vertical depois.
