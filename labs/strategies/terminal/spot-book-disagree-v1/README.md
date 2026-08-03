# Spot Book Disagree V1

Lab GLS do desacordo terminal **spotLeader ≠ bookFavorite** (BTC 5m). Hold to settlement.

| Mode | id | Tese |
|---:|---|---|
| 1 | `follow-book-hold` | Comprar favorito do book |
| 2 | `follow-spot-hold` | Comprar líder do spot (controle) |
| 3 | `follow-spot-cheap` | Campeã sonda: spotAsk≤0.40 e bookFavAsk≥0.60 |

## Resultado da sonda (100d)

| Variante | Train PF | Holdout PF | Decisão |
|---|---:|---:|---|
| follow-book | 0.79 | 0.81 | **NO-GO** |
| follow-spot | 1.15 | 1.10 | frágil |
| **follow-spot-cheap** | **1.26** | **1.25** | **GO invertido** |

Fonte: `labs/sandbox/spot-book-disagree/probe.mjs`

## Rodar

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/spot-book-disagree-v1/experiments/smoke.json --variant-workers 3
npm run lab:run -- --experiment labs/strategies/terminal/spot-book-disagree-v1/experiments/holdout-week.json --variant-workers 3
```

## Labs rodados

| Experimento | Janela | Campeã smoke | follow-spot-cheap | follow-book |
|---|---|---|---:|---:|
| smoke | 01–07/06 | follow-spot-cheap +137 PF 1.14 | +137 | −128 |
| holdout-week | 01–07/07 | (todas negativas) | −242 PF 0.84 | −76 PF 0.93 |

Relatórios:

- `reports/labs/spot-book-disagree-v1/2026-08-02T18-17-37-152Z-spot-book-disagree-smoke/`
- `reports/labs/spot-book-disagree-v1/2026-08-02T18-18-12-820Z-spot-book-disagree-holdout-week/`

## Status

- **experimental** — tese primária (follow-book) rejeitada.
- Sonda 100d favorece follow-spot-cheap (PF 1.25), mas **holdout GLS 7d quebrou** — não promover a micro sem janela recente estável.
- Dry observação: `data-robot/scripts/spot-book-disagree/`.
