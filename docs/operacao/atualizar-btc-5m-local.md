# Atualizar BTC 5m local (atalho)

Comando único para puxar do Brutus o que falta no lake local. Prefira isto em vez de `lake:pull` + `query:availability` + descoberta manual de container.

## Agente / uso rápido

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
npm run lake:update-btc-5m
```

Isso:

1. Lê o `max(dt)` local (BTC · 5m · `BACKTEST_BOOK_DEPTH`)
2. Consulta o Brutus de `max_local` → hoje UTC (túnel Cloudflare `Host Brutus`)
3. **Pula** Parquets que já existem localmente; só baixa o que falta
4. Se o container em cache morreu (redeploy Coolify), **redescobre sozinho**
5. UPSERT no manifest + `ops:check`

Não rode dry-run nem availability antes, salvo se o pull falhar.

## Cloudflare / sem VPN

O alias SSH `Brutus` (`ssh-brutus.fracta.online` + `cloudflared access ssh`) já é o caminho sem Forti. Se o log mostra `No such container` ou `docker exec`, o túnel está **ok** — o problema era cache de container, não Access/VPN.

## Saída esperada

JSON curto no final:

- `filesCopied` / `filesSkipped` — o que baixou vs o que já tinha
- `after.maxDt` — tip local
- `note` — se o dia corrente faltar, é **normal** (sync ~06:00 UTC)

Re-rodar sem dados novos deve dar `filesCopied: 0`.

## Se falhar

| Sintoma | Ação |
|---------|------|
| Ainda cai no scp ~280MB | Atualize o código; ou `npm run lake:update-btc-5m -- --refresh-container` |
| SSH / timeout Access | `ssh.exe Brutus hostname` ([conexao-brutus.md](conexao-brutus.md)) |
| Janela explícita | `npm run lake:update-btc-5m -- --from 2026-07-01 --to 2026-07-10` |

## Flags opcionais

```powershell
npm run lake:update-btc-5m -- --dry-run
npm run lake:update-btc-5m -- --lookback-days 3
npm run lake:update-btc-5m -- --refresh-container
npm run lake:update-btc-5m -- --skip-check
```

Para pull genérico (outros assets/datasets/intervalo): [lake-pull-brutus.md](lake-pull-brutus.md).
