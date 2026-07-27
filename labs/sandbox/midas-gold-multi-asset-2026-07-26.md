# MIDAS Gold multi-ativo — calibração julho 2026-07-26

**Núcleo:** g3-os · `$10/$30` · `tierAskBudgetFactor 1.5` · settle 0.995 · FAK/GTC  
**Eixos testados:** `ref` (dist40/adv8) · `scaled` · `loose` · `off` × protect/hold  
**Janela:** 2026-07-01 → 2026-07-25 · depth25

## Vereditos

| Ativo | Estúdio | PnL | PF | Hold PnL | protect≥hold | Veredito |
|-------|---------|----:|---:|---------:|:------------:|----------|
| BTC | v11 | 1934 | 1,58 | — | — | já campeão |
| ETH | v12 | 872 | 1,26 | — | — | já candidato |
| **SOL** | **v13** | **497** | **1,28** | 397 | sim | **APROVADO** `sol-gold-v1` |
| **XRP** | **v14** | **360** | **1,28** | 218 | sim | **APROVADO** `xrp-gold-v1` |
| **DOGE** | **v15** | **293** | **1,31** | 30 | sim | **APROVADO** `doge-gold-v1` |
| **HYPE** | **v16** | **85** | **1,33** | 30 | sim | **APROVADO** `hype-gold-v1` |
| BNB | — | −95 | 0,69 | −4 | não (ambos −) | **REPROVADO** |

## Achados

1. Em SOL/XRP/DOGE/HYPE, `ref` ≡ `loose` ≡ `off` — `maxDistAbs 40` **não liga** (preço baixo vs BTC). O núcleo Gold porta sem rescale de dist.
2. `scaled` (dist proporcional ao preço) corta entradas e **não melhora** PnL/cauda.
3. Micro SOL antigo falhava (hold>protect); com **`$10/$30` + tier 1.5** o SOL **passa** (proteções valem +$100).
4. BNB: protect pior que hold e ambos negativos — não promover sem redesenho.

## Presets

`sol-gold-v1` · `xrp-gold-v1` · `doge-gold-v1` · `hype-gold-v1`  
Params = BTC Gold (`maxDistAbs 40`, `maxAdverseSpotChange 8`, tier 1.5).

## Experiments

`gold-calibrate-{sol,xrp,doge,hype,bnb}-july.json`
