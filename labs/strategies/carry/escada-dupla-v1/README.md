# Escada Dupla V1 — Studio + lab (lake BTC 5m)

`promotedToStudio: true` · slug `escada-dupla-v1` · library `escada-dupla-runner@1`.

Aparece no Estúdio / Estratégias após `npm run seed:ported-strategies` (ou reinício do server).

## Versões Studio

| v | Preset | Uso |
|---|---|---|
| 1 | `v1` | Defaults (`ascent_hedge`) |
| 2 | `btc-champion` *(default)* | Holdout jul/2026 · maxSub=8 · freio=98 |
| 3 | `btc-parity-sim` | Perfil HTML oscillate (referência) |

## Lab no lake

```powershell
npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/holdout-july.json --variant-workers 4
```

Relatórios: `reports/labs/escada-dupla-v1/`.

## Arquivos

| Path | Papel |
|---|---|
| `strategy.json` | Manifest portado |
| `strategy.js` | Envelope Studio |
| `defaults.json` / `presets/` | Baseline + versões |
| `labs/legacy/.../escada-dupla-runner.js` | Motor |
| `data/strategy-libraries/escada-dupla-runner.v1.json` | Bootstrap SQLite |

Doc: `docs/estrategias/implementadas/escada-dupla-v1.md`
