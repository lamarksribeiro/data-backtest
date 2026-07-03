# Baixar Parquet do Brutus para o lake local (`lake:pull`)

Guia operacional para sincronizar dados do lakehouse de produção (Brutus) para a máquina de desenvolvimento, sem travar em container antigo ou copiar o lake inteiro sem querer.

Pré-requisitos: VPN Hulw ativa, alias SSH `Brutus` configurado — ver [conexao-brutus.md](conexao-brutus.md).

---

## Comando padrão (BTC 5m)

No diretório `data-backtest`, use o modo **seletivo** (copia só os `active_path` do manifest remoto no intervalo):

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest

# 1) Dry-run — sempre rode antes para ver quantas partições seriam copiadas
npm run lake:pull -- --from 2026-07-01 --to 2026-07-05 --underlying BTC --interval 5m --book-depth 25 --remote-container <ID> --dry-run

# 2) Pull real (remova --dry-run)
npm run lake:pull -- --from 2026-07-01 --to 2026-07-05 --underlying BTC --interval 5m --book-depth 25 --remote-container <ID>
```

| Parâmetro | Valor usual BTC 5m |
|-----------|-------------------|
| `--underlying` | `BTC` |
| `--interval` | `5m` |
| `--book-depth` | `25` (igual a `BACKTEST_BOOK_DEPTH` no servidor) |
| `--dataset` | omitir (padrão: `backtest_ticks`) |

O script faz **UPSERT** no manifest local: copia só arquivos referenciados como `valid` ou `accepted` no Brutus.

---

## Passo obrigatório: descobrir o container atual

Após cada **redeploy** do `data-backtest` no Coolify, o ID do container muda. O script cacheia o ID em:

```text
state/.lake-pull-remote-container.json
```

Se esse cache apontar para um container morto, o pull trava ou cai em fallback lento (`sqlite3` no host, ~280 MB).

### Descobrir o ID (PowerShell)

```powershell
ssh.exe Brutus docker ps
```

Procure o container com **porta 3100** e bind mount `/data/goldenlens/lakehouse` → `/lake`. Em jul/2026 o padrão é algo como `2b8dbe51535a` (12 primeiros caracteres bastam).

Confirme:

```powershell
ssh.exe Brutus docker inspect 2b8dbe51535a
```

Deve mostrar `LAKE_ROOT=/lake`, `STATE_DB_PATH=/state/data-backtest.db` e mounts em `/data/goldenlens/`.

### Passar o ID explicitamente

```powershell
npm run lake:pull -- --from ... --to ... --underlying BTC --interval 5m --book-depth 25 --remote-container 2b8dbe51535a
```

Ou fixe no `.env` (não versionar secrets; o ID pode ir no `.env` local):

```env
LAKE_PULL_REMOTE_CONTAINER=2b8dbe51535a
```

### Se o pull travar ou falhar com "No such container"

1. Apague o cache: `state/.lake-pull-remote-container.json`
2. Descubra o container novo com `ssh.exe Brutus docker ps`
3. Repita com `--remote-container <ID novo>`

---

## Verificar antes e depois

**Antes** — ver o que falta localmente (ajuste `--from` / `--to`):

```powershell
npm run query:availability -- --from 2026-07-01 --to 2026-07-05 --underlying BTC --interval 5m --dataset backtest_ticks --book-depth 25
```

**Depois** — health + existência dos `active_path`:

```powershell
npm run lake:verify
# ou
npm run ops:check
```

Saída esperada do pull: `"ok": true`, `filesCopied` > 0, `missing_active_paths: []` no check.

---

## O que NÃO fazer

| Erro | Por quê |
|------|---------|
| `npm run lake:pull` sem argumentos no modo seletivo | Exige `--from` e `--to` |
| `npm run lake:pull -- --full` sem necessidade | Copia o lake inteiro (~GB) e substitui o SQLite local |
| Confiar só no cache de container após redeploy | ID antigo → `No such container` ou hang no sqlite3 |
| `ssh Brutus "docker ps --format '{{.Names}}'"` no PowerShell Windows | OpenSSH do Windows falha com templates Go; use `ssh.exe Brutus docker ps` |
| Glob direto em `./lake` para backtest | Sempre usar manifest (`active_path`); ver regra em [operacao-lakehouse.md](operacao-lakehouse.md) |

---

## Variáveis de ambiente (`.env`)

```env
LAKE_PULL_REMOTE_HOST=Brutus
LAKE_PULL_REMOTE_LAKE=/data/goldenlens/lakehouse
LAKE_PULL_REMOTE_STATE=/data/goldenlens/backtest-state/data-backtest.db
LAKE_PULL_REMOTE_CONTAINER=          # opcional; prefira preencher após redeploy
LAKE_PULL_REMOTE_STATE_CONTAINER=/state/data-backtest.db
```

---

## Cadência dos dados no servidor

O sync diário de Parquet no Brutus roda por volta das **06:00 UTC**. O dia corrente (`dt` de hoje) normalmente só aparece no manifest no dia seguinte. Se o pull não trouxer `dt=hoje`, isso é esperado — não é falha do comando.

---

## Outros datasets

Para copiar mais que `backtest_ticks`:

```powershell
npm run lake:pull -- --from 2026-06-01 --to 2026-06-07 --underlying BTC --interval 5m --dataset backtest_ticks,scalars,ohlc --book-depth 25 --remote-container <ID>
```

Ordem de preparação no servidor: scalars → books → backtest_ticks → ohlc (ver [operacao-lakehouse.md](operacao-lakehouse.md)).

---

## Ver também

- [conexao-brutus.md](conexao-brutus.md) — VPN, chave SSH, MCP Coolify
- [operacao-lakehouse.md](operacao-lakehouse.md) — sync, manifest, backfill local
- [dicionario-dados-lakehouse.md](../analise-quantitativa/dicionario-dados-lakehouse.md) — layout dos Parquets BTC 5m
- `scripts/pull-lake-from-brutus.js --help` — flags completas
