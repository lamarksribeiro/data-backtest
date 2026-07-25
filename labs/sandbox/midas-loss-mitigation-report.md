# MIDAS — loss mitigation labs (book collapse & filtros)

**Data:** 2026-07-25  
**Relatórios:**
- Treino: `reports/labs/midas-carry-v1/2026-07-25T05-47-53-499Z-loss-mitigation-train/`
- Holdout: `reports/labs/midas-carry-v1/2026-07-25T05-59-58-851Z-loss-mitigation-holdout/`

## Motivação

No canário live (2026-07-25) a MIDAS perdeu ~US$ 1,80 em UP@0,60→0 enquanto o RTDS ainda mostrava spot a favor e o book já tinha colapsado (bid ~0,13). Proteções ativas (late flip / danger) não disparam sem cruzamento de spot. Labs testam mitigar esse perfil assimétrico.

## Mecanismo novo

`bookCollapseEnabled` no `strategy.gls`: exit se `bid < avgEntry × ratio` e/ou `bid < absBid`, opcionalmente só com spot ainda favorável (`bookCollapseRequireSpotWinning`).

Também reavaliados: early-warn com `earlyWarnOnlyIfLosing=false`, `minSecondsLeft` 10/12/15, `maxAsk` 0,80/0,86, danger contínuo e combos.

Baseline = envelope aggressive live (dist 40, tier 2,0×, budget 10/30).

## Treino (2026-05-04 → 2026-07-01)

| Rank | Variante | PnL | PF | Max DD | ΔPnL vs base |
|---:|---|---:|---:|---:|---:|
| 1 | **baseline-aggressive** | **5557** | 1,54 | 105 | — |
| 2 | danger-cont | 5387 | 1,53 | 105 | −3% |
| 3 | minsec-10 | 5315 | 1,52 | **97** | −4% |
| 4 | minsec-12 | 5117 | 1,51 | 97 | −8% |
| 5 | maxask-086 | 4837 | 1,50 | 97 | −13% |
| 7 | maxask-080 | 4015 | 1,50 | **79** | −28% |
| 8–20 | ew-book / bc-* / combos | 1846–3743 | ≤1,37 | ≥107 | **−33% a −67%** |

## Holdout (2026-07-01 → 2026-07-22; lake local sem 23–25)

| Rank | Variante | PnL | PF | Max DD | Worst day | ΔPnL | ΔDD |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | **minsec-10** | **2022** | 1,54 | 98 | −26 | **+2%** | +2 |
| 2 | baseline-aggressive | 1983 | 1,51 | 96 | −19 | — | — |
| 3 | minsec-12 | 1974 | 1,53 | 98 | −34 | −0% | +2 |
| 4 | minsec-15 | 1942 | 1,55 | **90** | −26 | −2% | −6 |
| 5 | maxask-086 | 1872 | 1,54 | **80** | −28 | −6% | −16 |
| 6 | **bc-abs-040** | 1847 | 1,52 | **64** | **−7** | −7% | **−33%** |
| 8 | ew-book-060 | 1836 | 1,51 | 78 | −16 | −7% | −18 |
| 20 | combo-full | 1105 | 1,39 | 63 | −39 | −44% | −34 |

## Veredito

1. **Book collapse (ratio 0,50–0,70) e early-warn sem exigir spot losing: rejeitados** como switch geral. Cortam whipsaws demais no treino (−33% a −67% PnL) e não batem o baseline no holdout em PnL.
2. **`bc-abs-040` (exit se bid&lt;0,40 com spot ainda “winning”)**: melhor corte de DD/worst-day no holdout, mas **falha no treino** (−37% PnL). Não promover.
3. **Único candidato frágil: `minSecondsLeft=10`** — holdout +2% PnL, treino −4% com DD um pouco menor. Evita entradas muito tardias (como a live ~12s), sem destruir o carry.
4. **`maxAsk=0,86`**: tradeoff clássico risco/retorno (holdout −6% PnL / −16% DD). Não resolve colapso de book; só evita favoritos caríssimos.
5. Combos (ew+bc+minsec) são os piores: overfit defensivo.

**Conclusão operacional:** manter núcleo aggressive/canário; **não ligar** book-collapse nem early-warn book-aware no live. Se quiser mitigação leve e testável no robot, o próximo A/B é só **`minSecondsLeft: 10`** (ou 12) no micro-aggressive — não os exits de book.

## Reproduzir

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/loss-mitigation-train.json --variant-workers 6
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/loss-mitigation-holdout.json --variant-workers 6
```
