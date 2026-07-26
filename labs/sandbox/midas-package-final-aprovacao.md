# Pacote final MIDAS — aprovação de lab

**Data:** 2026-07-26  
**Experimentos:** `package-final-july` · `package-final-june`  
**Reports:**
- `reports/labs/midas-carry-v1/2026-07-26T16-13-16-749Z-package-final-july`
- `reports/labs/midas-carry-v1/2026-07-26T16-17-44-975Z-package-final-june`

**Ambiente:** parquet local (BTC 5m depth=25), `settleWinnerPrice: 0.995`, micro `$2/$4`.

## Veredito

**APROVADO** — pacote `g3-os` = guardian-v3 + odds-shock partial50.

Preset: `presets/btc-micro-guardian-v3-os.json`.

## Conteúdo do pacote

| Peça | Params |
|---|---|
| Envelope | `maxAsk 0.94`, `tierAskBudgetFactor 2.0`, `maxDistAbs 40` |
| Guardian-v3 | `minSecondsLeft 9`, `tierMinZ 2.0` |
| Odds-shock | `Enabled true`, Δask 0.15/2s, `minOppAsk 0.50`, `minBidRatio 0.55`, `partialPct 0.5`, janela 20→3s, reverse off |
| Proteções base | lateFlip exit/reverse + danger ON |
| Escala (fase A, depois gates) | `entryBudget 4` / `maxEntryBudget 8` (2×) — PF preservado no lab |

## Resultados

### Julho 01–25

| Variante | PnL | PF | MaxDD | Pior dia | ΔPnL vs g3 |
|---|--:|--:|--:|--:|--:|
| base (canário) | 466,5 | 1,58 | 16,1 | −7,30 | — |
| g3 | 442,5 | 1,62 | 12,7 | −2,24 | — |
| **g3-os (pacote)** | **432,9** | **1,65** | **11,4** | **−0,22** | **−2,2%** |
| base-os | 455,8 | 1,60 | 14,0 | −4,05 | — |
| g3-os-hold | 234,8 | 1,33 | 12,8 | −6,38 | hold>0 |
| g3-hold | 232,7 | 1,30 | 15,2 | −6,67 | hold>0 |
| g3-os-2x | 914,6 | 1,65 | 25,1 | +0,47 | escala linear |

### Junho 01–08 (stress)

| Variante | PnL | PF | MaxDD | Pior dia | ΔPnL vs g3 |
|---|--:|--:|--:|--:|--:|
| base | 114,2 | 1,51 | 18,5 | −14,5 | — |
| g3 | 115,5 | 1,63 | 12,0 | −7,69 | — |
| **g3-os (pacote)** | **112,5** | **1,67** | **10,2** | **−6,22** | **−2,6%** |
| g3-os-hold | 40,0 | 1,19 | 23,0 | −15,8 | hold>0 |
| g3-os-2x | 250,8 | 1,70 | 24,5 | −7,75 | escala ~2,2× |

## Critérios de aprovação (todos OK)

1. Pacote PnL ≈ g3 (±3%): julho −2,2%, junho −2,6% — **pass**
2. PF ≥ g3: 1,65≥1,62 e 1,67≥1,63 — **pass**
3. DD e pior dia ≤ g3 nas duas janelas — **pass** (julho pior dia −0,22 vs −2,24)
4. Hold (proteções lateFlip/danger off, OS on) > 0 nas duas — **pass**
5. Escala 2× preserva PF — **pass**

## O que NÃO entra no pacote

- earlyWarn / bookCollapse / oddsShock reverse — rejeitados em labs anteriores
- honest-v2 (maxAsk 0,90 + tier 1,5) — supersedido por guardian-v3
- Ligar OS no live antes de GTC per-leg + uptime 24/7

## Deploy (ordem obrigatória)

1. Fix GTC per-leg + uptime 24/7 no data-robot  
2. Porte guardian-v3 (`tierMinZ` + `minSecondsLeft 9`)  
3. Gates §6 (3+ dias)  
4. Escala 2× (`$4/$8`)  
5. A/B odds-shock (`g3-os`) — porte ask lookback 2s + exit parcial 50%

## Extensão robust (dist 30 + tier 1.5) — 2026-07-26

Experimentos: `package-final-robust-july` / `package-final-robust-june`  
Reports: `2026-07-26T16-34-52-065Z-package-final-robust-july`, `2026-07-26T16-39-23-150Z-package-final-robust-june`

| Variante | Envelope | Jul PnL | Jul PF | Jul pior | Jun PnL | Jun PF | Jun pior | vs g3-os |
|---|---|--:|--:|--:|--:|--:|--:|---|
| **g3-os ★** | 40 / 2.0 | **432,9** | 1,65 | **−0,22** | **112,5** | 1,67 | **−6,22** | ref |
| r30 | 30 / 1.5 | 422,6 | 1,61 | −5,21 | 108,3 | 1,59 | −12,9 | cauda pior |
| r30-g3 | 30 / 1.5 + g3 | 404,1 | 1,64 | −2,17 | 112,5 | 1,72 | −9,47 | jun pior piora |
| r30-g3-os | 30 / 1.5 + pacote | 395,6 (−9%) | **1,67** | +0,12 | 107,7 (−4%) | **1,75** | −8,00 | rejeitado |
| d30-t20-g3-os | 30 / 2.0 + pacote | 418,2 (−3%) | 1,66 | −0,81 | 113,4 | **1,77** | −7,96 | jun pior piora |
| d40-t15-g3-os | 40 / 1.5 + pacote | 410,6 (−5%) | 1,66 | +0,23 | 106,0 (−6%) | 1,66 | −6,59 | PnL↓ sem ganho de cauda |

**Veredito robust:** **não promover** `maxDistAbs 30` / `tierAskBudgetFactor 1.5` no pacote.  
- `r30` sozinho melhora DD vs base, mas o pior dia (−5/−13) fica longe do g3-os (−0,2/−6).  
- `r30-g3-os` paga −9% PnL em julho; em junho o pior dia **piora** (−8,0 vs −6,2) — regime-dependente.  
- Ablations (só dist30 ou só tier1.5) não batem g3-os nas duas janelas ao mesmo tempo.

Campeão permanece **g3-os (40 / 2.0 + minSec9 + tierMinZ 2.0 + odds-shock 50%)**.

## Reproduzir

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/package-final-july.json --variant-workers 6
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/package-final-june.json --variant-workers 6
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/package-final-robust-july.json --variant-workers 6
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/package-final-robust-june.json --variant-workers 6
```
