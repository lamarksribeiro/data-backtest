# Atualizar BTC 5m local (atalho)

Comando único para puxar do Brutus o que falta no lake local. Prefira isto em vez de `lake:pull` + `query:availability` + descoberta manual de container.

## Agente / uso rápido

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
npm run lake:update-btc-5m
```

Isso:

1. Lê o `max(dt)` local (BTC · 5m · `BACKTEST_BOOK_DEPTH`)
2. Puxa `max_local - 1 dia` → hoje UTC do Brutus
3. Faz UPSERT no manifest e `ops:check`

Não rode dry-run nem availability antes, salvo se o pull falhar.

## Saída esperada

JSON curto no final:

- `after.maxDt` — tip local (ex.: `2026-07-21`)
- `filesCopied` — arquivos transferidos
- `note` — se o dia corrente faltar, é **normal** (sync ~06:00 UTC)

## Se falhar

| Sintoma | Ação |
|---------|------|
| `No such container` | `npm run lake:update-btc-5m -- --refresh-container` |
| SSH / timeout | Conferir `ssh.exe Brutus` ([conexao-brutus.md](conexao-brutus.md)) |
| Precisa de janela explícita | `npm run lake:update-btc-5m -- --from 2026-07-01 --to 2026-07-10` |

## Flags opcionais

```powershell
npm run lake:update-btc-5m -- --dry-run
npm run lake:update-btc-5m -- --lookback-days 3
npm run lake:update-btc-5m -- --refresh-container
npm run lake:update-btc-5m -- --skip-check
```

Para pull genérico (outros assets/datasets/intervalo): [lake-pull-brutus.md](lake-pull-brutus.md).
