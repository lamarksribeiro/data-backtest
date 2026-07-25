# Escada Dupla — lab sintético

Gerado: 2026-07-25T02:41:26.928Z
Variantes: 72

## Campeão (soma ponderada PnL líquido nos cenários HTML)

```json
{
  "sideMultiplier": 2,
  "spreadCents": 0,
  "slippageCents": 0,
  "equalizeEnabled": false,
  "liquidityMode": "auto"
}
```

| métrica | valor |
|---|---:|
| pnlNet (Σ) | 353.17 |
| pnlGross (Σ) | 447.04 |
| fees (Σ) | 93.8704 |
| pior cenário | -66.66 |
| whip avg | 14.62 |

## Top 15

| # | mult | spread | slip | eq | liq | pnlNet | worst | whipAvg |
|---:|---:|---:|---:|:---:|:---:|---:|---:|---:|
| 1 | 2 | 0 | 0 | false | auto | 353.17 | -66.66 | 14.62 |
| 2 | 2 | 1 | 0 | false | auto | 317.7 | -70.22 | 11.87 |
| 3 | 2 | 0 | 1 | false | auto | 282.74 | -73.72 | 9.17 |
| 4 | 2 | 2 | 0 | false | auto | 282.74 | -73.72 | 9.17 |
| 5 | 2 | 0 | 0 | false | taker | 273.1 | -72.27 | 10.22 |
| 6 | 2 | 1 | 1 | false | auto | 247.17 | -77.16 | 6.41 |
| 7 | 2 | 0 | 0 | true | auto | 215.59 | -68.16 | 6.6 |
| 8 | 2 | 2 | 1 | false | auto | 211.9 | -80.54 | 3.67 |
| 9 | 3 | 0 | 0 | false | auto | 210.56 | -252.53 | -27.14 |
| 10 | 2 | 1 | 0 | false | taker | 207.25 | -79.13 | 5.66 |
| 11 | 2 | 1 | 0 | true | auto | 175.52 | -71.54 | 3.92 |
| 12 | 3 | 1 | 0 | false | auto | 169.28 | -254.74 | -30.47 |
| 13 | 2 | 0 | 1 | false | taker | 140.18 | -85.87 | 0.98 |
| 14 | 2 | 2 | 0 | false | taker | 140.18 | -85.87 | 0.98 |
| 15 | 2 | 0 | 1 | true | auto | 135.84 | -74.86 | 1.27 |

## Detalhe do campeão (por cenário)

| cenário | vence | shUP | shDN | inv | pnlGross | fees | pnlNet | leader | makerFills |
|---|:---:|---:|---:|---:|---:|---:|---:|:---:|---:|
| 95-direto | UP | 160 | 80 | 134.5 | 25.5 | 2.1963 | 23.3 | UP | 8 |
| rev-55 | DOWN | 110 | 200 | 172 | 28 | 1.5628 | 26.44 | UP | 9 |
| whip-55 | UP | 290 | 150 | 242.5 | 47.5 | 4.4485 | 43.05 | UP | 10 |
| rev-60 | DOWN | 130 | 230 | 200 | 30 | 1.8987 | 28.1 | UP | 10 |
| whip-60 | UP | 380 | 200 | 322.5 | 57.5 | 5.9605 | 51.54 | UP | 12 |
| rev-65 | DOWN | 150 | 260 | 229.5 | 30.5 | 2.2172 | 28.28 | UP | 11 |
| whip-65 | UP | 470 | 250 | 407.5 | 62.5 | 7.3937 | 55.11 | UP | 14 |
| rev-70 | DOWN | 170 | 290 | 260.5 | 29.5 | 2.5112 | 26.99 | UP | 12 |
| whip-70 | UP | 560 | 300 | 497.5 | 62.5 | 8.7167 | 53.78 | UP | 16 |
| rev-75 | DOWN | 190 | 320 | 293 | 27 | 2.7738 | 24.23 | UP | 13 |
| whip-75 | UP | 542 | 310 | 500 | 42 | 8.6713 | 33.33 | UP | 14 |
| rev-80 | DOWN | 210 | 350 | 327 | 23 | 2.9977 | 20 | UP | 14 |
| whip-80 | UP | 503.57 | 350 | 500 | 3.57 | 8.036 | -4.46 | UP | 15 |
| rev-85 | DOWN | 230 | 380 | 362.5 | 17.5 | 3.1763 | 14.32 | UP | 15 |
| whip-85 | UP | 458.46 | 390 | 500 | -41.54 | 7.1487 | -48.69 | UP | 16 |
| rev-90 | DOWN | 240 | 400 | 381.5 | 18.5 | 3.2393 | 15.26 | UP | 16 |
| whip-90 | UP | 440 | 410 | 500 | -60 | 6.6623 | -66.66 | UP | 17 |

## Próximo passo

1. Copiar grid campeão para `presets/` e `defaults.json` (se melhor que baseline).
2. Rodar `npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/parity-smoke.json` no lake.
3. Só então promover ao Studio.

