# TFC V7 — Pré-check fill maker (conservador)

Janela: **2026-05-04 → 2026-07-01** | Regra: limit em ask−0.01, fill se ask ≤ P−0.01 antes de τ=10s

## Números principais

| Split | n entradas | % fill maker | WR c/ fill | WR s/ fill | n fallback τ≈10s | WR fallback |
| --- | --- | --- | --- | --- | --- | --- |
| train | 1915 | 60.7% | 63.5% | 91.6% | 443 | 70.0% |
| june | 2218 | 63.3% | 63.6% | 92.0% | 617 | 66.5% |
| **all** | **4133** | **62.1%** | **63.6%** | **91.8%** | **1060** | **67.9%** |

## Expectância hold proxy (sem late flip)

| Split | exp maker fill | exp sem fill | exp fallback τ≈10s |
| --- | --- | --- | --- |
| train | $-0.69 | $2.91 | $0.35 |
| june | $-0.60 | $3.13 | $-0.04 |
| all | $-0.64 | $3.02 | $0.13 |

## Metodologia

- Fonte: DuckDB direto em `backtest_ticks` BTC 5m depth 25.
- Entrada: primeiro tick com gates V5 Practical em τ∈[5,30).
- WR hold: compra do favorito ao preço maker (se fill) ou ask de entrada (sem fill); settlement binário no último tick.
- Fallback: gates reavaliados no tick mais próximo de τ=10s; WR usa ask desse tick.
- **Informativo** — não bloqueia implementação da infra V7.

