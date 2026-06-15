# Operacao Do Lakehouse Data-Backtest

## Objetivo

Definir como operar o lakehouse do `data-backtest` de forma segura, previsivel e reprodutivel.

Este documento cobre:

- backfill historico;
- sync incremental;
- manifest;
- validacao de datasets;
- rebuild;
- stale;
- needs_review;
- backups;
- restore;
- limpeza segura do proprio lakehouse;
- runbooks de incidentes.

Este documento nao assume que dados antigos serao apagados do Postgres. O Postgres continua sendo a fonte oficial operacional. O lakehouse e uma camada derivada e validada para backtests, analises e arquivamento.

## Componentes Operacionais

```text
data-colector/Postgres
  fonte oficial operacional
  events/ticks/event_quality

data-backtest/Parquet
  lakehouse analitico
  scalars/books/backtest_ticks/ohlc

data-backtest/SQLite
  state store
  lake_manifest
  prepare_jobs
  backtest_runs
```

## Variaveis Importantes

Local:

```env
LAKE_ROOT=./lake
STATE_DB_PATH=./state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=10
DATA_COLLECTOR_DATABASE_URL=...
DATA_COLLECTOR_API_URL=http://localhost:3000
DATA_COLLECTOR_ARCHIVE_API_KEY=...
SESSION_SECRET=change-me-to-a-long-random-string
SESSION_MAX_AGE_SEC=86400
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=change-me
```

Coolify/producao:

```env
LAKE_ROOT=/lake
STATE_DB_PATH=/state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=10
SESSION_SECRET=<segredo-longo-aleatorio>
SESSION_MAX_AGE_SEC=86400
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=<senha-forte>
```

## Autenticacao Da UI

A interface web exige login antes de acessar rotas e `/api/*` (exceto `POST /api/login`, `GET /api/me` e `GET /healthz`). O padrao e cookie HMAC + bcrypt, alinhado ao `data-colector`.

1. Defina `SESSION_SECRET` (obrigatorio em producao; o servidor recusa subir sem ele fora de `TEST_MODE`).
2. Na primeira subida com tabela `users` vazia, o servidor cria o admin com `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`.
3. Acesse `/login`; `GET /` redireciona para la sem sessao.
4. Rotas `/api/*` protegidas retornam `401 UNAUTHORIZED` sem cookie valido.

`docker-compose.yml` do repositorio **nao** inclui `SESSION_*` por padrao — injete essas variaveis no compose local ou no Coolify antes de expor a UI na rede. Testes (`npm test`) usam `TEST_MODE=true` e ignoram auth.

Volumes recomendados:

```text
/data/goldenlens/lakehouse      -> /lake
/data/goldenlens/backtest-state -> /state
```

## Regra De Ouro

Backtests e queries so podem ler Parquet por `active_path` registrado como `valid` no `lake_manifest`.

```text
Nunca usar glob direto do diretorio /lake para rodar backtest.
```

## Ordem Dos Datasets

Ordem recomendada para preparar dados:

```text
1. scalars
2. books
3. backtest_ticks
4. ohlc
```

Motivo:

- `scalars` e a base leve e serve para OHLC;
- `books` preserva book bruto;
- `backtest_ticks` e o dataset otimizado para estrategias;
- `ohlc` e derivado para graficos/previews.

## Backfill Historico

### Estrategia Recomendada

Rodar por janelas pequenas e retomaveis.

Primeira abordagem:

```text
underlying=BTC
interval=5m
range diario
book_depth=10
```

Depois repetir para ETH ou outros mercados.

### Sequencia Por Dia

Para cada dia:

```bash
npm run sync:backfill -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --dry-run
npm run sync:backfill-books -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --dry-run
npm run sync:backfill-backtest-ticks -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --dry-run
npm run sync:backfill-ohlc -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --resolution 1m --dry-run
```

Se o dry-run estiver correto, repetir sem `--dry-run`.

### Backfill Real

```bash
npm run sync:backfill -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m
npm run sync:backfill-books -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m
npm run sync:backfill-backtest-ticks -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10
npm run sync:backfill-ohlc -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --resolution 1m
```

### Backfill Em Lotes

Para ranges maiores, processar em blocos diarios ou semanais.

Regras:

- comecar por 1 dia;
- validar manifest;
- aumentar para 3-7 dias se estiver estavel;
- evitar paralelismo alto no Postgres primario;
- preferir replica/read-only no futuro se o volume crescer.

## Sync Incremental

O incremental materializa eventos recentes que ja estao selados por `event_quality`.

Exemplo:

```bash
npm run sync:incremental -- --lookback-days 2 --underlying BTC --interval 5m --dry-run
```

Depois:

```bash
npm run sync:incremental -- --lookback-days 2 --underlying BTC --interval 5m
```

Configuracao relevante:

```env
SYNC_MARGIN_MINUTES=2
```

Essa margem evita materializar eventos ainda instaveis.

## Manifest

O `lake_manifest` e a fonte oficial de quais arquivos podem ser lidos.

Consultar manifest:

```bash
npm run manifest:list -- --status valid --limit 50
```

Checar health:

```bash
npm run health
```

Checar disponibilidade:

```bash
npm run query:availability -- --dataset backtest_ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10
```

## Ciclo De Vida Da Particao

Fluxo normal:

```text
missing -> writing -> valid
```

Fluxo com problema:

```text
missing -> writing -> invalid
missing -> writing -> needs_review
```

Fluxo apos mudanca na origem:

```text
valid -> stale -> rebuilding -> valid
```

## Status E Acoes

### `missing`

Particao ainda nao existe.

Acao:

```text
rodar prepare/sync
```

### `valid`

Particao pronta para query/backtest.

Acao:

```text
nenhuma
```

### `stale`

A origem mudou ou foi marcada como alterada.

Acao:

```text
rodar rebuild com confirmacao
```

### `invalid`

Falha tecnica de escrita/validacao.

Acao:

```text
investigar erro e reprocessar
```

### `needs_review`

Divergencia detectada que nao deve ser sobrescrita automaticamente.

Acao:

```text
analisar causa antes de rebuild
```

## Validacao Por Dataset

### `scalars`

Validar:

- eventos esperados;
- rows reais;
- min/max ts;
- `source_fingerprint`;
- checksum de campos mutaveis como `price_to_beat` e precos.

### `books`

Validar:

- eventos esperados;
- rows reais;
- parse de books;
- checksum do book bruto;
- Parquet legivel.

### `backtest_ticks`

Validar:

- eventos esperados;
- rows reais;
- `book_depth` correto;
- colunas top-N existentes;
- checksum de precos/books flattenados;
- Parquet legivel;
- publish opcional para archive API.

### `ohlc`

Validar:

- deriva apenas de `scalars` validos;
- resolucao correta;
- candles legiveis;
- status acompanha stale de `scalars`.

## Rebuild

Rebuild deve trocar `active_path` atomicamente.

Nunca sobrescrever arquivo ativo em uso.

Fluxo:

```text
1. criar novo run_id
2. escrever em /lake/.tmp
3. validar novo Parquet
4. mover para path final versionado
5. atualizar active_path no manifest
6. manter arquivo antigo ate politica de limpeza
```

### Rebuild Via UI/API

Execucao real com rebuild exige confirmacao:

```text
REBUILD_PARTITIONS
```

### Rebuild Via CLI

```bash
npm run sync:backfill-backtest-ticks -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --rebuild
```

## Needs Review

`needs_review` nao deve ser tratado como erro simples.

Pode indicar:

- contagem divergente;
- eventos com qualidade incompleta;
- reparo parcial na origem;
- problema real de dados;
- book ausente/incompleto;
- PTB corrigido depois da primeira materializacao.

Runbook:

```text
1. listar manifest com needs_review
2. verificar erro/source_fingerprint
3. comparar contagem Postgres vs manifest
4. verificar event_quality
5. decidir se a origem esta correta
6. se sim, rebuild confirmado
7. se nao, reparar data-colector primeiro
```

## Stale

Uma particao vira `stale` quando a origem muda depois do arquivo Parquet estar validado.

Exemplos:

- reparo de `price_to_beat`;
- backfill de ticks faltantes;
- correcao de books;
- reconciliacao detectou fingerprint diferente;
- endpoint archive/stale foi chamado pelo `data-colector`.

Regras de cascata:

```text
scalars stale -> ohlc stale
books stale   -> backtest_ticks stale
```

## Prepare Jobs

Prepare jobs sao a forma recomendada para a UI preparar dados.

Tabela:

```text
prepare_jobs
```

Estados:

```text
queued
running
completed
failed
```

Usar `dry-run` por padrao.

## Backups

Backups importantes:

```text
/lake
/state/data-backtest.db
```

O backup do lake sem o SQLite perde o indice operacional.

O backup do SQLite sem o lake perde os arquivos apontados pelo manifest.

Recomendacao:

```text
snapshot consistente de /lake e /state juntos
```

## Restore

Fluxo de restore:

```text
1. parar API/sync do data-backtest
2. restaurar /lake
3. restaurar /state/data-backtest.db
4. subir API
5. rodar npm run health
6. rodar query:availability em ranges conhecidos
7. rodar smoke de backtest pequeno
```

Se o SQLite for perdido mas o lake existir, o manifest precisa ser reconstruido a partir de snapshots/export futuro ou por reprocessamento. Por isso o backup conjunto e importante.

## Limpeza Do Lakehouse

Nao apagar arquivos Parquet manualmente se eles estiverem referenciados por `active_path`.

Politica futura recomendada:

- manter versoes antigas por alguns dias apos rebuild;
- identificar arquivos orfaos nao referenciados pelo manifest;
- dry-run antes de apagar;
- nunca apagar `active_path` valido;
- registrar auditoria de limpeza.

Enquanto essa rotina nao existir, evitar limpeza manual.

## Operacao Local Temporaria

Para validacoes sem poluir lake real:

```env
LAKE_ROOT=C:\Users\lamar\AppData\Local\Temp\opencode\data-backtest-job-...\lake
STATE_DB_PATH=C:\Users\lamar\AppData\Local\Temp\opencode\data-backtest-job-...\state\data-backtest.db
DATA_BACKTEST_PORT=3101
```

Durante validacao temporaria, se nao quiser publicar archive status:

```env
DATA_COLLECTOR_API_URL=
DATA_COLLECTOR_ARCHIVE_API_KEY=
```

## Runbooks Rapidos

### Dados Faltando Para Backtest

```text
1. query:availability
2. se missing, rodar prepare dry-run
3. revisar plano
4. rodar prepare real
5. consultar availability novamente
6. rodar backtest
```

### Particao Stale

```text
1. listar manifest status=stale
2. entender origem da mudanca
3. rodar dry-run com rebuild
4. rodar rebuild confirmado
5. validar active_path novo
6. executar smoke de query/backtest
```

### Particao Needs Review

```text
1. nao sobrescrever automaticamente
2. checar event_quality
3. checar contagem real no Postgres
4. checar se houve reparo no data-colector
5. reparar origem se necessario
6. rebuild apenas depois da analise
```

### Suspeita De Corrupcao Do Lake

```text
1. parar syncs
2. rodar health
3. listar manifest invalid/stale/needs_review
4. verificar existencia dos active_path
5. rodar query pequena DuckDB
6. restaurar backup ou rebuild por particao
```

## Backup Telegram (`backtest_ticks`)

Backup incremental por ativo (`underlying`) enviando Parquet ZSTD para um **canal privado** do Telegram, com catálogo JSON autocontido para restore sem Postgres/Brutus.

### Setup do canal

1. Criar bot dedicado via @BotFather.
2. Criar canal privado (ex.: `GoldenLens Backtest Backup`).
3. Adicionar o bot como **administrador** com permissão de postar.
4. Obter `chat_id` do canal (formato `-100…`).
5. Configurar em **Configurações → Backup Telegram** ou via env:

```env
TELEGRAM_BACKUP_BOT_TOKEN=
TELEGRAM_BACKUP_CHAT_ID=-100xxxxxxxxxx
TELEGRAM_BACKUP_ENABLED=false
```

### Chunking e limite de download

O Bot API do Telegram **só permite baixar arquivos de até ~20 MB** (`getFile`). O envio aceita até ~50 MB, mas o restore falha com `file is too big` se a partição foi enviada inteira acima de 20 MB.

- Chunk padrão: **18 MB** (`TELEGRAM_BACKUP_MAX_CHUNK_BYTES=18874368`)
- Partições maiores são divididas automaticamente no upload
- Backups antigos enviados sem chunk precisam de **novo backup completo** (desmarque “Incremental” na UI ou use `--force` na CLI) antes de restaurar

- Parquet `backtest_ticks` (partições `valid`/`accepted`)
- Sidecar JSON por partição (manifest + sha256)
- `catalog-{UNDERLYING}.json` por ativo
- `master_catalog.json` (fixado no canal quando habilitado)
- `event_exclusions` filtradas por ativo

### CLI

```bash
npm run backup:telegram -- --underlying BTC --interval 5m --book-depth 25 --incremental
npm run backup:telegram -- --all-underlyings --incremental
npm run backup:telegram:restore -- --run-id br-... 
npm run backup:telegram:restore -- --master-file-id <file_id>
npm run backup:telegram:verify -- --run-id br-...
```

Antes do primeiro backup: `npm run ops:check`.

### Limpar histórico local

Na UI (**Configurações → Backup Telegram → Limpar histórico local**) ou `POST /api/backup/telegram/clear-local` com `{ "confirm": true }`.

Remove runs, artifacts e o marcador de agendamento diário no SQLite. **Não** apaga mensagens no canal Telegram nem Parquets do lake.

### Restore em instalação nova

1. Configurar `LAKE_ROOT`, `STATE_DB_PATH` e credenciais Telegram (**mesmo bot** que enviou o backup).
2. Abrir **Configurações → Backup Telegram** — a app detecta automaticamente o `master_catalog.json` **fixado no canal** (ou clique em **Atualizar detecção**).
3. **Restaurar do Telegram** → opção **Backup detectado no canal**.
4. `npm run ops:check` + `query:availability` + smoke de backtest.

Se o catálogo não estiver fixado: fixe a mensagem `master_catalog.json` no canal (opção “Fixar catálogo mestre”) ou cole o `file_id` manualmente.

### Restore em instalação nova (CLI)

```bash
npm run backup:telegram:restore -- --master-file-id <file_id>
```

**Importante:** manter o mesmo bot token usado no upload; `file_id` é válido para o bot que enviou o arquivo.

## Criterios Para Considerar O Lake Operacional

- Healthcheck OK.
- `/lake` e `/state` persistentes.
- Manifest com particoes `valid` para ranges esperados.
- Query layer le apenas `active_path`.
- Backtest pequeno executa em range conhecido.
- Rebuild foi testado em ambiente temporario.
- Backup/restore documentado.
- Retencao do Postgres continua desativada por padrao.
