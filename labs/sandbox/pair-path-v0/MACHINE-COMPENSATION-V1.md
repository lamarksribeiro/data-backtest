# Clip-Path — compensação TOP/BOTTOM (contrato)

**Status:** design + lab sintético · não live  
**Lab:** [`compensation-path-lab.mjs`](./compensation-path-lab.mjs) → `.tmp/clip-path-compensation-lab/report.json`  
**Canvas:** `clip-path-compensacao`  
**Fonte Phil:** `Phil_Hopper_Real_1.0.py` (DESC_SO_ATRAS, BLOCO27, EQ cega, MULT)

---

## Tese

Desbalanceamento **favorável** ≠ residual zero imediato.

```text
TOP  = open/chase (perna cara)
BOTTOM = clips DESC no oposto (perna barata)

Favorável: residual no TOP enquanto cada fill no BOTTOM
           melhora lockedPnL até EQ com avgSum < 1
Adverso:   favorito enfraquece / flip → oposto encarece → stuck
```

Ordem sagrada: **nunca adicionar TOP** após open para “consertar”.

---

## Phil → Clip (o que portar / não portar)

| Phil | Portar? | Clip-Path |
|---|---|---|
| SUB≫DESC + `DESC_SO_ATRAS` | sim (espírito) | só BOTTOM enquanto sh_bottom &lt; sh_top |
| BLOCO27 @27¢ size=dif | parcial | compensation block size=residual @ ask médio |
| EQ cega a 5¢ | **não** | EQ/escape com `avgSum` / locked floor |
| MULT / PISO / contágio | **não** | size fixo, MULT=1 |
| STOP no bid | opcional depois | complete-set: settlement &gt; vender |
| SAIDA +Δc | depois | momentumBroken → abort clips otimistas |

---

## Mecanismos (M1–M5)

### M1 — Momentum / flip pós-open
- Após open: track `ask_lead` e `ask_lag`.
- `momentumOk` se lead sobe e lag cai.
- `momentumBroken` se lead cai −δ → cancel resting, só escape com floor de locked; sem clips “otimistas”.

### M2 — Clip ladder + compensation block
1. Clips fixos (40/36/32) se `proj ≤ avgSumMax` e locked não piora.
2. Block (BLOCO27 light): τ médio, `ask_lag ≤ 0,27–0,30`, uma ordem size=`residual`, ceil ~0,97.
3. Escape staged τ≤20@0,98 → τ≤12@1,00 (nunca &gt;1).

### M3 — Profit lock / exit
- EQ completa + `lockedPer ≥ floor` → `done` (não vender).
- Comfort-stop só com residual **pequeno** e locked já ≥ piso (partial mid-path ainda tem locked negativo — ver lab …6400).
- Se lock-sell no futuro: vender **residual (lado longo) primeiro**.

### M4 — Lab de regimes (já no `compensation-path-lab.mjs`)
`favorable` · `flip_adverse` · `chop` · `late_cheap` · `open_miss` · dry_success/stuck.

Achado: soft-ready no tick do open **não** evita flip; fade idle evita o buraco mas quase não tradeia.

### M5 — Anti-Phil
Sem MULT, sem EQ cega, sem re-arme SUB no lead, sem grade full.

---

## Bugs de entrada a corrigir (ops)

1. `OPEN_MISS_CAP` **não** deve incrementar `openAttempts`.
2. Soft-ready: `opp ≤ hedgeAskMax+slack` com `pairSumMax ≥ 1,05` — **nunca** pair≤1,00.
3. Instrumentar funil: `fora_banda` / `tau` / `miss_cap` / `attempts_esgotados` / `flip`.

---

## Achados study v2 (journals 14 · sh25)

| Label pós-open | n | pnl engine | eq | stuck |
|---|---:|---:|---:|---:|
| favorable | 7 | 13,5 | 7 | 0 |
| no_open | 4 | 0 | 0 | 0 |
| lag_never_cheap* | 2 | 3,2 | 2 | 0 |
| flip_adverse | 1 | 1,55 | 1 | 0 |

\*label = min(lag) no começo da janela; depois ainda clipou.

| Política manual | pnl | eq | stuck | nota |
|---|---:|---:|---:|---|
| base deep3 | 18,3 | 10 | 0 | controle |
| **patient (lag≤36 antes do 1º clip)** | **21,7** | 10 | 0 | +19% vs base nos journals |
| soft_ready | 16,6 | 9 | 0 | −1 trade |
| m1 freeze-on-dip | 36,4 | 10 | 0 | **artefato** de paciência; MC piora |

**Locked curve (sh25):** residual 25 → locked≈−14,5; res 15 → −8,3; res 8 → −3,3; res 0 → **+1,8**. Locked≥0 só no **último fill** (median fillIndex=3).

**Theory:** frac hedged &lt;1 **nunca** dá worst≥0 na grade open∈[55–58]×hedge∈[30–45]. Comfort-stop mid-path = ilusão.

**Monte Carlo 250:** patient/m1 pioram stuck% vs base — paciência ajuda path favorável histórico, custa em regimes mistos.

Runner: `compensation-study2.mjs` · saída `.tmp/clip-path-compensation-study2/`

---

## Critérios de aceite

1. Path tipo …6400: avgSum≤0,94, residual 0, locked&gt;0.
2. Path tipo stuck: **não** flatten caro; residual contabilizado.
3. Nunca EQ com avgSum&gt;1 (Phil …3800).
4. Preferir `lockedPnlPerShare` fee-aware (break-even ~avgSum≤0,966 all-taker).
