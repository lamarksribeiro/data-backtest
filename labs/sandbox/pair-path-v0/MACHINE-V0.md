# Pair-Path V0 — máquina do zero (adaptada ao mercado)

**Status:** research · shadow/replay only · **proibido live** até gate micro  
**Host alvo:** Giovanna (~56 ms book RTT)  
**Evidência de mercado:** baliza series8 (8 eventos BTC 5m, 2026-07-28)

---

## 1. Por que não Phil / Escada full

| Herança | Problema medido | V0 |
|---|---|---|
| Grade 8×8 + re-arme | Path full → avgSum mediana **1,045** | **Máx 2 pernas** + EQ opcional |
| MULT / contagio | Lab: MULT piora cauda | **MULT = 1** |
| Fill no nível | cap0 só **50%** dos SUB | **taker_limit +1¢ ou miss** |
| Maker same-side re-arme | fill **~20%** | **Sem re-arme maker** |
| Simulador optimistic | edge fantasma | só modelo **honest** |

Tese que **fica**: inventário dual + complete-set se `avgSum < 1`.  
Tese que **sai**: “escada captura o path inteiro”.

---

## 2. Objetivo por evento

```text
maximizar:  PnL se equalizado ≈ sh × (1 − avgUp − avgDn) − fees
sujeito a:  residual final ~ 0  OU  pior caso limitado
             notional ≤ teto
             no máximo 1 open + 1 hedge + 1 eq
```

Não otimizar win rate de path. Otimizar **par barato ou não entrar**.

---

## 3. Estado

```text
mode: idle | opened | hedged | done | blocked
sideOpen: UP | DOWN | null
inv[UP], inv[DOWN]   # shares, cost
restingHedge: null | { side, limit, placedTau, placedTs }
blocks[]             # razões
fills[]
```

---

## 4. Regras (contrato)

### 4.1 Janela

| Param | Default | Motivo baliza |
|---|---:|---|
| `tauOpenMin` | 40 | fim é vacuum/gap ruim |
| `tauOpenMax` | 240 | início ruidoso; alinhado Phil ~280 cap |
| `tauHedgeMin` | 15 | não hedge inútil no settlement |
| `tauEqMin` | 8 | EQ late ok se barato |

### 4.2 Open (1ª perna) — única entrada direcional

Dispara **no máximo 1 vez**:

```text
mode == idle
AND tau ∈ [tauOpenMin, tauOpenMax]
AND ask_side ∈ [openAskLo, openAskHi]     # default 0.52–0.62 (favorito leve)
AND gap_from_trigger ≤ openCapCents/100  # default 1¢ (taker_limit)
AND (ask_other + ask_side) ∈ [0.95, 1.05]  # book complementar são
```

**Lado:** `chase` = lado com ask ≥ 0.55 e maior ask (favorito).  
**Size:** `openShares` fixo (default 10).  
**Exec:** fill @ min(ask, trigger+cap); senão **miss → mode stays idle** (não re-tenta o mesmo spike; espera próximo tick com regra de novo, mas `openAttempts` cap 3/evento).

Sem re-arme. Sem segundo open no evento se já houve fill.

### 4.3 Hedge (2ª perna) — só melhora o pior caso

```text
mode == opened
AND residual = shares_open − 0 no oposto
AND ask_opposite ≤ hedgeAskMax          # default 0.48
AND projected_avgSum < avgSumMax        # default 0.995 (buffer fee)
AND worstPnl_after > worstPnl_before    # obrigatório
AND tau ≥ tauHedgeMin
```

**Size hedge:** `min(openShares, floor(budget_left / ask_opp))` visando equalizar.  
**Exec v0:** taker_limit cap `hedgeCapCents` (default 1). Miss → tenta resting @ `ask_opp` por até `makerTimeoutSec` (default 30); se timeout, **aceita residual** (não persegue).

### 4.4 EQ opcional

```text
mode ∈ {opened, hedged}
AND residualShares ≥ 1
AND ask_underweight ≤ eqAskMax          # default 0.05
AND projected_avgSum < eqAvgSumMax      # default 0.99
AND tau ≥ tauEqMin
```

Uma tentativa. Fill taker no ask se ≤ eqAskMax.

### 4.5 Freios duros

| Freio | Default |
|---|---:|
| `maxEventNotional` | 25 |
| `maxOpenAttempts` | 3 |
| `maxHedgeAttempts` | 2 |
| `refuseAvgSum` | 0.995 |
| `mult` | 1 |
| `rearm` | off |
| `levels` | nenhum (sem grade 8×8) |

---

## 5. Settlement

```text
winner = lado com ask final ≥ 0.5 no último tick (proxy) 
       ou resolution se disponível
PnL = shares_winner − (cost_UP + cost_DOWN) − fees_est
fees_est = 0.07 * p * (1-p) * shares  por fill taker (crypto)
```

---

## 6. Gates de promoção

| Gate | Critério |
|---|---|
| Replay series8 | relatório v0 vs path-full (menos avgSum>1, menos notional) |
| Shadow live Giovanna | 10 eventos intents sem ordem |
| Micro-real | 10–20 eventos · size min · go se não for cauda tóxica |

**Proibido:** conta size de simulador; PC+VPN como host de execução.

---

## 7. Arquivos

| Path | Papel |
|---|---|
| `MACHINE-V0.md` | este contrato |
| `engine.mjs` | estado + regras puras |
| `replay-series.mjs` | joga ticks da baliza series8 |
| `presets/v0.json` | defaults |

---

## 8. Ablation + calibração pre size/fee

### 8.1 Ablation (8 variantes)
`tight-avgSum` venceu o risk gate (avgSumMax=0.98, hedge≤45¢).

### 8.2 Calibração em grade (480 configs)
- **Train:** baliza series8 (8 evt)  
- **Holdout:** shadow Giovanna tight-shadow (3 evt)  
- **Fixo:** openShares=10, feeRate=0.07  
- **Busca:** banda open, cap, avgSumMax, hedgeAskMax, janela τ  

**Escolhido:** `presets/calibrated-v0.json` (= `candidate-shadow.json`)

| Param | tight-avgSum | **calibrated-v0** |
|---|---:|---:|
| avgSumMax / eq | 0.98 | **0.97** |
| hedgeAskMax | 0.45 | **0.42** |
| open band / cap | 52–62 / +1¢ | igual |
| tau open | 40–240 | igual |

| Métrica | tight train | **calib train** | calib holdout |
|---|---:|---:|---:|
| PnL | +0.04 | **+0.74** | +0.02 |
| structuralNet | +0.03 | **+0.74** | +0.02 |
| worstMin | −0.14 | **−0.04** | −0.04 |
| avgSum med | 0.97 | **0.94** | 0.96 |
| done | 4/8 | 4/8 | 2/3 |

Achado central: **apertar avgSum 0.98→0.97** melhora o par (med 0.94) e o PnL no train; holdout continua flat/leve positivo sem piorar worst.  
cap+2 e bandas largas não entraram no topo. size/fee **ainda não** calibrados.

## 9. Size/fee calibration

Script: `calibrate-size-fee.mjs` · train series8 + holdout calib-shadow.

| Achado | |
|---|---|
| fee=0 | só bound “se ambos maker” — **não** é candidato live |
| fee 0.07 full taker | edge estrutural ~metade vai em fee |
| size 10→20 | PnL ~escala; ROC similar se par bom |
| **avgSumMax 0.96 + size 20** | melhor holdout realista (fee 0.07) |

**Preset live:** `presets/size-fee-v0.json`  
`openShares=20`, `feeRate=0.07`, `avgSumMax=0.96`, hedge≤42¢, banda 52–62, cap+1

| | baseline sh10/fee0.07 | **size-fee-v0** |
|---|---:|---:|
| train PnL | +0.74 | **+1.89** |
| hold PnL | +0.12 | **+1.05** |
| hold ROC | 0.6% | **2.8%** |
| worst hold | −0.04 | **0** |

Asimetria residual / size dinâmico por evento = **fase seguinte de mecânica**, não misturar com este grid.

## 10. Shadow WebSocket

Script: `shadow-live-ws.mjs` · dep `ws` · Market WS + seed REST + heartbeat 100ms.

```text
node shadow-live-ws.mjs --events 3 --full-event --preset presets/size-fee-v0.json --heartbeat-ms 100
```

Giovanna: container `pair-path-shadow-ws`, log `/tmp/pair-path-v0/sizefee-ws.log`.

Ainda **sem ordens** — só book em tempo real. Ordens FOK/limit = fase seguinte (data-robot executor).

## 11. Order path (Giovanna)

Medido 2026-07-28 no `data-robot-engine-btc` (ARMED=0), postOnly 1¢ size5, 3× create+getOpen+cancel:

| | cold | warm p50 |
|---|---:|---:|
| ping CLOB | 99 | **67** |
| create | 766 | **144** |
| getOpen | 125 | **116** |
| cancel | 134 | **131** |
| **total** | 1025 | **384** |

Todos cancelados, visíveis em open orders, sem fill. Engine **parada** após o teste.  
Artefato: `.tmp/pair-path-v0-order-path/latency-giovanna-pairpath.json`

Gate path ordem: **PASS** (warm total ~380 ms).

## 12. Cap A/B offline (2026-07-28)

14 eventos (series8 + 2 shadows REST). Mesma mecânica size-fee, só `openCapCents`:

| cap | traded | pnl | OPEN_MISS blocks | worst |
|---:|---:|---:|---:|---:|
| +1¢ | 8/14 | +2.19 | 12 | 0 |
| **+2¢** | **10/14** | +2.11 | **3** | 0 |
| +3¢ | 10/14 | +2.11 | 3 | 0 |

**cap+2** desbloqueia 2 eventos que cap1 skipava; PnL ~igual; cap3 não adiciona.  
Dry live em teste com `--open-cap-cents=2`.

## 13. Micro live #1 (2026-07-28)

`mode=LIVE` size5 cap+2 · evento `…22600` · **idle 0 fills · invested $0**  
Book foi one-way (~0.07/0.94); **nenhuma ordem enviada**. Path CLOB ok; seletividade ok; n=1 sem trade.

Dry cap2 anterior **teve** open+hedge simulado (avgSum 0.95).

## 14. Micro live #2 (2026-07-28)

size5 cap+2 · max-events=3 · min-tau=200 · **FOK**

| Evento | Resultado |
|---|---|
| 1/3 | idle · one-way · 0 ordens |
| 2/3 | skip `tau_low` |
| 3/3 | FOK UP@55×5 → **killed** (`couldn't be fully filled`) · depois OPEN_MISS_CAP×2 · invested $0 |

Conta acionada 1×; **0 shares**. Usuário pediu cancelar e alterar execução.

## 15. Próximo / feed

1. ~~FOK~~ → **GTC + settle** ✓ (live #3: 1 trade real avgSum 0.96)  
2. **clobFeed stale heal** (2026-07-28): bug `ws=true` bloqueava REST reseed → book congelava  
   - REST reseed se lag ≥ 4s **mesmo connected**  
   - force-reconnect WS se lag ≥ 12s (cooldown 5s), padrão rtds/resilientWs  
   - micro-live: feed **persistente** na série, poll **50ms**, gate `maxBookAgeMs=2500`, REST refresh 1s se stale  
3. Micro live #4 size10: 0 fills (MISS_CAP + WS stale) — re-testar após heal  
4. Handoff: `docs/labs/pair-path-v0-sessao-019fa6ab.md`






