# MIDAS — gate de z na banda cara + complete-set lock (BTC)

Janela 2026-05-04..2026-07-26 · settlement 0.995 · fee taker 0.07·p·(1−p)
Uma entrada por evento · lock exige tau >= 4s e tamanho >= 5 no topo do book oposto.

## A. O `tierMinZ` resgata a banda de favorito caro?


### SEM gate de z (envelope puro) — n=9700

| Banda | n | WR% | ask méd | breakeven% | edge pp | IC95 pp | razão G/P | EV/$ risco % |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| [0.55,0.62) | 1290 | 64.0 | 0.576 | 59.6 | +4.37 | [1.71, 6.95] | 0.678 | +7.34 |
| [0.62,0.70) | 1177 | 69.0 | 0.656 | 67.5 | +1.49 | [-1.22, 4.06] | 0.481 | +2.20 |
| [0.70,0.78) | 1283 | 77.2 | 0.737 | 75.4 | +1.85 | [-0.52, 4.06] | 0.326 | +2.45 |
| [0.78,0.82) | 859 | 83.5 | 0.796 | 81.1 | +2.35 | [-0.29, 4.68] | 0.233 | +2.89 |
| [0.82,0.86) | 984 | 85.5 | 0.836 | 85.0 | +0.51 | [-1.83, 2.57] | 0.177 | +0.60 |
| [0.86,0.90) | 1208 | 89.3 | 0.876 | 88.8 | +0.49 | [-1.38, 2.11] | 0.126 | +0.55 |
| [0.90,0.94] | 2899 | 93.5 | 0.925 | 93.4 | +0.05 | [-0.90, 0.90] | 0.070 | +0.06 |

### COM tierMinZ 2.0 (gate do preset Gold) — n=7714

| Banda | n | WR% | ask méd | breakeven% | edge pp | IC95 pp | razão G/P | EV/$ risco % |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| [0.55,0.62) | 1290 | 64.0 | 0.576 | 59.6 | +4.37 | [1.71, 6.95] | 0.678 | +7.34 |
| [0.62,0.70) | 1177 | 69.0 | 0.656 | 67.5 | +1.49 | [-1.22, 4.06] | 0.481 | +2.20 |
| [0.70,0.78) | 1283 | 77.2 | 0.737 | 75.4 | +1.85 | [-0.52, 4.06] | 0.326 | +2.45 |
| [0.78,0.82) | 859 | 83.5 | 0.796 | 81.1 | +2.35 | [-0.29, 4.68] | 0.233 | +2.89 |
| [0.82,0.86) | 437 | 84.7 | 0.837 | 85.0 | -0.37 | [-4.05, 2.70] | 0.176 | -0.44 |
| [0.86,0.90) | 645 | 89.5 | 0.877 | 88.9 | +0.57 | [-2.04, 2.71] | 0.125 | +0.64 |
| [0.90,0.94] | 2023 | 94.0 | 0.926 | 93.5 | +0.50 | [-0.62, 1.45] | 0.069 | +0.53 |

O gate cortou 1986 de 5091 entradas caras (39.0%).

## B. Complete-set lock — comprar o lado oposto trava lucro?

Eventos com caminho pós-entrada observável: 9700 de 9700.

| Limiar X (lucro travado/share) | eventos que cruzam | % | lucro travado médio/share | vs segurar (EV/share) |
|---|--:|--:|--:|--:|
| >= 0.000 | 8565 | 88.3 | +0.0220 | +0.0711 |
| >= 0.010 | 8387 | 86.5 | +0.0321 | +0.0791 |
| >= 0.020 | 8148 | 84.0 | +0.0421 | +0.0876 |
| >= 0.030 | 7711 | 79.5 | +0.0526 | +0.0962 |
| >= 0.050 | 6160 | 63.5 | +0.0739 | +0.1225 |

Diagnóstico com look-ahead (teto inatingível, só para dimensionar): em 8570 de 9700 eventos (88.4%) existiu ALGUM instante com lock positivo; lucro travável médio no melhor instante 0.1274/share.

### Comparação: vender o próprio no bid (mesma população)

| Limiar X | eventos que cruzam | % | lucro médio/share | vs segurar |
|---|--:|--:|--:|--:|
| >= 0.020 | 8311 | 85.7 | +0.0415 | +0.0830 |
| >= 0.050 | 6714 | 69.2 | +0.0728 | +0.1144 |