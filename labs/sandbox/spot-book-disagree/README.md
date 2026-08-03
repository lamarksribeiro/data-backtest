# Spot×book disagreement (SBD) — líder barato

**Pergunta:** perto do fim do BTC 5m, quando o líder do spot (vs PTB) discorda do favorito do book, o book antecipa a reversão?

## Definição do sinal

```
spotLeader   = underlying >= price_to_beat ? UP : DOWN
bookFavorite = upAsk >= downAsk ? UP : DOWN
disagree     = spotLeader !== bookFavorite
bookEdge     = bookFavAsk - spotAsk          # ≥ 0.05
|dist|       = |underlying - price_to_beat|  # ≤ 15
tau          ∈ [10, 40] s
oddsSum      ∈ [0.96, 1.06]
spread       ≤ 0.04 no lado do bookFav
```

Entrada = **primeiro** tick do evento que passa os gates (hold até settle).

| Tese | Lado comprado | Papel |
|------|---------------|-------|
| **follow-book** | `bookFavorite` | tese primária do plano |
| **follow-spot** | `spotLeader` | controle |
| **follow-spot-cheap** | `spotLeader` se spotAsk≤0.40 e bookFavAsk≥0.60 | campeã (tese invertida / screenshots) |

Fee taker `0.07·p·(1−p)`, budget $10, settle 0.995. Winner = último tick spot vs PTB.

## Resultado (100d, train≤2026-06-30)

| Variante | n train | PF train | n holdout | PF holdout | Decisão |
|---|---:|---:|---:|---:|---|
| follow-book | 2928 | 0.79 | 1284 | 0.81 | **NO-GO** |
| follow-spot | 2928 | 1.15 | 1284 | 1.10 | frágil |
| follow-spot-cheap | 1361 | **1.26** | 588 | **1.25** | **GO invertido** |

O book “acerta” ~60% das vezes, mas o ask do favorito (~0.55–0.80) deixa EV negativa. O edge está em comprar o líder do spot **barato** quando o book discorda forte — exatamente o payout alto das screenshots.

Incidência SBD ~16.5% dos eventos; em τ fixo 30s ~4.3%.

## Critério GO

- Primário: follow-book PF≥1.15 holdout e > follow-spot → **falhou**
- Invertido: follow-spot-cheap PF≥1.15 holdout → **passou** → lab GLS `spot-book-disagree-v1`

## Rodar

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node labs/sandbox/spot-book-disagree/probe.mjs
node labs/sandbox/spot-book-disagree/probe.mjs --from=2026-07-20 --to=2026-07-31 --trainEnd=2026-07-25
```

Saída: `.tmp/spot-book-disagree/report.json`
