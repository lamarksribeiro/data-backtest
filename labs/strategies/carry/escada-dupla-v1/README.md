# Escada Dupla V1 — Studio + lab (lake BTC 5m)

`promotedToStudio: true` · slug `escada-dupla-v1` · library `escada-dupla-runner@1`.

Aparece no Estúdio / Estratégias após `npm run seed:ported-strategies` (ou reinício do server).

## Versões Studio

| v | Preset | Uso |
|---|---|---|
| 1 | `v1` | Defaults (`ascent_hedge`) |
| 2 | `btc-champion` *(default)* | Holdout jul/2026 · maxSub=8 · freio=98 · `optimistic_maker` |
| 3 | `btc-parity-sim` | Perfil HTML oscillate (referência) |
| 4 | `btc-resting-honest` | Mesmo grid do champion · `resting_maker` (fill só com atravessamento) |

## Lab no lake

```powershell
# Holdout julho
npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/holdout-july.json --variant-workers 4

# A/B optimistic vs resting (honestidade de fill)
npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/resting-holdout-july.json --variant-workers 4

# Budget mínimo (sizeScale)
npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/budget-min-july.json --variant-workers 4
```

Relatórios: `reports/labs/escada-dupla-v1/`.

`sizeScale` escala shares + `maxEventNotional`/`walletSize`/`maxSharesPerSide`. Campeão = `1.0` (~$80/evento).

### Microestrutura (jul/2026)

| Camada | Status no campeão atual (v2) | Lab 9 realista (v5) |
|---|---|---|
| Fees crypto | on | on |
| `spreadCents` | 1 | 1 |
| `slippageCents` | 0 | **1** |
| `executionMode` | `optimistic_maker` | **`touch_maker`** |
| Taker | fórmula | **capped (+1¢)** |
| Maker hedge | fill imediato | **só se ask ≤ limit (through-fill)** |

Lab 9 (`lab09-realistic-edge-july`): `touch-capped1-slip1` → PnL **+$29.3k**, PF **1.63**, 22/22 dias.  
`resting` + walk profundo continua inviável; o buraco era sobretudo o **walk adverso no taker**.

## Arquivos

| Path | Papel |
|---|---|
| `strategy.json` | Manifest portado |
| `strategy.js` | Envelope Studio |
| `defaults.json` / `presets/` | Baseline + versões |
| `labs/legacy/.../escada-dupla-runner.js` | Motor |
| `data/strategy-libraries/escada-dupla-runner.v1.json` | Bootstrap SQLite |

Doc: `docs/estrategias/implementadas/escada-dupla-v1.md`
