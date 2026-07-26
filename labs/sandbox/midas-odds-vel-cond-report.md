# MIDAS — item 2: gates condicionais (ask / dist / tau)

**Data:** 2026-07-26  
**Labs:**
- Julho: `reports/labs/midas-carry-v1/2026-07-26T07-24-36-945Z-odds-vel-cond-july/`
- Junho: `reports/labs/midas-carry-v1/2026-07-26T07-32-59-696Z-odds-vel-cond-june/`

Params novos: `oddsVelCondMode` (0=vel só, 1=AND, 2=OR), `oddsVelCondAskMax`, `oddsVelCondDistMin`, `oddsVelCondMinSecs`.

## Julho

| Rank | Variante | PnL | Δ vs base | Entries | WR | Max DD |
|---:|---|---:|---:|---:|---:|---:|
| 1 | ov-d10-all | 2535 | **+118** | 2309 | 82,2% | 90,9 |
| 2 | **ov-d10-ask070-or-dist30** | 2506 | **+90** | 2340 | 82,0% | 90,4 |
| 3 | ov-d12-ask070-or-dist30 | 2479 | +63 | 2343 | 81,9% | 90,4 |
| 4 | ov-d10-ask070 | 2464 | +48 | 2346 | 81,9% | 90,4 |
| 5 | ov-d10-ask070-tau12 | 2463 | +47 | 2350 | 81,8% | 90,4 |
| 6 | ov-d10-dist30 | 2459 | +42 | 2356 | 81,4% | 95,6 |
| 8 | baseline | 2416 | — | 2362 | 81,3% | 95,6 |

## Junho (stress / proxy de treino)

| Rank | Variante | PnL | Δ vs base | Entries |
|---:|---|---:|---:|---:|
| 1 | **baseline** | **2990** | — | 3021 |
| 2 | **ov-d10-dist30** | 2986 | **−4** | 3009 |
| 3 | ov-d10-ask070-or-dist30 | 2971 | −19 | 2997 |
| 4 | ov-d15-ask070-or-dist30 | 2967 | −23 | 3004 |
| 5 | ov-d10-ask070 | 2965 | −25 | 3005 |
| 6 | ov-d10-all | 2835 | **−155** | 2981 |

## Cruzamento

| Variante | Δ julho | Δ junho | Leitura |
|---|---:|---:|---|
| ov-d10-all | +118 | −155 | Alfa julho caro no junho |
| **ask070∨dist30** | **+90** | **−19** | **Melhor tradeoff** |
| dist30 | +42 | −4 | Quase neutro junho, julho modesto |
| ask070 | +48 | −25 | Ok, inferior ao OR |

## Veredito

1. Condicionar o gate **funciona**: mata quase todo o dano de junho (−155 → −4/−19) e ainda captura boa parte do julho.
2. Melhor candidata frágil: `oddsVelMaxDelta=0.10`, mode OR, `askMax=0.70`, `distMin=30`.
3. **Ainda não ligar default ON** — junho fica levemente negativo; falta walk-forward extra. Mas é o primeiro filtro de odds com perfil train≈neutro / holdout+.
4. Próximo item 3 (size-halve) pode combinar com este OR para zerar o −19 de junho.

## Reproduzir

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/odds-vel-cond-july.json --variant-workers 6
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/odds-vel-cond-june.json --variant-workers 6
```
