# Presets Edge Sniper V2

Variantes vencedoras do lab (jun/2026, simulador corrigido) como presets nomeados.

Cada preset vira:

1. **Arquivo JSON** aqui — params + metadata do lab
2. **Estratégia no Backtest Studio** — slug `esv2-<id>` com defaults GLS patchados
3. **Comando lab** — `npm run lab:run-preset -- --preset <id>`

## Presets

| ID | Studio slug | Papel | PnL 38d | Dias + |
|---|---|---|---:|---|
| `near-default-loose` | `esv2-near-default-loose` | campeã | +3.170 | 27/38 |
| `quality-v0017` | `esv2-quality-v0017` | discovery PnL | +6.679 | 18/38 |
| `s180-d25-medium` | `esv2-s180-d25-medium` | sampled | +6.650 | 18/38 |
| `q180-d40` | `esv2-q180-d40` | estabilidade | +3.610 | 28/38 |
| `q180-d25` | `esv2-q180-d25` | equilíbrio | +4.184 | 21/38 |

## Uso local

```powershell
# Listar presets
npm run lab:run-preset -- --list

# Backtest 38 dias (single-pass)
npm run lab:run-preset -- --preset near-default-loose

# Com métricas diárias (validação)
npm run lab:run-preset -- --preset q180-d40 --daily-metrics

# Registrar/atualizar versões no SQLite (Studio)
npm run lab:seed-presets
```

No **Estúdio**, escolha a estratégia `esv2-*` — os parâmetros já abrem com os defaults do preset.

## Servidor

Após deploy, reinicie o app (ou rode `npm run lab:seed-presets` dentro do container) para criar as estratégias `esv2-*` no SQLite de produção.
