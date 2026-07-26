# MIDAS-GOLD — revalidação lab (pós porte robot)

**Data:** 2026-07-26  
**Objetivo:** confirmar que o pacote `g3` / `g3-os` (espelho do porte data-robot) não regrediu vs [midas-package-final-aprovacao.md](./midas-package-final-aprovacao.md).

## Reports desta rodada

| Experimento | Report |
|---|---|
| package-final-july | `reports/labs/midas-carry-v1/2026-07-26T20-11-51-518Z-package-final-july` |
| package-final-june | `reports/labs/midas-carry-v1/2026-07-26T20-16-44-246Z-package-final-june` |
| preset Gold 23–26 | `reports/labs/midas-carry-v1/2026-07-26T20-17-46-591Z-preset-btc-micro-guardian-v3-os` |
| preset aggressive 23–26 | `reports/labs/midas-carry-v1/2026-07-26T20-18-21-910Z-preset-btc-micro-aggressive-v1` |

Lake: BTC 5m depth=25, tip `2026-07-26` (update: 0 copied / 26 skipped).

## Julho 01–25

| Variante | PnL | PF | MaxDD | Pior dia | vs aprovação |
|---|--:|--:|--:|--:|---|
| base | 466,5 | 1,58 | 16,1 | −7,30 | idêntico |
| g3 | 442,5 | 1,62 | 12,7 | −2,24 | idêntico |
| **g3-os** | **432,9** | **1,65** | **11,4** | **−0,22** | idêntico |
| g3-os-hold | 234,8 | 1,33 | 12,8 | −6,38 | hold>0 |
| g3-hold | 232,7 | 1,30 | 15,2 | −6,67 | hold>0 |
| g3-os-2x | 914,6 | 1,65 | 25,1 | +0,47 | PF preservado |

Δ PnL g3-os vs g3: **−2,2%** (limite ±3%).

## Junho 01–08 (stress)

| Variante | PnL | PF | MaxDD | Pior dia | vs aprovação |
|---|--:|--:|--:|--:|---|
| base | 114,2 | 1,51 | 18,5 | −14,5 | idêntico |
| g3 | 115,5 | 1,63 | 12,0 | −7,69 | idêntico |
| **g3-os** | **112,5** | **1,67** | **10,2** | **−6,22** | idêntico |
| g3-os-hold | 40,0 | 1,19 | 23,0 | −15,8 | hold>0 |
| g3-hold | 40,6 | 1,17 | 23,7 | −17,2 | hold>0 |
| g3-os-2x | 250,8 | 1,70 | 24,5 | −7,75 | PF ~linear |

Δ PnL g3-os vs g3: **−2,6%**.

## Smoke preset 23–26/07 (janela live)

| Preset | Entradas | PnL | PF | Dias+ | Pior dia |
|---|--:|--:|--:|--:|--:|
| `btc-micro-guardian-v3-os` (Gold) | 298 | **+90,2** | 2,19 | 4/4 | +9,1 |
| `btc-micro-aggressive-v1` (canário lab antigo) | 334 | +113,6 | 2,36 | 4/4 | +14,5 |

Na janela boa o envelope antigo captura mais PnL (banda alta no dia 23); o Gold troca ~20% de PnL por cauda melhor no package-final (pior dia julho −0,22 vs −7,30). Esperado.

## Critérios de aceite

| Critério | Jul | Jun |
|---|---|---|
| g3-os PnL ≈ g3 (±3%) | PASS (−2,2%) | PASS (−2,6%) |
| PF g3-os ≥ g3 | PASS (1,65≥1,62) | PASS (1,67≥1,63) |
| DD / pior dia g3-os ≤ g3 | PASS | PASS |
| hold > 0 | PASS | PASS |
| 2× preserva PF | PASS (1,65) | PASS (1,70) |

## Veredito

**APROVADO — sem regressão.** Números idênticos à aprovação de 26/07. Seguro seguir o playbook do robot:

1. Deploy canário Guardian-v3 (`canaryMidasPreset`: minSec9 + tierMinZ 2.0 + exit GTC)
2. Gates §6 por 72h
3. Depois A/B Gold OS (`btc-micro-guardian-v3-os` / `canaryMidasGoldPreset`)
