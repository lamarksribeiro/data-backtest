# MIDAS — viabilidade da entrada MAKER (BTC)

Janela 2026-05-04..2026-07-26 · settlement 0.995 · fill maker isento de fee.
Regra de fill (a do simulador, pessimista): o ask precisa CAIR até preço_postado − 0.01.
A ordem vive de t0 até tau = 4s. Seleção adversa integral: só preenche quando o mercado veio contra.

## Modo: postar no melhor BID

| Banda (por ask0) | candidatos | fill maker | fill % | preço maker | WR maker % | edge maker pp | IC95 pp | EV/$ maker | EV/$ taker (mesma pop.) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| [0.30,0.55) | 1619 | 1418 | 87.6 | 0.415 | 40.8 | -0.83 | [-3.36, 1.75] | -0.0199 | -0.0854 |
| [0.55,0.70) | 1653 | 1201 | 72.7 | 0.613 | 55.5 | -6.10 | [-8.92, -3.31] | -0.0989 | -0.1408 |
| [0.70,0.82) | 1976 | 1329 | 67.3 | 0.750 | 70.6 | -4.78 | [-7.28, -2.39] | -0.0634 | -0.0932 |
| [0.82,0.94] | 4956 | 2852 | 57.5 | 0.883 | 84.5 | -4.29 | [-5.67, -3.01] | -0.0483 | -0.0671 |

Baseline taker sobre todos os candidatos (o que a MIDAS faz hoje):

| Banda | n | preço | edge pp | EV/$ orçado |
|---|--:|--:|--:|--:|
| [0.30,0.55) | 1619 | 0.429 | +2.73 | +0.0634 |
| [0.55,0.70) | 1653 | 0.625 | +2.66 | +0.0423 |
| [0.70,0.82) | 1976 | 0.761 | +2.29 | +0.0300 |
| [0.82,0.94] | 4956 | 0.896 | +0.25 | +0.0028 |

## Modo: postar em ASK − 0.01

| Banda (por ask0) | candidatos | fill maker | fill % | preço maker | WR maker % | edge maker pp | IC95 pp | EV/$ maker | EV/$ taker (mesma pop.) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| [0.30,0.55) | 1619 | 1417 | 87.5 | 0.416 | 40.7 | -1.04 | [-3.57, 1.54] | -0.0250 | -0.0881 |
| [0.55,0.70) | 1653 | 1199 | 72.5 | 0.614 | 55.4 | -6.32 | [-9.15, -3.53] | -0.1025 | -0.1432 |
| [0.70,0.82) | 1976 | 1332 | 67.4 | 0.750 | 70.6 | -4.78 | [-7.28, -2.40] | -0.0634 | -0.0925 |
| [0.82,0.94] | 4956 | 2783 | 56.2 | 0.883 | 84.1 | -4.63 | [-6.04, -3.32] | -0.0522 | -0.0703 |

Baseline taker sobre todos os candidatos (o que a MIDAS faz hoje):

| Banda | n | preço | edge pp | EV/$ orçado |
|---|--:|--:|--:|--:|
| [0.30,0.55) | 1619 | 0.429 | +2.73 | +0.0634 |
| [0.55,0.70) | 1653 | 0.625 | +2.66 | +0.0423 |
| [0.70,0.82) | 1976 | 0.761 | +2.29 | +0.0300 |
| [0.82,0.94] | 4956 | 0.896 | +0.25 | +0.0028 |