# Contrato De Arquivamento E Retencao Opcional

## Objetivo

Definir o contrato entre `data-backtest` e `data-colector` para registrar que dados historicos foram materializados e validados no lakehouse.

Este contrato serve para:

- auditoria;
- confianca operacional;
- rastreabilidade entre Postgres e Parquet;
- deteccao de stale;
- preparacao para uma possivel retencao futura.

Importante:

```text
Apagar dados do Postgres nao e objetivo padrao.
Retencao real e opcional, desativada por padrao e so deve ser considerada por decisao explicita do operador.
```

## Papeles Dos Sistemas

### `data-colector`

Fonte oficial operacional.

Responsabilidades:

- coletar eventos/ticks/books;
- manter Postgres como system of record;
- expor API de archive status;
- registrar auditoria;
- manter retencao desativada por padrao;
- bloquear qualquer exclusao que nao cumpra requisitos fortes.

### `data-backtest`

Lakehouse derivado.

Responsabilidades:

- ler Postgres do `data-colector` em modo read-only;
- materializar Parquet;
- validar particoes;
- manter `lake_manifest`;
- publicar archive status quando uma particao estiver validada;
- marcar stale quando detectar drift/reparo.

## Principio Principal

`event_archive_status` nao significa "apague este dado".

Significa apenas:

```text
O lakehouse possui uma copia materializada e validada deste evento/dataset nesta geracao.
```

Qualquer decisao de apagar dados do Postgres e uma decisao separada, opcional e administrativa.

## Fluxo Normal De Arquivamento

```text
1. data-backtest le eventos selados no Postgres.
2. data-backtest escreve Parquet em /lake/.tmp.
3. data-backtest valida contagens, fingerprints e legibilidade.
4. data-backtest publica active_path no lake_manifest.
5. data-backtest chama API do data-colector com status valid.
6. data-colector grava event_archive_status.
7. data-colector registra auditoria.
```

## Quando Publicar Archive Status

Publicar apenas quando:

- dataset foi escrito com sucesso;
- Parquet final existe;
- manifest foi atualizado;
- status local e `valid`;
- `source_fingerprint` foi calculado;
- rows/eventos foram validados.

Nao publicar quando:

- `dry-run`;
- particao `invalid`;
- particao `needs_review`;
- particao `stale`;
- API key ausente;
- ambiente temporario isolado onde nao queremos alterar o coletor.

## Campos Do Archive Status

Tabela no `data-colector`:

```text
event_archive_status
```

Campos conceituais:

```text
condition_id
market_id
event_start
event_end
dataset
status
underlying
interval
book_depth nullable
resolution nullable
dt
rows
events_count
active_path
run_id
source_fingerprint
lake_manifest_id nullable
error nullable
stale_reason nullable
archived_at
verified_at
created_at
updated_at
```

Na implementacao atual, os campos podem estar normalizados ou compactados de outra forma, mas o contrato semantico deve preservar essas informacoes.

## Status

### `valid`

O dataset/evento foi materializado e validado no lakehouse.

### `stale`

O dataset/evento ja foi validado antes, mas a origem mudou ou pode ter mudado.

Backtests devem tratar como nao confiavel ate rebuild.

### `invalid`

Tentativa de materializacao falhou ou validacao nao passou.

### `needs_review`

Ha divergencia que exige analise humana ou reparo da origem.

### `pending`

Status reservado para fluxo futuro de jobs assíncronos.

## Stale

Um evento/particao deve virar `stale` quando:

- houve reparo de ticks;
- houve correcao de `price_to_beat`;
- houve backfill de books;
- houve mudanca de event metadata;
- reconciliacao detectou fingerprint diferente;
- operador marcou manualmente para reprocessar.

Fluxo:

```text
data-colector repair/backfill
        |
        v
marca archive status como stale
        |
        v
        |
        v
rebuild confirmado
        |
        v
publica valid novamente
```

## API Key E Escopo

O `data-backtest` deve usar API key dedicada com escopo estreito.

Escopo atual:

```text
archive
```

Esse escopo deve permitir apenas:

- publicar archive status;
- marcar stale;
- consultar status se necessario.

Nao deve permitir escrita ampla no coletor.

## Retencao Opcional Do Postgres

Retencao real e uma capacidade futura/opcional.

Defaults obrigatorios:

```text
retention_enabled = false
postgres_retention_days = null
dry_run = true
```

Interpretacao:

```text
retention_enabled=false -> nunca apagar dados
postgres_retention_days=null -> janela indefinida
dry_run=true -> simular sem apagar
```

## Requisitos Para Qualquer Exclusao Futura

Se algum dia for decidido apagar dados do Postgres, todos os requisitos abaixo devem ser verdadeiros:

- retencao habilitada explicitamente;
- `postgres_retention_days` definido;
- dry-run executado e aprovado;
- evento possui `event_quality`;
- evento possui archive status `valid` para datasets exigidos;
- particao no `data-backtest` nao esta `stale`, `invalid` ou `needs_review`;
- backup/snapshot recente existe;
- operador confirmou com frase forte;
- execucao gera audit log.

Confirmacao sugerida:

```text
DELETE_ARCHIVED_TICKS
```

Para `DROP PARTITION`, exigir confirmacao ainda mais forte e snapshot confirmado.

## O Que Bloqueia Retencao

Mesmo se a retencao opcional for habilitada, deve bloquear quando:

- archive status ausente;
- archive status `stale`;
- archive status `invalid`;
- archive status `needs_review`;
- `event_quality` ausente;
- dataset exigido nao foi arquivado;
- backup obrigatorio nao confirmado;
- periodo esta dentro da janela quente;
- configuracao continua em dry-run;
- confirmacao forte incorreta.

## Relacao Entre Manifest E Archive Status

O `lake_manifest` e a fonte operacional do `data-backtest`.

O `event_archive_status` e a copia de controle/auditoria no `data-colector`.

Regras:

- backtest usa `lake_manifest`;
- data-colector usa `event_archive_status` para saber cobertura do lakehouse;
- se manifest vira `stale`, o archive status tambem deve virar `stale` quando possivel;
- se archive API estiver desconfigurada, o lake local pode continuar funcionando, mas o coletor nao recebe prova de arquivamento.

## Drift E Reconciliacao

Drift ocorre quando o Postgres muda depois que o Parquet foi gerado.

Mitigacoes:

- `source_fingerprint` no manifest;
- checksum de campos mutaveis;
- endpoint stale;
- job de reconciliacao;
- rebuild por particao.

Fluxo recomendado:

```text
1. recalcular fingerprint da origem
2. comparar com manifest
3. se diferente, marcar manifest stale
4. chamar API stale do data-colector
5. bloquear backtests strict ate rebuild
```

## Ambientes Temporarios

Em validacoes isoladas, pode-se desabilitar publish:

```env
DATA_COLLECTOR_API_URL=
DATA_COLLECTOR_ARCHIVE_API_KEY=
```

Nesse caso, resultados esperados:

```text
archivePublish.skipped = true
reason = archive_api_not_configured
```

Isso evita registrar paths temporarios no `data-colector`.

## Auditoria

Registrar auditoria para:

- archive status `valid`;
- archive status `stale`;
- mudanca de configuracao de retencao;
- dry-run de retencao;
- tentativa de execucao real;
- execucao real bloqueada;
- execucao real bem-sucedida;
- erro durante execucao.

## Runbook: Publicacao De Archive Falhou

```text
1. Verificar se Parquet local esta valid.
2. Verificar DATA_COLLECTOR_API_URL.
3. Verificar DATA_COLLECTOR_ARCHIVE_API_KEY.
4. Verificar escopo archive da API key.
5. Reexecutar publish/rebuild se necessario.
6. Nao habilitar retencao enquanto archive status estiver ausente.
```

## Runbook: Evento Marcado Stale

```text
1. Verificar motivo do stale.
2. Confirmar se houve reparo no data-colector.
3. Rodar prepare/rebuild dry-run no data-backtest.
4. Rodar rebuild real confirmado.
5. Validar manifest status valid.
6. Confirmar archive status valid no data-colector.
```

## Runbook: Avaliar Retencao Futura

```text
1. Confirmar que ha necessidade real de liberar espaco.
2. Confirmar backups e restore testado.
3. Rodar dry-run por periodo pequeno.
4. Conferir eventos bloqueados.
5. Conferir amostra de eventos elegiveis.
6. Manter dry-run ate ganhar confianca.
7. Se for habilitar execucao real, usar janela pequena.
8. Monitorar auditoria e contagens.
```

## Decisao Atual

Estado recomendado do projeto agora:

```text
Postgres permanece completo.
Lakehouse e usado para backtests e analises.
Archive status registra cobertura validada.
Retencao real permanece desligada.
```

Essa decisao pode ser revista no futuro, mas nao deve bloquear o desenvolvimento da UI de backtest nem do Backtest Studio.
