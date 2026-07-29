# Pair-Path V0 — achados da sessão Grok `019fa6ab`

**Sessão Grok CLI:** `019fa6ab-1896-7930-a502-b99b0e416854`  
**CWD:** `data-backtest`  
**Período:** 2026-07-28 (~00:00–07:30 UTC)  
**Título gerado:** Escada Dupla Shotandgo Shadow Orders Testing  
**Lab:** `labs/sandbox/pair-path-v0/`  
**Harness live:** `data-robot/scripts/pair-path/micro-live.js` (Giovanna)

> Documento de handoff. Continuar daqui — **não** reabrir baliza series8 nem Escada Studio optimistic.

---

## 1. Objetivo da sessão

Testar passo a passo a lógica de **carry dual** (Escada Dupla / Shotandgo) em ambiente real:

1. entender mecânica  
2. balizar o mercado (latência + física do book)  
3. construir máquina **do zero** adaptada ao mercado (não Phil full)  
4. shadow → WS → path de ordem → micro-real  

---

## 2. Decisões estruturais (não reabrir)

| Decisão | Motivo |
|---|---|
| **Não** promover Escada Dupla `ascent_hedge` Studio | Lab honesto matou; fill optimistic ≠ real |
| **Não** copiar Shotandgo full (grade + MULT + re-arme) | Path full → avgSum mediana **> 1**; maker re-arme ~20% |
| Host de execução = **Giovanna** | Book RTT ~56 ms; PC+VPN 4–11× pior |
| data-robot **parado** (MIDAS/TFC off); só engine BTC efêmera p/ env | Evitar contaminação / banda |
| SSH + Docker efêmero > Coolify neste momento | Velocidade de iteração |
| Máquina nova: **Pair-Path V0** (máx 2 pernas) | Par barato ou não entrar |

---

## 3. O que foi construído

| Artefato | Papel |
|---|---|
| `MACHINE-V0.md` | Contrato mecânico |
| `engine.mjs` + `replay-series.mjs` | Regras puras + replay baliza |
| `ablation-series.mjs` | 8 variantes × series8 |
| `calibrate.mjs` / `calibrate-size-fee.mjs` | Grades de calibração |
| `shadow-live.mjs` / `shadow-live-ws.mjs` | Shadow REST / Market WS |
| `presets/*.json` | v0 → tight → calibrated → **size-fee-v0** |
| `MICRO-REAL.md` / `ORDER-PATH.md` | Runbook micro + latência |
| `data-robot/scripts/pair-path/micro-live.js` | Dry/live harness |

---

## 4. Baliza de mercado (series8 · Giovanna)

8 eventos BTC Up/Down 5m capturados.

| Métrica | Valor |
|---|---|
| Book RTT p50 | **~56 ms** |
| Taker no nível (cap0) | **50%** dos SUB |
| Taker cap+1¢ | **67,5%** |
| Taker cap+2¢ | **75,8%** |
| Maker DESC same-side | **~20%** fill |
| Hypo path full avgSum | mediana **1,045** (> $1) |

**Implicações mecânicas:**

1. Não assumir fill no nível → `taker_limit + cap` ou miss  
2. Não contar com re-arme maker  
3. Escada full path **não** é free lunch  
4. EQ barata é seletiva, não automática  

---

## 5. Máquina Pair-Path V0 (contrato resumido)

```text
idle → OPEN (1× chase 52–62¢, trigger 55, cap) → HEDGE (oposto ≤ hedgeMax, avgSum ok) → done
MULT=1 · rearm=off · sem grade 8×8 · residual aceito se hedge falhar
```

### Evolução de presets

| Preset | Destaque |
|---|---|
| `tight-avgSum` | Ablation: melhor risk gate (avgSumMax 0.98, hedge≤45) |
| `calibrated-v0` | Grade 480 configs: avgSumMax **0.97**, hedge≤**42** |
| **`size-fee-v0`** | sh20, fee 0.07, avgSumMax **0.96** — candidato shadow |

### Cap A/B offline (14 evt)

| cap | traded | PnL | OPEN_MISS |
|---:|---:|---:|---:|
| +1¢ | 8/14 | +2.19 | 12 |
| **+2¢** | **10/14** | +2.11 | **3** |
| +3¢ | 10/14 | +2.11 | 3 |

Micro passou a usar **cap +2¢** (mais opens, PnL ~igual).

---

## 6. Resultados das simulações

### Replay series8 (fee 0.07)

| Versão | Traded | PnL | avgSum med | Worst |
|---|---:|---:|---:|---:|
| Path full | quase tudo | avgSum ~1.05 | ruim | — |
| V0 baseline | 4/8 | −0.36 | 0.97 | −0.14 |
| tight/calib | 4/8 | **+0.74** | **0.94** | −0.04 |
| size-fee-v0 | 4/8 | **+1.89** | ~0.94 | 0 |

### Shadow REST Giovanna (3 evt)

| Preset | Traded | PnL |
|---|---:|---:|
| tight | 2/3 | +$0.02 |
| calibrated | 2/3 | +$0.12 |

### Shadow WS + size-fee-v0 (3 evt)

| | |
|---|---|
| Traded | **1/3** |
| PnL | **+$0.11** |
| Trade | UP@55×20 + DOWN@41×20 · avgSum **0.96** |
| Skips | one-way + 3× OPEN_MISS_CAP |

### Order path (latência real, postOnly 1¢ cancelada)

| | warm p50 |
|---|---:|
| create+getOpen+cancel | **~384 ms** |
| Gate | **PASS** |

### Scorecard honesto (sims)

| Dimensão | Status |
|---|---|
| Risco / cauda | Bom (stuck 0, worst controlado) |
| Qualidade do par | Bom (avgSum 0.94–0.96 quando equaliza) |
| Seletividade | Forte (muitos skips) |
| PnL simulado | Leve + |
| Expectancy estatística | **Não provada** (n pequeno) |
| Fill open/hedge real | **Bloqueado no FOK** (ver §7) |

**Veredito sims:** V0 está no caminho certo vs Phil/Escada (prioriza complete-set e freios). Ainda **não** prova expectancy nem fill de inventário real.

---

## 7. Micro-real — onde paramos

### Dry

- Wiring OK (WS + regras no container `data-robot-engine-btc`)  
- Dry cap2: open+hedge **simulados** com avgSum ~0.95  

### Micro live #1

| | |
|---|---|
| Params | LIVE · size **5** · cap **+2¢** · 1 evento |
| Resultado | **idle · 0 ordens · $0** |
| Motivo | path one-way (book ~0.07/0.94) — seletividade correta |

### Micro live #2 (último da sessão)

| | |
|---|---|
| Params | LIVE · size 5 · cap +2¢ · max 3 eventos · min-tau 200 |
| Signer | `0x5324…4CbB` |
| Evento 1 | idle · 0 fills · one-way |
| Evento 2 | skip `tau_low` (timing entre slots) |
| Evento 3 | **1 FOK real** UP@55×5 → **killed** |

Erro CLOB:

```text
order couldn't be fully filled. FOK orders are fully filled or killed.
```

Depois: mais 2× `OPEN_MISS_CAP`; invested **$0**; shares **0**.

**Leitura:** a conta **foi acionada** (path CLOB ok). Freio atual = **liquidez FOK** (e seletividade/cap), não só “não tentou”.

Última mensagem do usuário na sessão:

> cancele e vamos alterar algo, pois não entra ordem desse jeito

Processo micro-live **já terminou** sozinho (~07:29 UTC). Engine BTC ainda pode estar up — parar quando não houver teste ativo.

---

## 8. Próximo passo (continuidade)

### Alteração imediata (bloqueante) — **feita**

Troca open/hedge de **FOK** → **GTC marketable** com:

1. `createAndPostOrder(..., OrderType.GTC, postOnly=false)`  
2. poll `getOrder` ~1.2 s (`--settle-ms`)  
3. `cancelOrder` do remainder se não filled  
4. reconciliar `size_matched`  

CLI: `--order-type=GTC|FAK|FOK` (default **GTC**).

### Depois do patch

1. Dry 1 evento (regressão harness)  
2. Micro live **#3**: size 5 · cap +2 · GTC settle · 1–3 eventos · min-tau alto  
3. Critério: `OPEN fill` com `dry=false` e `size_matched > 0`  
4. Só então discutir size 10–20 / assimetria  

### Ideias estacionadas (não misturar agora)

- Size dinâmico / assimetria residual  
- App Coolify dedicado para baliza  
- Reintroduzir MULT  
- Escada Studio de novo  

---

## 9. Comandos úteis

```powershell
# Export da sessão Grok
grok export 019fa6ab-1896-7930-a502-b99b0e416854

# Replay local (data-backtest)
node labs/sandbox/pair-path-v0/replay-series.mjs --preset presets/size-fee-v0.json

# Shadow WS (Giovanna, zero ordens)
# ver shadow-live-ws.mjs + poll-status-ws.sh

# Micro dry / live (data-robot, no container engine BTC)
node scripts/pair-path/micro-live.js --open-shares=5 --open-cap-cents=2 --max-events=1
node scripts/pair-path/micro-live.js --live --open-shares=5 --open-cap-cents=2 --max-events=1 --min-tau-start=200
```

**SSH Giovanna:** não usar `docker ps --format '{{.Names}}'` no PowerShell (exit `1073741845`).

---

## 10. Estado ao handoff (2026-07-28 ~07:37 UTC)

| Item | Estado |
|---|---|
| Micro-live process | **morto** (série #2 done) |
| Posição / invested | **$0** |
| Patch FOK→GTC | **feito** |
| clobFeed zombie (`ws=true` sem tick) | **corrigido** (REST+force-reconnect) |
| micro-live feed | persistente · poll 50ms · maxBookAge 2.5s |
| Engine BTC Coolify | stop se ociosa |
| Expectancy | inconclusiva |
| Candidato mecânico | `size-fee-v0` + cap+2 no micro |

---

## 11. Uma frase

Construímos uma Pair-Path V0 seletiva e com par barato nas sims; no live mínimo o path CLOB funciona, mas **FOK no nível mata a ordem por liquidez** — o próximo passo é GTC com settle curto e repetir o micro size 5.
