# Late Cheap Flip V1

**Status:** candidata (lab GLS validado) · **Lab:** `labs/strategies/terminal/late-cheap-flip-v1/` · **GLS:** `src/backtestStudio/gls/strategies/LateCheapFlipV1.gls` · **Data:** 2026-07-26

## Tese

No fim do evento BTC Up/Down 5m, o book às vezes ainda precifica barato o lado que a física browniana já dá como favorito (`P_phys = Φ(z)`, `z = |spot−PTB|/(σ√τ)`). Compramos esse lado com ask baixo e seguramos até o settlement.

Três modos foram testados no mesmo harness; a campeã é **mode 3 (`late_surprise`)**.

## Comparativo das 3 teses

| Mode | Nome | Holdout PnL | Holdout PF | Holdout WR | Veredito |
|---:|---|---:|---:|---:|---|
| 3 | late_surprise (`m3-ask35`) | **+892.65** | **1.30** | 31.5% | **Campeã** (maior PnL com PF≥1.2) |
| 2 | post_flip (`m2-midlate`) | +474.66 | 1.94 | 57.9% | Alternativa estável (menor DD) |
| 1 | pre_flip (`m1-tight-ask`) | −124.73 | 0.97 | 17.5% | **Rejeitado** |

## Campeão (`btc-champion` / defaults)

| Parâmetro | Valor |
|---|---:|
| `entryMode` | 3 |
| `minSecondsLeft` / `maxSecondsLeft` | 3 / 15 |
| `minDistAbs` | 8 |
| `minEdge` | 0.12 |
| `maxAsk` | 0.35 |
| `entryBudget` | 10 |

| Janela | PnL | Entradas | WR | PF | Max DD | Dias+ |
|---|---:|---:|---:|---:|---:|---|
| Train 27/04–31/05 | +7444.45 | 665 | 52.9% | 3.54 | 120.06 | 26/35 |
| Holdout 01/06–13/07 | +892.65 | 461 | 31.5% | 1.30 | 99.95 | 29/43 |

## Limitações

1. WR train→holdout caiu de ~53% para ~31%; o edge depende do ask barato (assimetría payoff).
2. MaxDD holdout ≈ wallet US$ 100 — em produção preferir micro-budget ou preset `btc-post-flip-stable`.
3. Mode 1 (apostar no azarão antes do flip) destrói capital — não usar.
4. Ainda não seedado no Studio (`promotedToStudio: false`).

## Reproduzir

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/late-cheap-flip-v1/experiments/holdout-modes.json --variant-workers 4
```

Detalhes: `labs/strategies/terminal/late-cheap-flip-v1/README.md`.
