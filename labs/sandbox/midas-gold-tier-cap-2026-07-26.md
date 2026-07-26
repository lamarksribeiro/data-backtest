# Hipótese 2 — reduzir size só no high-ask (tier cap)

**Data:** 2026-07-26  
**Experiments:** `gold-tier-cap-july` · `gold-tier-cap-june`  
**Base:** MIDAS-GOLD g3-os · `$10/$30` · settle 0.995 · ask&lt;0.82 permanece `$10`

| Variante | `tierAskBudgetFactor` | Size ask≥0.82 |
|---|---:|---:|
| gold-tier-20 (ref Gold) | 2.0 | ~$20 |
| gold-tier-15 | 1.5 | ~$15 |
| gold-tier-10 | 1.0 | ~$10 (= base) |
| gold-tier-075 | 0.75 | ~$7.5 |

## Julho 01–25

| Variante | PnL | Δ vs ref | PF | MaxDD | Pior dia |
|---|--:|--:|--:|--:|--:|
| **tier-20 (ref)** | **2047,7** | — | 1,571 | 67,7 | −3,89 |
| **tier-15** | **1933,6** | **−5,6%** | **1,577** | **55,3 (−18%)** | **−2,04** |
| tier-10 | 1826,1 | −10,8% | 1,588 | 52,7 (−22%) | −3,06 |
| tier-075 | 1784,9 | −12,8% | **1,601** | 53,6 (−21%) | **−1,97** |

## Junho stress 01–08

| Variante | PnL | Δ vs ref | PF | MaxDD | Pior dia |
|---|--:|--:|--:|--:|--:|
| **tier-20 (ref)** | **562,6** | — | 1,579 | 59,7 | −26,8 |
| **tier-15** | **541,3** | **−3,8%** | **1,582** | **57,7** | **−25,5** |
| tier-10 | 510,5 | −9,3% | 1,572 | 55,2 | −26,6 |
| tier-075 | 497,1 | −11,6% | 1,569 | 53,7 | −27,1 |

Nota: em junho o pior dia quase não muda com o tier — a cauda da semana stress não é dominada pelo high-ask 2×. O ganho de DD/pior dia é sobretudo **julho**.

## ETH julho 01–25 (mesmo desenho)

| Variante | PnL | Δ vs ref | PF | MaxDD | Pior dia |
|---|--:|--:|--:|--:|--:|
| **tier-20 (ref)** | **944,0** | — | 1,270 | 65,5 | −31,15 |
| **tier-15** | **872,3** | **−7,6%** | 1,261 | **59,1 (−10%)** | **−22,29** |
| tier-10 | 773,4 | −18,1% | 1,241 | 63,4 | −12,54 |
| tier-075 | 713,7 | −24,4% | 1,227 | 65,4 | −16,75 |

**ETH também aprova tier 1.5:** cauda bem melhor (−31 → −22), DD −10%, custo PnL ~8%. `tier-10` melhora mais o pior dia mas destrói −18% PnL e PF — não default.

## Veredito

**Aprovado BTC + ETH: `tierAskBudgetFactor: 1.5`.**

Promovido em `btc-gold-v1` / `eth-gold-v1` e `midasGoldPreset()` (`GOLD_PRODUCTION`).
