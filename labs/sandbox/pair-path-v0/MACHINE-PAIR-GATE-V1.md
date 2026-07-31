# Pair-Gate V1 — máquina reconstruída por invariantes

**Status:** `HOLD` — Etapa A+B FAIL na janela limpa (2026-07-30)  
**Data:** 2026-07-30  
**Família:** complete-set seletivo (não escada, não TSC)  
**Lab:** `labs/sandbox/pair-path-v0/`  
**Resultado:** [`PAIR-GATE-V1-ETAPA-A.md`](./PAIR-GATE-V1-ETAPA-A.md)  
**Antecessores rejeitados / HOLD:** Shotandgo full · Pair/Clip contínuo · PTB-Path · Clip-Path amplo  
**Evidência canônica:** [`../../../docs/labs/pair-clip-shotandgo-day29-exhaustive-2026-07-30.md`](../../../docs/labs/pair-clip-shotandgo-day29-exhaustive-2026-07-30.md)

> Esta máquina **não** tenta salvar a escada Phil/Redux3.  
> Ela reordena as camadas para enforçar as únicas desigualdades que os dados
> permitem como caminho de lucro em complete-set.

---

## 0. Por que esta máquina existe

Os dados já provaram:

| Fato | Implicação |
|------|------------|
| Complete-set taker instantâneo: 0/157k snapshots lucrativos pós-fee | Entrar nos dois lados “agora” é morto |
| Maker: desconto = movimento adverso do fill | DESC/EQ resting não são edge grátis |
| Residual histórico come o prêmio do par | Inventário nua é o inimigo #1 |
| MULT / viradas tardias | Amplificam a cauda; lab flat perde menos |
| 4 pares reais 28–29/07 com avgSum&lt;1 e zero residual | O mecanismo **pode** ocorrer; raro e seletivo |
| Path full avgSum mediana ~1,045 | Escada contínua não fecha |

**Tese que fica:** par barato ou não entrar.  
**Tese que sai:** “montar inventário e equalizar depois”.

---

## 1. Invariantes (obrigatórias)

Lucro só é admissível se **as três** forem verdadeiras em expectativa:

```text
(I1) projCost = p1 + p2 + fee1 + fee2 + buffer  ≤  1 − ε
(I2) E[custo_residual_e_abort]  <  E[prêmio_dos_pares]
(I3) preço_contábil = fill real (API/tape); nunca ask do gatilho
```

Qualquer camada que viole I1–I3 **não entra** no contrato.

### Tradução operacional

| Invariante | Regra de máquina |
|------------|------------------|
| I1 | Gate de par **antes** da 1ª ordem; hedge só se proj ainda fecha |
| I2 | No máx. 1 perna nua; timeout + abort com SL; sem martingale |
| I3 | `taker_limit` / trade-through; miss ≠ fill fantasma |

---

## 2. Camadas (ordem correta)

```text
C0  Ledger append-only (skip + ordem + fill + settlement)
C1  Universo / anti-lixo
C2  Gate de par          ← novidade vs V0/Clip/Phil
C3  Inventário ≤ 1 nua
C4  Execução honesta
C5  Sizing unitário
C6  Política de residual / abort
C7  Saídas (SL obrigatório; TP opcional)
C8  Higiene de book (do Redux3, sem a escada)
```

### O que morre (explícito)

| Herança Phil / Redux3 / Clip | Motivo |
|------------------------------|--------|
| Grade 8×8 + rearme | Viola C3 |
| MULT, contagio, PISO, MULT_CALC | Viola C5 e I2 |
| Geração completa a cada virada | Recompra sem C2 |
| BLOCO27 / SUB35 / EQ cega @4¢ | Maker sem I1; residual |
| Teto $10k / MAX_VIRADAS=20 | Sem freio real |
| STOP só como take-profit (+$7) | Não cobre cauda |
| Clips 4/3/3 abaixo de 5 shares | Inexequível na corretora |

### O que reutiliza do Redux3 (só higiene)

- Leitura Positions autoritativa
- Cancela encalhada / cancela-abaixo
- Limpa book ao armar hedge/EQ
- Anti-glitch + espera se abertura já decidida
- Fill assíncrono sem inventar `matched=0`

---

## 3. Estado

```text
mode: idle | open | hedged | aborted | done | blocked

sideOpen: UP | DOWN | null
sharesOpen, costOpen
sharesHedge, costHedge          # 0 até hedge fill
openedAtTs, openedAtTau
projAtOpen                      # I1 no instante da entrada
blocks[]                        # razões C1/C2/C4…
fills[]
ledgerEvents[]                  # C0 — inclusive skips
```

Transições:

```text
idle ──C2∧C4──► open ──C2∧C4──► hedged ──► done
                 │
                 └──C6/C7──► aborted ──► done
blocked: C1 falhou ou evento ignorado (espera / glitch / fora de tau)
```

**Proibido:** `open → open` (segundo open), `hedged → open`, qualquer compra após `aborted|done`.

---

## 4. Contrato por camada

### C0 — Ledger

Cada ciclo de evento grava, append-only:

```text
event_slug, ts, kind ∈ {
  SKIP_C1, SKIP_C2, OPEN_ATTEMPT, OPEN_MISS, OPEN_FILL,
  HEDGE_ATTEMPT, HEDGE_MISS, HEDGE_FILL,
  ABORT, SL, TP, EQ, SETTLEMENT, BLOCK
}
```

**Gate de engenharia:** 0 oportunidades sem registro (incluindo skips).

### C1 — Universo

| Param | Default | Motivo |
|-------|--------:|--------|
| `antiGlitchSumLo/Hi` | 0,85 / 1,15 | book cruzado |
| `esperaLimiteC` | 70 | mercado já decidido |
| `esperaGatilhoC` | 55 | libera só se reequilibra |
| `tauOpenMin` | 40 | fim = vacuum |
| `tauOpenMax` | 240 | início ruidoso |
| `filtroAskLo/Hi` | 0,10 / 0,95 | book vivo |

### C2 — Gate de par (núcleo)

Antes de **qualquer** ordem:

```text
fee(p) = 0.07 · p · (1 − p)     # crypto Polymarket
projOpen = ask1_cap + ask2_max + fee(ask1_cap) + fee(ask2_max) + buffer
entrar ⇔ projOpen ≤ 1 − ε
```

| Param | Default pré-declarado | Notas |
|-------|----------------------:|-------|
| `ε` (epsCents) | **2** | folga além das fees explícitas |
| `bufferCents` | **1** | slip/latência residual no proj |
| `openAskLo/Hi` | 0,52 / 0,62 | favorito leve (herança V0) |
| `openTrigger` | 0,55 | |
| `openCapCents` | 2 | taker_limit |
| `hedgeAskMax` | 0,42 | teto da 2ª perna no proj |
| `avgSumMax` | **0,96** | pós-fill alvo (mais apertado que V0 0,995) |

No hedge, **reavaliar** I1 com `costOpen/sharesOpen` real + `ask2_cap` atual.  
Se não fecha → **não hedgeia**; vai para C6 (abort), não “espera EQ”.

### C3 — Inventário

```text
shares_nuas ≤ openShares
tempo_nua   ≤ T_hedge_sec
opens_por_evento ≤ 1
```

| Param | Default |
|-------|--------:|
| `openShares` | 5 (mínimo corretora; micro depois 10) |
| `T_hedge_sec` | **8** |
| `maxOpenAttempts` | 3 (só miss de cap; OPEN_MISS **não** gasta attempt — bug Clip a corrigir) |

### C4 — Execução

| Perna | Modo | Miss |
|-------|------|------|
| Open | FAK/taker_limit @ min(ask, trigger+cap) | fica `idle` |
| Hedge | FAK/taker_limit @ ≤ hedgeAskMax + hedgeCap | tenta abort (C6), **não** resting longo |
| EQ | só se já quase pareado e `proj ≤ 1−ε` e ask ≤ `eqAskMax` | skip |

| Param | Default |
|-------|--------:|
| `hedgeCapCents` | 2 |
| `eqAskMax` | 0,08 |
| `latencyTicks` | **≥ 1** | decisão em t, book em t+1 (lake ~0,5s) |
| `makerHedge` | **off** no V1 | ligar só em V1.1 se tape-through provar |

FOK/FAK valida pelo **pior nível** do walk, nunca só VWAP.

### C5 — Sizing

```text
MULT = 1
contagio = off
size_open = size_hedge = openShares
maxEventNotional = openShares × 1.0 × 1.15   # ~$5.75 @ sh5; ~$11.5 @ sh10
```

Sem PISO, sem MULT_CALC, sem clip fracionado &lt; 5 sh.

### C6 — Residual / abort

```text
se mode==open AND (agora - openedAtTs ≥ T_hedge_sec OR mark_to_bid ≤ −SL):
  abort:
    se bid do lado nua × shares ≥ notional_min: vender FAK
    senão: hold até settlement (poeira &lt; 5sh) e registrar RESIDUAL
```

| Param | Default | Papel |
|-------|--------:|-------|
| `SL_usd` | **0,40** @ sh5 (**0,80** @ sh10) | stop de perda real |
| `abortPreferSell` | true | default abort &gt; hold |
| `holdOnlyIfDust` | true | hold só se &lt; 5sh ou notional &lt; $1 |

**Proibido:** “esperar azarão a 4¢ para equalizar”.

### C7 — Saídas

| Tipo | Gatilho | Ação |
|------|---------|------|
| Complete-set | hedge fill e shares iguais (±1) | `hedged` → `done` |
| Stop-loss | mark ≤ −SL ou timeout nua | abort |
| Take-profit | **off** no V1 | não realizar parcial antes do set |
| Settlement | fim do evento | PnL canônico (Gamma/CLOB) |

### C8 — Higiene

- Cancelar bids pousados se odd fugir `cancelaDistC` (default 7)
- Ao decidir abort/done: cancelar **tudo** no book do evento
- Positions (se live) prevalece sobre conta interna

---

## 5. Loop (pseudocódigo)

```text
onTick(book, tau, spot?):
  ledger.heartbeat()
  if not C1_ok: block; return
  if mode in {done, aborted, blocked}: return

  if mode == idle:
    if C2(projOpen) and C4_open_ready:
      attempt open
      on fill → mode=open; record projAtOpen
      on miss → stay idle (cap attempts)
    else:
      SKIP_C2

  if mode == open:
    if C2(projHedge with real avgOpen) and askOpp ≤ hedgeAskMax:
      attempt hedge
      on fill → mode=hedged → done
      on miss → continue until T_hedge
    if timeout or mark ≤ −SL:
      abort → aborted → done
```

---

## 6. Knobs (só três eixos de calibração)

Calibrar **um eixo por vez**, holdout congelado:

| Ordem | Knob | Faixa de busca | Congelar depois |
|------:|------|----------------|-----------------|
| 1 | `ε` (epsCents) | {1, 2, 3} | primeiro que passar gate §7 |
| 2 | `T_hedge_sec` | {4, 8, 12} | idem |
| 3 | `hedgeAskMax` | {0,38, 0,40, 0,42, 0,45} | idem |

`openShares`, `SL`, `avgSumMax` **não** entram na grade até §7 passar com defaults.

**Proibido:** grid conjunto 3D no dia de descoberta (mesmo erro do dia 29).

---

## 7. Gates pré-declarados (GO / NO-GO)

Janela limpa sugerida: **2026-05-01 → 2026-06-30** (nunca usada para escolher knobs).  
Descoberta (se precisar olhar): só para smoke de plumbing, não para promoção.  
Holdout congelado: **2026-07-01 → 2026-07-28** (exclui dia 29 de descoberta antiga).

### Etapa A — Lake replay honesto

Runner alvo (a criar): `pair-gate-replay.mjs`  
Modo: `latencyTicks≥1`, fee 0,07, size 5, labels canônicos.

| Critério | Limiar |
|----------|--------|
| PnL líquido | **&gt; 0** |
| Profit factor | **≥ 1,20** |
| IC95 bootstrap EV/evento (cluster por dia) | **&gt; 0** |
| Fração eventos com residual &gt; 0 | **≤ 15%** |
| Contribuição residual+abort no PnL | **&lt; 50%** do prêmio bruto dos pares |
| Opens | reportar n; se n &lt; 30 na limpa → **NO-GO por amostra** |

Se A falhar → **HOLD**. Não religar MULT. Afrouxar `ε` só se funil mostrar SKIP_C2 &gt; 99% **e** uma ablação pré-registrada com `ε=1` estiver no plano.

### Etapa B — Decomposição obrigatória

```text
PnL = prêmio_pares − fees − custo_abort − perda_residual
```

Se `fees + abort + residual ≥ prêmio_pares` → morta por I2, mesmo com WR alto.

### Etapa C — Shadow WS (Giovanna)

- Mesma política, **zero ordens**
- Paridade: sequência open/hedge/skip vs replay ±1 tick
- Book RTT documentado

### Etapa D — Micro-real

Só com A+B+C PASS, teto ≤ `maxEventNotional`, `max-events` baixo, aprovação explícita.  
**Não** usar `escada:shotandgo-micro --live` nem Redux3.

---

## 8. Funil de telemetria (obrigatório)

Contadores por evento / agregado:

```text
ticks_vivos
skip_c1_glitch | skip_c1_espera | skip_c1_tau
skip_c2_proj
open_attempt | open_miss_cap | open_fill
hedge_attempt | hedge_miss | hedge_fill
abort_timeout | abort_sl | residual_hold
done_paired
```

Sem funil, PnL positivo é ilegível.

---

## 9. Relação com máquinas anteriores

| Máquina | Status | Vs Pair-Gate V1 |
|---------|--------|-----------------|
| Shotandgo / Redux3 | research live alheia | **não portar** escada; reusar só C8 |
| Pair-Path V0 | research | Base de estados; V1 **aperta** C2 e **mata** residual passivo |
| Clip-Path V1 | HOLD | Clips profundos rejeitados; V1 = 1+1 ou abort |
| PTB-Path V1 | SUPERSEDED | Falsificada no histórico; V1 **não** depende de PTB leave |
| Compensation V1 | design | Espírito “nunca adicionar TOP” = C3; sem block maker |
| TSC | HOLD (outra família) | Direcional terminal ≠ complete-set; paralelo, não misturar |

---

## 10. Plano de implementação (lab)

Ordem estrita:

1. **Doc** este arquivo (contrato congelado) ✅
2. **Engine puro** — [`pair-gate-engine.mjs`](./pair-gate-engine.mjs) ✅
3. **Testes unitários** — [`pair-gate-engine.test.mjs`](./pair-gate-engine.test.mjs) ✅ (9/9)
4. **Ledger schema** — estender `operational-ledger.mjs` com kinds §4 C0
5. **Replay** — `pair-gate-replay.mjs` no lake depth-25, fee on, lat≥1
6. **Etapa A+B** na janela limpa com defaults §4
7. Só então knobs §6 e shadow

Não começar pelo Redux3. Não começar por live.

**Nota de calibração:** com `epsCents=2` + `bufferCents=1`, o open clássico
V0 `55¢+42¢` é **rejeitado** pelo gate I1 (fee-aware). Isso é intencional —
o path feliz exige hedge mais fundo (~39¢) ou `ε` menor na grade §6.

### Comandos

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node --test labs/sandbox/pair-path-v0/pair-gate-engine.test.mjs
# próximo:
# node labs/sandbox/pair-path-v0/pair-gate-replay.mjs `
#   --from=2026-05-01 --to=2026-06-30 `
#   --shares=5 --epsCents=2 --hedgeAskMax=0.42 --latencyTicks=1
```

---

## 11. Decisão binária

| Resultado Etapa A+B | Ação |
|---------------------|------|
| PASS | Shadow Giovanna (C); micro só com aprovação |
| FAIL por I1 (quase zero opens) | Complete-set seletivo **sem oferta** → HOLD família; não “consertar” com escada |
| FAIL por I2 (residual/abort come prêmio) | Apertar T_hedge/SL ou abortar mais cedo; **uma** ablação pré-registrada |
| FAIL por I3 (paridade fill) | Corrigir execução; não tocar knobs de edge |

### Resultado 2026-07-30 (mai–jun limpa)

Ver [`PAIR-GATE-V1-ETAPA-A.md`](./PAIR-GATE-V1-ETAPA-A.md).

- Default `hedgeAskMax=0.42`: **0 opens** (I1 vazio).
- Calibração `hedgeAskMax=0.38`: opens>0 mas **PnL −$1.379**, PF 0,35, IC95&lt;0, I2 falha.

**Default atual:** **HOLD** — expectancy refutada sob o contrato; sem shadow/micro.

---

## 12. Resumo em uma frase

Pair-Gate V1 = **só entra se o par já fecha na conta (C2), só carrega uma perna nua (C3), aborta barato se o hedge não vier (C6), e nunca escala tamanho (C5)** — higiene do Redux3 sem a tese da escada.
