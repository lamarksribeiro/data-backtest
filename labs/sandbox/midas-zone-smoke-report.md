# MIDAS Zone V1 — Smoke 20–22/07/2026

**Experimento:** `labs/strategies/terminal/midas-zone-v1/experiments/smoke-zone-july20-22.json`  
**Report:** `reports/labs/midas-zone-v1/2026-07-26T17-29-30-911Z-smoke-zone-july20-22`  
**Janela:** 2026-07-20 → 2026-07-22 · BTC 5m · book depth 25 · settle 0.995

## Ranking

| Rank | Variante | PnL | Entries | WR | PF | Fees |
|---:|---|---:|---:|---:|---:|---:|
| 1 | **zone-1-baseline** | **+91,30** | 260 | **79,2%** | **1,41** | 28 |
| 2 | zone-2-fixed | −136,16 | 581 | 44,6% | 0,61 | 131 |
| 3 | zone-adaptive | −179,07 | 710 | 38,3% | 0,43 | ~166* |
| 4 | zone-3-fixed | −195,21 | 669 | 41,6% | 0,47 | 166 |
| 5 | zone-4-fixed | −212,07 | 716 | 42,5% | 0,45 | 190 |

\* adaptativo no mesmo patamar de fee/volume das multi-zonas.

## Leitura

1. **O lab está operacional** — zonas artificiais, reentrada após `zone_boundary_exit` e modo adaptativo compilam e rodam em `compiled-soa`.
2. **Baseline 1 zona (= MIDAS terminal) é a única lucrativa** nos 3 dias. Confirma que o envelope MIDAS no fim real ainda carrega edge.
3. **Multi-zona com exit na fronteira destrói o edge**: WR cai de ~79% → ~42%, fees sobem 5–7×. O mark-to-market no meio do evento não é settlement; o z com τ artificial superestima certeza cedo demais.
4. **Mais zonas = pior**: monotônico no smoke (2 → 4). Adaptativo não salvou — ainda gera muitas idas-e-voltas.

## Próximos testes sugeridos (lab já pronto)

- Só permitir entrada em zonas com `secsLeftReal` baixo (ex.: últimas 2 zonas).
- `minEntryZ` / `tierMinZ` mais altos nas zonas precoces.
- Hold sem exit (1 entrada antecipada) — regressão ao early-window já rejeitado na MIDAS.
- Holdout: `experiments/holdout-zone-july.json` (01–18/07).

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/midas-zone-v1/experiments/holdout-zone-july.json
```
