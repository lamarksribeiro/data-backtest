# MIDAS — filtro de ENTRADA por velocidade de odds

**Data:** 2026-07-26  
**Mecanismo:** `oddsVelGateEnabled` (default OFF) — bloqueia entrada se, no lookback, o ask do oposto sobe ≥ Δ ou o ask do favorito cai ≥ Δ.  
**Labs:**
- Holdout: `reports/labs/midas-carry-v1/2026-07-26T04-51-31-712Z-odds-vel-gate-july/`
- Treino: `reports/labs/midas-carry-v1/2026-07-26T05-25-03-247Z-odds-vel-gate-train/`

## Motivação

O scan mostrou que ~90% do loss PnL está em paths de virada UP/DOWN. Exits por odds (`oddsShock`) destruíram treino (whipsaw). Hipótese: **não entrar** quando o book já está reprecificando rápido.

## Holdout julho (01–25)

| Rank | Variante | PnL | Entries | WR | PF | Max DD | vs base PnL |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | **ov-d10** | **2535** | 2309 | **82,2%** | **1,62** | 90,9 | **+4,9%** |
| 2 | ov-d12-ms10 | 2531 | 2246 | 82,2% | 1,65 | 90,4 | +4,7% |
| 3 | ov-d08 | 2527 | 2267 | 82,2% | 1,64 | 91,2 | +4,6% |
| 4 | **ov-d12-lb3** | 2521 | 2307 | **82,3%** | 1,62 | **84,3** | +4,3% |
| 5 | ov-d12 | 2504 | 2318 | 82,1% | 1,61 | 90,4 | +3,6% |
| 7 | ov-d15 | 2464 | 2327 | 81,9% | 1,59 | 90,4 | +2,0% |
| 8 | ms10-ref | 2431 | 2294 | 81,4% | 1,58 | 97,8 | +0,6% |
| 9 | **baseline** | **2416** | 2362 | 81,3% | 1,56 | 95,6 | — |
| 10 | ov-d20 | 2367 | 2346 | 81,4% | 1,55 | 95,6 | −2,0% |

Quase todos os gates batem o baseline em PnL, WR e PF. `ov-d12-lb3` é o melhor DD (−12%).

## Treino (05-04 → 07-01)

| Rank | Variante | PnL | Entries | WR | Max DD | vs base PnL |
|---:|---|---:|---:|---:|---:|---:|
| 1 | **baseline** | **5557** | 5638 | 80,5% | 105 | — |
| 2 | ov-d20 | 5405 | 5611 | 80,6% | **95** | **−2,7%** |
| 3 | ov-d15 | 5332 | 5580 | 80,6% | 96 | −4,0% |
| 4 | ms10-ref | 5315 | 5471 | 80,4% | 97 | −4,4% |
| 5 | ov-d12 | 5251 | 5563 | 80,6% | 97 | −5,5% |
| 6 | ov-d10 | 5210 | 5539 | 80,7% | 98 | −6,2% |
| 7 | ov-d12-lb3 | 5182 | 5545 | 80,7% | 97 | −6,7% |
| 8 | ov-d08 | 5119 | 5490 | 80,7% | 101 | −7,9% |
| 9 | ov-d12-ms10 | 5026 | 5399 | 80,5% | 99 | −9,5% |

No treino o gate **sempre custa PnL**; DD melhora um pouco nos limiares frouxos (d15/d20).

## Cruzamento train × holdout

| Variante | ΔPnL treino | ΔDD treino | ΔPnL julho | ΔDD julho | Leitura |
|---|---:|---:|---:|---:|---|
| ov-d20 | −2,7% | −9% | −2,0% | 0 | Quase neutro, sem alfa |
| ov-d15 | −4,0% | −9% | +2,0% | −5% | Frágil |
| ov-d12 | −5,5% | −7% | +3,6% | −5% | Holdout bom, treino caro |
| ov-d10 | −6,2% | −6% | **+4,9%** | −5% | Melhor julho; treino −6% |
| ov-d12-lb3 | −6,7% | −7% | +4,3% | **−12%** | Melhor DD julho |
| ov-d08 | −7,9% | −3% | +4,6% | −5% | Over-block |

## Veredito

1. **Filtro de entrada é bem melhor que exit** — no holdout sobe PnL e WR; exit destruía os dois.
2. **Não promove como default ON:** o ganho de julho (−53 a −118 trades filtrados) não se replica no treino (−2,7% a −9,5% PnL).
3. **Candidata frágil para A/B:** `oddsVelMaxDelta: 0.15` ou `0.12` com lookback 2–3s — só se aceitar tradeoff treino/holdout (recente regime July-like).
4. Manter `oddsVelGateEnabled: false` nos presets. Param fica no GLS para reuso.

## Reproduzir

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/odds-vel-gate-july.json --variant-workers 6
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/odds-vel-gate-train.json --variant-workers 6
```
