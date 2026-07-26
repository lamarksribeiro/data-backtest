# Late Cheap Flip V1

Lab GLS que compara **3 teses** de entrada barata em viradas no BTC Up/Down 5m (hold-to-settlement, budget US$ 10, book depth 25).

| Mode | Tese | Lado |
|---:|---|---|
| 1 | `pre_flip` — azarão + momentum ao PTB, sem flip recente | underdog |
| 2 | `post_flip` — favorito pós-cruzamento + edge físico (SBRI-like) | favorito |
| 3 | `late_surprise` — τ curto, favorito físico ainda barato | favorito |

Fonte: `src/backtestStudio/gls/strategies/LateCheapFlipV1.gls`

## Resultado: campeã = mode 3 (`m3-ask35`)

Critério: maior PnL no holdout com PF ≥ 1.2.

| Janela | Variante | PnL | Entradas | WR | PF | Max DD | Dias+ |
|---|---|---:|---:|---:|---:|---:|---|
| Train 27/04–31/05 | **m3-ask35** | **+7444** | 665 | 52.9% | 3.54 | 120 | 26/35 |
| Holdout 01/06–13/07 | **m3-ask35** | **+893** | 461 | 31.5% | 1.30 | 100 | 29/43 |
| Train | m2-midlate | +343 | 92 | 56.5% | 1.89 | 39 | 19/35 |
| Holdout | m2-midlate | +475 | 126 | 57.9% | 1.94 | 39 | 21/43 |
| Train | best m1 (tight-ask) | −354 | 344 | 14.8% | 0.87 | 110 | 8/35 |
| Holdout | m1-tight-ask | −125 | 560 | 17.5% | 0.97 | 138 | 19/43 |

**Mode 1 (`pre_flip`) rejeitado** — WR ~15%, PF &lt; 1 em train e holdout.

**Mode 2** é a alternativa de risco: menos PnL absoluto, WR estável ~58%, DD ~39.

**Mode 3** vence PnL, mas WR caiu de ~53% (train) para ~31% (holdout); o payoff assimétrico (ask ≤ 0.35) ainda deixa EV positiva. MaxDD ≈ wallet — preferir micro-budget em conta real, ou o preset `btc-post-flip-stable`.

### Params campeão (`btc-champion`)

- `entryMode=3`, `minSecondsLeft=3`, `maxSecondsLeft=15`
- `minDistAbs=8`, `minEdge=0.12`, `maxAsk=0.35`
- Hold to settlement

### Preset estável (`btc-post-flip-stable`)

- `entryMode=2`, τ 25–90s, `minDistAbs=12`, `minEdge=0.08`, `maxAsk=0.52`

## Reproduzir

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/late-cheap-flip-v1/experiments/smoke.json --variant-workers 4
npm run lab:run -- --experiment labs/strategies/terminal/late-cheap-flip-v1/experiments/train-modes.json --variant-workers 4
npm run lab:run -- --experiment labs/strategies/terminal/late-cheap-flip-v1/experiments/holdout-modes.json --variant-workers 4
```

Relatórios:

- `reports/labs/late-cheap-flip-v1/2026-07-26T17-51-29-447Z-late-cheap-flip-train-modes/`
- `reports/labs/late-cheap-flip-v1/2026-07-26T17-58-06-231Z-late-cheap-flip-holdout-modes/`

## Status

- **candidate** — holdout positivo; `promotedToStudio: false` até seed de preset se desejado.
- Não confundir com MIDAS/TFC (compram favorito caro) nem com SBRI mid-window (mode 2 é a prima terminal).
