# MIDAS — sweep de piso `minSecondsLeft`

**Data:** 2026-07-25  
**Envelope:** aggressive (dist 40, tier 2.0×, budget 10/30)  
**Sweep:** 5,6,7,8,9,10,11,12,13,14,15,18,20 s  

| Relatório | Path |
|---|---|
| Treino | `reports/labs/midas-carry-v1/2026-07-25T06-36-35-667Z-minsec-floor-train/` |
| Holdout | `reports/labs/midas-carry-v1/2026-07-25T06-45-17-420Z-minsec-floor-holdout/` |

## Resultados (ordenado por segundos)

| s | Treino PnL | Δ vs 5s | Treino DD | Holdout PnL | Δ vs 5s | Holdout DD |
|---:|---:|---:|---:|---:|---:|---:|
| **5** (atual) | **5557** | — | 105 | 1983 | — | 96 |
| 6 | 5508 | −0,9% | 105 | 1972 | −0,5% | 96 |
| 7 | 5449 | −1,9% | 105 | 1973 | −0,5% | 96 |
| 8 | 5400 | −2,8% | **97** | 1976 | −0,3% | 96 |
| **9** | 5406 | −2,7% | **97** | **2008** | **+1,3%** | 98 |
| **10** | 5315 | −4,4% | **97** | **2022** | **+2,0%** | 98 |
| 11 | 5167 | −7,0% | 97 | 1998 | +0,8% | 98 |
| 12 | 5117 | −7,9% | 97 | 1974 | −0,4% | 98 |
| 13 | 4957 | −10,8% | 97 | 1941 | −2,1% | 98 |
| 14 | 4891 | −12,0% | 99 | 1924 | −2,9% | 98 |
| 15 | 4789 | −13,8% | 102 | 1942 | −2,1% | **90** |
| 18 | 4601 | −17,2% | 105 | 1884 | −5,0% | 93 |
| 20 | 4305 | −22,5% | 109 | 1738 | −12,4% | **84** |

## Veredito

- **Melhor holdout:** `minSecondsLeft = 10` (+2,0% PnL vs baseline 5s).
- **Quase empatado / mais conservador no treino:** `9` (+1,3% holdout, só −2,7% treino).
- **Baseline 5s** continua o máximo de PnL no treino; 6–8 quase não mudam o holdout.
- **A partir de 12s** o treino cai depressa e o holdout deixa de melhorar.
- **15–20s** (estilo Escada) cortam DD no holdout extremo, mas destroem PnL nos dois splits — **rejeitar**.

**Recomendação canário:** subir de **5 → 9 ou 10**. Preferência operacional **10** (melhor HO) ou **9** (menos custo no treino). Não ir além de 11 sem novo lab.
