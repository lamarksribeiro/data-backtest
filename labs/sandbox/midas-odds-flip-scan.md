# MIDAS — scan de virada abrupta UP/DOWN

Gerado: 2026-07-26T03:40:21.584Z
Janela: 2026-07-01 → 2026-07-26

## Eventos no lake (todos)

| label | n |
|---|---:|
| stable | 5351 |
| high_odds_velocity | 805 |
| violent_odds_cross | 244 |
| settlement_surprise | 126 |
| soft_odds_cross | 64 |

## MIDAS baseline (aggressive dist40/tier2)

Trades: 2362 · PnL 2416.38 · WR 0.813 · Loss PnL -4316.7

| path | n | PnL | WR | losses | loss PnL |
|---|---:|---:|---:|---:|---:|
| violent_odds_cross | 205 | -1546.04 | 0.205 | 163 | -1747.8 |
| settlement_surprise | 70 | -155.3 | 0.314 | 48 | -549.18 |
| soft_odds_cross | 52 | -95.01 | 0.481 | 27 | -222.66 |
| high_odds_velocity | 636 | 529.9 | 0.764 | 150 | -1373.34 |
| stable | 1399 | 3682.83 | 0.961 | 54 | -423.72 |

Flip-related trades: 963 (PnL -1266.44)
Flip losses share of loss PnL: 0.902

## Top flip losses

| event | dt | pnl | label | oddsΔ | vel | late→spot |
|---|---|---:|---|---:|---:|---|
| 0x92481fc142 | 2026-07-19 | -36.60 | violent_odds_cross | 0.387 | 0.968 | DOWN→DOWN |
| 0xb4e5afded2 | 2026-07-14 | -35.83 | high_odds_velocity | 0.354 | 0.976 | DOWN→DOWN |
| 0x27b2e3e930 | 2026-07-03 | -35.07 | high_odds_velocity | 0.19 | 0.281 | UP→UP |
| 0xcc29320471 | 2026-07-07 | -32.26 | high_odds_velocity | 0.035 | 0.388 | UP→UP |
| 0x0c955207ae | 2026-07-06 | -30.73 | violent_odds_cross | 0.363 | 0.721 | UP→UP |
| 0x349340f5e7 | 2026-07-10 | -21.86 | high_odds_velocity | -0.038 | 0.261 | UP→UP |
| 0x5c3a2bffdd | 2026-07-23 | -21.66 | high_odds_velocity | -0.116 | 1.245 | UP→UP |
| 0x4c0ff6ca3b | 2026-07-19 | -19.78 | violent_odds_cross | 0.84 | 0.589 | UP→DOWN |
| 0xd6dd8d7142 | 2026-07-21 | -19.65 | violent_odds_cross | 0.511 | 0.579 | DOWN→UP |
| 0xd49d820541 | 2026-07-18 | -19.61 | settlement_surprise | -0.024 | 0.191 | DOWN→UP |
| 0xaef0995172 | 2026-07-12 | -19.56 | violent_odds_cross | 0.644 | 1.02 | UP→DOWN |
| 0x85d93a7318 | 2026-07-03 | -19.56 | violent_odds_cross | 0.577 | 0.852 | DOWN→UP |
| 0xfbe60a3f44 | 2026-07-06 | -19.56 | settlement_surprise | 0.446 | 1.155 | UP→DOWN |
| 0x4f0500e021 | 2026-07-05 | -19.54 | violent_odds_cross | 0.587 | 0.521 | UP→DOWN |
| 0x89c74522b2 | 2026-07-15 | -19.54 | settlement_surprise | 0.264 | 0.559 | DOWN→UP |

## Candidatos ao evento da imagem (25/07 PTB~64341)

- 0x629f7dba26 start=2026-07-25T18:05:00.000Z ptb=64303.63634497 label=stable late=DOWN final=DOWN oddsΔ=-0.044 vel=0.02
- 0x5cd661ba90 start=2026-07-25T18:20:00.000Z ptb=64310.88118908 label=stable late=DOWN final=DOWN oddsΔ=-0.213 vel=0.05
- 0xd152d309dc start=2026-07-25T18:25:00.000Z ptb=64305.05043326 label=stable late=UP final=UP oddsΔ=-0.008 vel=0
- 0xc4159b0d41 start=2026-07-25T18:30:00.000Z ptb=64356.81691649 label=stable late=UP final=UP oddsΔ=-0.143 vel=0.1
- 0x1d6270192e start=2026-07-25T18:35:00.000Z ptb=64367.86530176 label=stable late=DOWN final=DOWN oddsΔ=-0.013 vel=0.016
- 0xa401881938 start=2026-07-25T18:40:00.000Z ptb=64329.87944519 label=stable late=UP final=UP oddsΔ=-0.036 vel=0.13
- 0xe3fca562c9 start=2026-07-25T18:45:00.000Z ptb=64335.01482114 label=stable late=UP final=UP oddsΔ=-0.01 vel=0.02
- 0xa003e63a96 start=2026-07-25T18:50:00.000Z ptb=64355.30724499 label=stable late=DOWN final=DOWN oddsΔ=-0.016 vel=0.02
- 0xbb1e53d58b start=2026-07-25T18:55:00.000Z ptb=64331.68476026 label=stable late=UP final=UP oddsΔ=-0.019 vel=0.04
- 0x747f861ab1 start=2026-07-25T19:00:00.000Z ptb=64357.06207262 label=stable late=UP final=UP oddsΔ=-0.013 vel=0.04
- 0xfd826af482 start=2026-07-25T19:05:00.000Z ptb=64377.258502 label=stable late=DOWN final=DOWN oddsΔ=-0.041 vel=0.02
- 0xf78ad84fe4 start=2026-07-25T19:10:00.000Z ptb=64363.619 label=stable late=UP final=UP oddsΔ=-0.052 vel=0.06
- 0x7ae1b6314a start=2026-07-25T19:15:00.000Z ptb=64374.29192446 label=stable late=DOWN final=DOWN oddsΔ=-0.005 vel=0.009
- 0x81d2f1129d start=2026-07-25T19:20:00.000Z ptb=64350.27315189 label=stable late=UP final=UP oddsΔ=-0.026 vel=0.02
- 0x576e4bc7d8 start=2026-07-25T19:25:00.000Z ptb=64358.06514087 label=high_odds_velocity late=DOWN final=DOWN oddsΔ=-0.326 vel=0.28
- 0xf85bceb94d start=2026-07-25T19:30:00.000Z ptb=64350.63381594 label=high_odds_velocity late=UP final=UP oddsΔ=0.178 vel=0.471
- 0x171d5596d6 start=2026-07-25T19:35:00.000Z ptb=64352.25177403 label=stable late=DOWN final=DOWN oddsΔ=-0.027 vel=0.06
- 0x70b9983a22 start=2026-07-25T19:40:00.000Z ptb=64337.97228611 label=violent_odds_cross late=UP final=DOWN oddsΔ=0.441 vel=0.768
- 0xa851a3e0ad start=2026-07-25T19:45:00.000Z ptb=64333.34689923 label=stable late=UP final=UP oddsΔ=-0.107 vel=0.15
- 0x32ffe1d78f start=2026-07-25T19:50:00.000Z ptb=64339.43113371 label=stable late=UP final=UP oddsΔ=-0.03 vel=0.02
- 0x3e28e6595e start=2026-07-25T19:55:00.000Z ptb=64361.65730192 label=stable late=DOWN final=DOWN oddsΔ=-0.016 vel=0.02
- 0x94a7e3fb48 start=2026-07-25T20:00:00.000Z ptb=64330.10658884 label=stable late=DOWN final=DOWN oddsΔ=-0.02 vel=0.02
- 0xa601161c4d start=2026-07-25T20:05:00.000Z ptb=64301.95730535 label=stable late=DOWN final=DOWN oddsΔ=-0.015 vel=0.02
- 0x2d30997c1a start=2026-07-25T20:15:00.000Z ptb=64314.1098526 label=stable late=UP final=UP oddsΔ=-0.18 vel=0.24
- 0x60848b9ce4 start=2026-07-25T20:20:00.000Z ptb=64315.73912323 label=high_odds_velocity late=DOWN final=DOWN oddsΔ=-0.311 vel=0.3
- 0xa4c9042327 start=2026-07-25T20:25:00.000Z ptb=64303.305 label=stable late=UP final=UP oddsΔ=-0.077 vel=0.03
- 0x8da2e3bfe8 start=2026-07-25T20:30:00.000Z ptb=64308.35506237 label=stable late=DOWN final=DOWN oddsΔ=-0.016 vel=0.02
- 0xa320ae60d0 start=2026-07-25T22:40:00.000Z ptb=64340.77791141 label=stable late=UP final=UP oddsΔ=-0.237 vel=0.12
- 0x5135dd54e1 start=2026-07-25T22:45:00.000Z ptb=64345.15780247 label=stable late=UP final=UP oddsΔ=-0.285 vel=0.11
- 0x92f4d0c6be start=2026-07-25T22:50:00.000Z ptb=64351.21369013 label=stable late=DOWN final=DOWN oddsΔ=-0.182 vel=0.04
- 0x5812b1d901 start=2026-07-25T22:55:00.000Z ptb=64345.33651298 label=stable late=UP final=UP oddsΔ=-0.361 vel=0.13
- 0xecb04392bf start=2026-07-25T23:00:00.000Z ptb=64351.95552556 label=high_odds_velocity late=DOWN final=DOWN oddsΔ=-0.257 vel=0.42
- 0x4eafcb0673 start=2026-07-25T23:05:00.000Z ptb=64346.01589737 label=soft_odds_cross late=DOWN final=UP oddsΔ=0.562 vel=0.23
- 0x866d56db4e start=2026-07-25T23:10:00.000Z ptb=64351.32671597 label=high_odds_velocity late=DOWN final=DOWN oddsΔ=-0.384 vel=0.739
- 0x825ec94cb5 start=2026-07-25T23:15:00.000Z ptb=64347.223 label=stable late=DOWN final=DOWN oddsΔ=-0.093 vel=0.18
- 0xff816def4c start=2026-07-25T23:20:00.000Z ptb=64341.04304148 label=high_odds_velocity late=UP final=UP oddsΔ=-0.285 vel=0.39
- 0x07f6314cd4 start=2026-07-25T23:25:00.000Z ptb=64347.75921436 label=stable late=UP final=DOWN oddsΔ=0.429 vel=0.11
- 0x136da5537a start=2026-07-25T23:30:00.000Z ptb=64343.25 label=high_odds_velocity late=DOWN final=DOWN oddsΔ=-0.09 vel=0.27
- 0x21d4d30b0e start=2026-07-25T23:35:00.000Z ptb=64342.85475965 label=high_odds_velocity late=UP final=DOWN oddsΔ=0.095 vel=0.704
- 0x6455c0699a start=2026-07-25T23:40:00.000Z ptb=64335.12598238 label=stable late=DOWN final=DOWN oddsΔ=-0.31 vel=0.1
- 0xc1f0f56e65 start=2026-07-25T23:45:00.000Z ptb=64328.67396272 label=violent_odds_cross late=UP final=DOWN oddsΔ=0.445 vel=0.311
- 0x39ede9bf83 start=2026-07-25T23:50:00.000Z ptb=64326.68597861 label=stable late=DOWN final=DOWN oddsΔ=-0.215 vel=0.12
- 0xdea84ab5fe start=2026-07-25T23:55:00.000Z ptb=64305.36309321 label=high_odds_velocity late=UP final=UP oddsΔ=-0.096 vel=0.55
