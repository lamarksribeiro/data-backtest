# Doggy Momentum Pair-Ladder — documentação canônica

**Status:** engenharia reversa **descritiva completa** (2026-07-26) · lab research · **proibido conta real / promoção Studio**  
**Alvo:** Polymarket BTC Up/Down **5 minutos**  
**Wallet observada:** DoggyStyIe `0x0484e64092ba4108c2786b61e6fc052d3bf41b1a` (Diamond)  
**Lab:** `labs/strategies/carry/pair-ladder-complete-set-v1/`  
**Preset research:** `presets/btc-doggy-parity-momo.json`  
**RE detalhada:** [`pair-ladder-complete-set-v1.md`](pair-ladder-complete-set-v1.md) (Etapas 1–17)  
**Canvas status:** `doggy-re-status.canvas.tsx`

---

## 0. O que é (e o que não é)

**É:** um **momentum-taker direcional com hedge estrutural** e scoop late do lado moribundo, liquidado no redeem, com rebate Diamond de 44% das fees taker crypto.

**Não é:** arbitragem atômica de complete-set num único tick. O locked edge (`q·(1−avgSum)`) existe, mas o lucro material na amostra veio do **tilt residual** (fills mid a favor do movimento) + rebate.

```text
open ~50¢  →  hedge async  →  chase MOMO mid  →  vacuum dying  →  redeem
                 (container)     (motor)           (equaliza)
```

---

## 1. Passo a passo operacional

### Passo 1 — Abrir (seed)

| Item | Valor RE |
|---|---|
| Janela | primeiros **≤30s** do evento (med ~4s) |
| Preço | ask **45–55¢** (p90 ~58¢) |
| Clip | **50** shares |
| Lado | o que estiver na banda (não precisa “adivinhar”) |
| Modo | **taker** (fee crypto + rebate) |

Se não houver ask na banda até `maxSecToOpen`, **não entra**.

### Passo 2 — Hedge assíncrono

| Item | Valor RE |
|---|---|
| Lado | **oposto** ao seed |
| Clip | **~100** shares |
| Delay | med **~18s** (p10 ~2s); **não** same-tick (~8% only) |
| Preferência | ask oposto **≤50¢** quando possível |
| Alvo par | `avgUp + avgDown` ≈ **0,99–1,00** no open+hedge |

Sem dual inventory, **não** começa o build (lab: `minSecToHedge` + bloqueio de rebalance pré-dual).

### Passo 3 — Build = chase MOMO (motor de lucro)

A cada tick pós-dual, preferir o lado cujo **ask subiu ≥2¢ nos últimos 15s**, na banda **20–70¢**:

| Item | Valor |
|---|---|
| Sinal | `dAsk15 = ask_agora − ask_(t−15s) ≥ +0,02` |
| Banda | ask ∈ **[0,20 ; 0,70]** |
| Clip | **100** shares |
| Preferência | underweight / flat com residual ≤ cap |
| Proibido (lab) | mid-band FADE/REV como motor (`momoBlockFade`) |

**Evidência lake (fills 20–70¢):** MOMO EV **+5,2¢/share** · FADE **−3,5¢** · baseline mercado MOMO **−1,3¢** (a seleção Doggy é melhor que o sinal 1Hz público).

**Evidência live (3 sessões, edge $ vs ask do journal):**

| Fase | S1 | S2 | S3 |
|---|---:|---:|---:|
| build_momo | +$98 | +$115 | **+$300** |
| build_fade | +$20 | −$130 | **−$193** |

### Passo 4 — Container / residual (custo aceito)

Quando underweight e o ask **não** está em MOMO:

| Permitir | Bloquear |
|---|---|
| melhora `avgSum` | FADE mid **sem** melhora de avg |
| ou cushion (`avgSum≤0,95`) + balance | ask mid/rich ~60–70¢ só para “igualar” |
| ou ask **≤40¢** (cheap) + melhora/cushion | overweight (quase nunca) |

Live S2/S3: bucket **skip** (FADE residual sem melhora avg) = **−$88 / −$163**. Doggy às vezes paga; o lab research **não deve** copiar cego (`momoBlockFade`).

### Passo 5 — Late vacuum (dying side)

| Item | Valor RE / live |
|---|---|
| Início | ~**150–180s** no evento |
| Preço | ask **≤15–20¢** (med live ~7–12¢) |
| Clip | **~50** |
| Efeito | reduz residual; S2 residual 150→0 em **89%** dos eventos com vacuum |
| Share | **~8–14%** dos fills live |

Soft lock (`avgSum≤0,95`, balance alto) **não** mata vacuum nem chase under — Doggy **continua** após lock. **Sem hard stop** quando `avgSum≥1`.

### Passo 6 — Redeem

- **Zero SELL** mid-evento  
- **Zero MERGE** operacional  
- Só **REDEEM** do outcome vencedor  
- Fee taker crypto − **rebate Diamond 44%**

---

## 2. Configuração lab (melhor aproximação 2 Hz)

Arquivo: [`btc-doggy-parity-momo.json`](../../../labs/strategies/carry/pair-ladder-complete-set-v1/presets/btc-doggy-parity-momo.json)

| Param | Valor | Papel |
|---|---:|---|
| `fillMode` | `taker` | execução honesta |
| `legChoice` | `chase_momo` | motor |
| `momoBlockFade` | `true` | bloqueia FADE mid |
| `momoLookbackSec` | `15` | janela dAsk |
| `momoMinRise` | `0.02` | +2¢ |
| `momoMinAsk` / `momoMaxAsk` | `0.20` / `0.70` | banda |
| `openShares` / `hedgeShares` / `clipShares` | `50` / `100` / `100` | ladder |
| `openMinAsk` / `openMaxAsk` | `0.45` / `0.58` | open band |
| `maxSecToOpen` | `30` | |
| `minSecToHedge` | `5` | anti same-tick |
| `hedgePreferAsk` | `0.50` | |
| `forbidOverweight` | `true` | |
| `softLockAllowBuild` / `Vacuum` | `true` | |
| `stopAvgSum` / `stopMinBalance` | `0.95` / `0.90` | soft lock |
| `lateStartSec` / `lateMaxAsk` | `180` / `0.15` | vacuum |
| `maxEventNotional` | `350` | size Doggy-like |
| `maxSharesPerSide` | `500` | |
| `maxFillsPerEvent` | `12` | |
| `slippageCents` | `-1` | proxy fill≤ask (regime-dependent) |
| `applyPolymarketFees` | `true` + crypto | |
| rebate (pós-process) | **0.44** Diamond | |

Fees: usar `takerRebateRate: 0.44` — **não** overlay 0.76.

---

## 3. Desempenho

### 3.1 Doggy (referência)

| Métrica | Valor |
|---|---:|
| All-time (leaderboard) | ~**+$192k** |
| Cohort both 24–25/07 (n≈291 overlap lab) | **+$83** Σ |
| Decomposição settled (amostra RE) | locked ~+$1.7k · residual tilt ~+$2.2k · fees −$4.6k · rebate +$2.0k |

### 3.2 Lab no lake 2 Hz (cohort both 24–25/07)

| Variante | both PnL | vs Doggy +$83 |
|---|---:|---:|
| `min_avg_sum` (baseline) | −$1.746 | gap enorme |
| `chase_momo` | −$1.501 | +$245 vs baseline |
| `chase_momo` + `momoBlockFade` + vac unlock | **−$1.276** | melhor lab; **ainda −$1.4k** vs Doggy |

**Conclusão lab:** direção correta (`chase_momo` + bloquear FADE mid), **paridade impossível** no Parquet 2 Hz (seleção/timing intra-segundo + vacuum não disparam).

### 3.3 Live shadow CLOB (3× sessões, só-leitura)

| | S1 45m | S2 60m | S3 60m | Agregado |
|---|---:|---:|---:|---:|
| Fills matched | 50 | 284 | 271 | **607** |
| Book ticks | 7.9k | 13.2k | 13.7k | **35k** |
| med fill−ask | −1,8¢ | 0¢ | −1¢ | ~−1¢ **instável** |
| momoShare | 52% | 43% | 48% | **~48%** |
| vacuumShare | 12% | 10% | 8% | **~10%** |
| build_momo $ vs ask | +98 | +115 | +300 | **sempre +** |
| build_fade $ vs ask | +20 | −130 | −193 | **S2/S3 −** |

Artefatos: `.tmp/pair-ladder-re/live-observer/` · `doggy-shadow-lab-aggregate.json`

---

## 4. Checklist de implementação (se retomar lab)

1. Seed 50 @ 45–55¢ ≤30s · taker  
2. Esperar ≥5s · hedge 100 no oposto  
3. Build só MOMO mid (`dAsk15≥2¢`, 20–70¢)  
4. Residual FADE só se melhora avg **ou** ask≤40¢ com cushion  
5. Após ~180s: vacuum ≤15¢ no underweight  
6. Soft lock não encerra · redeem no fim  
7. Fees crypto + rebate 44%  
8. **Não** promover / **não** conta real até shadow multi-dia com journal tick

---

## 5. Honestidade

| Afirmação | Status |
|---|---|
| Path e motor entendidos | **sim** |
| Config research definida | **sim** |
| Lab ≈ PnL Doggy no lake | **não** (−$1.3k vs +$83) |
| Fill −1¢ sistemático | **não** (regime-dependent) |
| Spot-lead gate | **descartado** |
| Subir Hz no Brutus resolve | **não** (precisa seleção + vacuum + tape) |

**Veredito:** documentação operacional **completa** para research. Estratégia **não** está pronta para dinheiro real.
