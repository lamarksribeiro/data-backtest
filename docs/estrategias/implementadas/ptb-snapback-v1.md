# PTB Snapback V1

Estrategia de **mean-reversion ao Price to Beat (PTB)** para BTC Up/Down 5m.

## Hipotese

Quando o spot faz uma **excursao** longe do PTB e depois **volta** (snapback), o azarao Polymarket fica subprecificado. Compramos o lado contrario **barato** e seguramos ate o settlement.

## Diagnostico v1 (por que falhou)

| Problema | Efeito |
|---|---|
| Entrada com `awayVel >= minAwayVel` | Apostava **durante** o afastamento (knife catching) |
| Scalp taker-taker | Taxa de saida ~7% destruia o edge (fee drag 40%+) |
| Muitas entradas | 300+ trades/semana com WR ~37% e avg loss > avg win |

## Solucao v3

1. **Excursao**: pico `peakDist >= minPeakDist`
2. **Pullback**: distancia caiu `>= minPullbackUsd` do pico
3. **Snapback confirmado**: `awayVel <= 0` + convergencia spot em direcao ao PTB
4. **GDI**: azarao com desconto vs probabilidade browniana (`minGdi`)
5. **Hold to settlement**: sem saida taker (modelo BGET)

## Campeao: ultra-select

| Janela | PnL | PF | WR | Entradas |
|---|---:|---:|---:|---:|
| Full (mai-jul/2026) | **+969.63** | **1.47** | 36.9% | 225 |
| Holdout (jun-jul/2026) | -70.06 | 0.92 | 28.8% | 80 |

Params em `defaults.json`:

- `minPeakDist=55`, `minPullbackUsd=30`, `maxEntryDist=18`
- `minGdi=0.16`, `maxAsk=0.38`, `minConvTowardPtb=5`
- `holdToSettlement=1`

## Laboratorio

```powershell
npm run lab:run -- --experiment labs/strategies/mean-reversion/ptb-snapback-v1/experiments/smoke.json --variant-workers 4
npm run lab:run -- --experiment labs/strategies/mean-reversion/ptb-snapback-v1/experiments/holdout.json --variant-workers 4
npm run lab:run -- --experiment labs/strategies/mean-reversion/ptb-snapback-v1/experiments/full-period.json --variant-workers 4
```

## Status

- **draft** — lucrativo no periodo completo; holdout quase break-even. Validar mais janelas antes do Studio.
