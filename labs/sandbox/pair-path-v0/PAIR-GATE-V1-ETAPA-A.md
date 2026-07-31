# Pair-Gate V1 — Etapa A+B (mai–jun 2026)

**Rodado:** 2026-07-30  
**Contrato:** [`MACHINE-PAIR-GATE-V1.md`](./MACHINE-PAIR-GATE-V1.md)  
**Runner:** [`pair-gate-replay.mjs`](./pair-gate-replay.mjs)  
**Janela limpa:** 2026-05-01 → 2026-06-30 (16.803 eventos elegíveis)  
**Labels:** `scratch/canonical-outcomes-v1.csv` (26.855)

## Veredito

**FAIL / HOLD** — complete-set seletivo sob I1 fee-aware **não passa** os gates pré-declarados.

Duas faces do mesmo muro:

| Config | Opens | PnL | PF | IC95 EV/open | Motivo |
|--------|------:|----:|---:|---|---|
| **Default** (`hedgeAskMax=0.42`, ε=2, buffer=1) | **0** | 0 | 0 | — | I1: proj(0,55+0,42+fees+buffer)=1,014 > 0,98 — **conjunto vazio** |
| Calibração `hedgeAskMax=0.38` | 9.568 | **−1.378,65** | 0,35 | [−0,152; −0,137] | I2: abort/fees comem o prêmio dos pares |

## Achado mecânico

1. Com fees crypto + buffer 1¢ + ε 2¢, o teto de hedge **0,42 não é admissível** junto com open ≥ 55¢. O default do contrato é logicamente estéril — e isso é feature, não bug.
2. Abaixando o teto para 0,38 o máquina **entra** (~57% dos eventos), mas:
   - só **1.690 / 9.568** equalizam (18%);
   - **7.878** abortam (timeout/SL);
   - pair premium bruto ≈ **+$830**;
   - fees + custo de abort ≈ **$2.409** → I2 falha com folga.
3. Bug de contabilidade no abort (custo zerado, PnL = proceeds) foi corrigido antes deste número; relatórios `clean-h38` / `clean-h36` anteriores a `*-fixed` estão **invalidados**.

## Decomposição I2 (`hedgeAskMax=0.38`)

```text
pair premium (pares)     +830
fees                     −281
abort drag (estimado)   ~−2129   (dominante)
PnL líquido             −1379
```

A correção da perna nua (abort a bid ≈ ask−1¢) custa mais do que o prêmio dos poucos pares que fecham — o mesmo muro aritmético do estudo maker/pair de 2026-07-30.

## Artefatos

| Tag | Path |
|-----|------|
| default (0 opens) | `.tmp/pair-gate-replay-clean-default-rerun/` |
| h38 corrigido | `.tmp/pair-gate-replay-clean-h38-fixed/` |
| engine + testes | `pair-gate-engine.mjs` · `pair-gate-engine.test.mjs` (9/9) |

## Decisão

- **Não** shadow, **não** micro-real, **não** religar MULT/escada.
- Família complete-set seletivo com open chase 52–62¢ + hedge taker continua **HOLD**.
- Próxima pesquisa legítima (se houver) é **outra tese** (ex. TSC em paralelo, já HOLD próprio), não afrouxar I1 até o PnL parecer positivo.

## Comandos

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node --test labs/sandbox/pair-path-v0/pair-gate-engine.test.mjs
node labs/sandbox/pair-path-v0/pair-gate-replay.mjs --from=2026-05-01 --to=2026-06-30 --tag=clean-default-rerun
node labs/sandbox/pair-path-v0/pair-gate-replay.mjs --from=2026-05-01 --to=2026-06-30 --hedgeAskMax=0.38 --tag=clean-h38-fixed
```
