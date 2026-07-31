# PTB-Path V1 — selective complete-set (lab candidate)

> **SUPERSEDED / HOLD (2026-07-30):** a campanha posterior de 378 sementes,
> 768 mecanismos e seis finalistas falsificou esta candidata em
> 2026-04-23..2026-07-28. Todos os finalistas tiveram PnL negativo, PF < 1 e
> bootstrap p05 negativo. O comando de dry abaixo é registro histórico e **não
> está autorizado para execução**. Resultado canônico:
> [`../../../docs/labs/pair-clip-shotandgo-day29-exhaustive-2026-07-30.md`](../../../docs/labs/pair-clip-shotandgo-day29-exhaustive-2026-07-30.md).

**Status histórico:** LAB CANDIDATE (não GO live)  
**Evolução:** Pair-Path / Clip-Path contínuo → **filtro PTB** + clip tight2  
**Lab runner:** `ptb-protect-ab.mjs` · **Dry/live:** `data-robot/scripts/pair-path/micro-live.js`

> O lake-replay contínuo (95 dias, 24k eventos) perde. PTB-Path lucra quando
> **só abre** com spot já ≥ `openLeaveUsd` do PTB na direção do favorito, depois
> equaliza com clip ASAP. Sem esse filtro, `never_left` destrói o PnL.

---

## 1. Tese

Complete-set com momentum já estabelecido:

```text
signedDist = (btc − PTB) favorável ao lado chase
open só se signedDist ≥ openLeaveUsd (ex. $28–30)
hedge ASAP com clip 50%@≤40 + 50%@≤36, avgSumMax 0.95
```

Não é arbitragem atômica no open — o edge vem do movimento **antes** da entrada.

---

## 2. Contrato (candidato lab)

| Parâmetro | Valor | Notas |
|-----------|-------|--------|
| `openLeaveUsd` | **28–30** | sweet spot lab; 25 mais opens, 30 menos cauda |
| `clip` | **tight2** / `ptb` | 50%@40 + 50%@36, avgSum 0.95 |
| `hedgeMode` | **asap** | equaliza cedo; menor lucro que `ptb` mas worst melhor |
| `hedgeMode` alt | `ptb` | hedge só após leave≥40 e dist≤25 — +lucro, +residual |
| `openShares` | 10 | micro live |
| `openCapCents` | 2 | alinhado live anterior |
| `ptbLeaveUsd` | 40 | arm para hedge-ptb |
| `ptbApproachUsd` | 25 | janela de retorno ao PTB |

**Proibido promover sem:** dry Giovanna com RTDS+PTB, paridade fill, semana holdout.

---

## 3. Resultados lake (depth-25, fee 0.07, sh10)

### Semana 22–29/07 — hedge-asap + clip tight2

| openLeave | Opens | Realized | PF | Worst |
|-----------|-------|----------|-----|-------|
| **28** | 62 | **+$9,37** | 1,34 | −$5,77 |
| 30 | 44 | +$4,72 | 1,24 | −$5,77 |
| 25 | 94 | −$15,14 | 0,76 | −$5,87 |

### 15–29/07 (15 dias)

| Config | Realized | Nota |
|--------|----------|------|
| asap leave28 | −$3,51 | regime misto — dias 15, 19–21, 27 perdem |
| asap leave30 | +$4,72 | mais seletivo |
| **ptb leave28** | **+$97,38** | lucro alto, 19% eq, worst −$5,87 |

### Dia 29/07 isolado — asap leave30 tight2

+**$4,20**, 8 opens, worst **+$0,24** (vs −$111 contínuo lake-replay).

---

## 4. Como rodar

### Lab (rápido)

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node labs/sandbox/pair-path-v0/ptb-protect-ab.mjs --from=2026-07-28 --to=2026-07-29 --shares=10 --openLeaveUsd=30 --clip=tight2
node labs/sandbox/pair-path-v0/ptb-path-week-report.mjs --from=2026-07-22 --to=2026-07-29 --openLeaveUsd=28 --clip=tight2
```

### Dry Giovanna

```powershell
cd d:\Projetos\projeto-goldenlens\data-robot
node scripts/pair-path/micro-live.js --clip=ptb --open-leave-usd=30 --hedge-mode=asap --open-shares=10 --max-events=3 --open-cap-cents=2 --min-tau-start=150
```

Ou `bash labs/sandbox/pair-path-v0/boot-micro-dry-ptb-path.sh` no container Giovanna.

---

## 5. Gates antes de live

1. Dry 5+ eventos com `OPEN_PTB_LEAVE` bloqueando corretamente
2. Paridade avgSum vs CLOB nos fills
3. Semana holdout positiva (asap leave28–30)
4. Worst evento documentado (flip / never_left)

---

## 6. Relação com estratégias anteriores

| Estratégia | Problema | PTB-Path |
|------------|----------|----------|
| Shotandgo full | MULT + escada | rejeitado |
| Pair/Clip contínuo | abre sem movimento | rejeitado lake |
| Clip 14 journals | in-sample only | não generaliza |
| **PTB-Path** | filtro de regime | **lab candidate** |
