# 🥇 Estratégia Definitiva BTC 5m — Golden Goose V2 (cap20/ds25)

**Data**: 05/08/2026 · **Status**: RESEARCH / SHADOW-READY (herda o protocolo da [Estratégia Mestra 04/08](../../../data-robot/docs/ESTRATEGIA-MESTRA-BTC5M-2026-08-04.md))
**Base de evidência**: 100 dias de lake (23/04–31/07), 24.870 eventos, ~40 variantes de lab auditadas, catálogo de padrões auditado por repricing, forense live e todo o histórico de estratégias dos labs.

---

## 1. TL;DR — a estratégia

Um único ataque: **lead da Binance → entrada taker na Polymarket antes do reprice → saída maker ladder**. É a única classe de estratégia que sobreviveu a todas as auditorias honestas (repricing, fill realista, holdout, forense live). Tudo o mais que já testamos ou é filtro, ou é linha satélite pequena, ou está no cemitério (§6).

A novidade desta versão: o sweep de hiperparâmetros provou que **`impulseCap=20` + `rescueStop=0.25`** domina o baseline GO (`cap12/ds15`) em todos os eixos de risco, e a validação de 05/08 (novas runs) provou que isso se mantém com o sizing live (`sharesCap`):

| Config ($5/trade, sharesCap@0.50, 92d) | PnL | WR | PF | MaxDD | Trades | rescue_stop |
|---|---:|---:|---:|---:|---:|---:|
| Golden V1 (cap12/ds25) — `aud-golden-b5-ds25` | $20.077 | 76,8% | 3,66 | $32,22 | 53.181 | 3.375 |
| **Golden V2 (cap20/ds25)** — `aud-golden-v2-c20-b5-ds25` | **$20.095** | **80,4%** | **4,71** | **$14,26** | 45.906 | **2.561** |
| **Golden V2 escala $10** — `aud-golden-v2-c20-b10-ds25` | **$38.631** | 80,2% | 4,63 | $28,51 | 44.471 | 2.510 |

Mesmo PnL, **−56% de drawdown**, −24% de disasters, −14% de trades (menos fees, menos exposição), 94,1% de saída maker. Consistência mensal: mai $6.979 / jun $6.942 / jul $6.175 (b5), win rate 79,5–82,2% em todos os meses.

> [!IMPORTANT]
> Esses números usam o proxy de fill maker `bid ≥ limit` (otimista: sem fila, sem partial) e grain Binance 1s. São **teto de replay**, não expectativa live. Por isso o protocolo de fases (§5) permanece obrigatório.

---

## 2. Por que este é o caminho (síntese de toda a evidência)

1. **O sinal direcional existe e é forte.** Catálogo minerado (27.115 candles, holdout cego): impulso spot 15–60s prediz o fechamento da vela com 83–89% OOS nos padrões de N grande (N-1 Acumulação Silenciosa 89,2% N=158; G-3 Ensemble DOWN 88,8% N=80; S-4/S-5 ~84%). Confluência ETH→BTC agrega. Streaks, RSI isolado e imbalance sem spot = moeda (50–54%).
2. **O book precifica em segundos — taker tardio não captura nada.** Auditoria de repricing 05/08: com ask real no instante do sinal, taker em t=60s dá PF 1,02 (breakeven) e em t=30s dá prejuízo (PF 0,92). O ask médio em t=60s já é $0,83. Toda a família taker mid/late (TFC/MIDAS/QEM como executores standalone) opera contra esse muro.
3. **Maker otimista sem lead também morre.** Hopper 3: +$4,8k otimista → −$5,0k honesto. Escada Dupla: +$38,8k otimista → −$8,5k honesto. Ter fila do lado certo só funciona se há informação (lead) na entrada.
4. **A única combinação vencedora auditada**: entrar taker cedo (τ 20–280s) apenas quando a Binance moveu ≥2,5σ em 2s **e o mid da Polymarket ainda não reagiu** (`staleMid ≤ 0.03`), sair maker (+8/+14¢) com defesa escalonada. 92 dias de replay, PF 3–4,7 conforme config, edge estável nos 3 meses.
5. **A defesa é parte do ataque.** PnL por saída (Golden V2 b5): `ladder_full` +$22.600 (25.518×), `rescue_full` +$2.554, `rescue_stop` −$4.975 (2.561×). O lucro líquido É a diferença entre a colheita maker e o custo dos desastres — qualquer relaxamento da defesa (ds00, sem cap, sem pre-dump) já provou quebrar no live ou virar paper-only.

---

## 3. Especificação do motor (Golden Goose V2)

Motor: `data-robot/scripts/binance-lead-scalp/scalp-engine.js` — `VARIANT_E_GOLDEN` **já com** `impulseCap=20` e `rescueStop=0.25` (paridade lab↔engine em 05/08).

### Sinal e gates de entrada
| Item | Valor | Fonte da evidência |
|---|---|---|
| Lead | `BTC[t] − BTC[t−2s]` (WS Binance) | GOLDEN-GOOSE.md |
| Limiar | `clamp(2.5σ_300s, $5, $20)`, fallback $8 | sweep `aud-cap*`/`h-c20*` |
| τ restante | 20–280s (não subir minTau: −8,8% PnL) | ablation minTau |
| Ask | 0,15–0,70 · spread ≤ 0,04 | baseline GO |
| Mid não-stale | Δmid do lado ≤ 0,03 em 2s | núcleo do edge (anti-reprice) |
| Liquidez | askSz ≥ 0,75× shares · min 5 shares | paridade CLOB |
| Ritmo | cooldown 3s · máx 5 trades/evento | baseline GO |

### Sizing
`shares = min(budget/ask, floor(budget/0.50))` (**sharesCap@0.50** — obrigatório live; a assimetria do ask barato foi a causa do −$1,20 no forense micro).

### Saída (defesa escalonada)
1. **Ladder maker** 50/50 em `entry+0.08` e `entry+0.14` (consolida 1 nível se half < 5 shares).
2. **Soft-stop**: `bid ≤ entry−0.05` ou hold ≥ 20s → cancela ladder, rescue maker em `entry+0.01`.
3. **Disaster**: `bid ≤ entry−0.25` → **dump taker imediato** (pre-dump; nunca postar rescue após gap).
4. **EOD**: flatten residual no bid.
5. Sem reentrada no evento após `rescue_stop`.

### O que NÃO mexer sem lab novo
Lead 2s · 2,5σ · ladder +8/+14¢ · rescue +1¢ · minTau 20 · sharesCap@0.50 · pre-dump imediato. Cada um desses tem ablation ou forense comprovando o custo de mudar.

---

## 4. Linhas satélites (opcionais, capital pequeno, nunca no mesmo executor)

| Linha | Evidência | Papel |
|---|---|---|
| **MIDAS Quantum V1** (carry terminal, budget $2) | PF 1,72, DD $10,42, 26/26 dias positivos (jul) | Shadow separado; único taker terminal que sobreviveu com sizing anti-assimetria. Não escalar sem shadow ≥30d |
| **Mispricing L2** (spot ±6bps aos 30s, ask <0,56) | PF 1,37 depth-aware, mas **N=56/94d, OOS N=10** | Não é estratégia — no máximo gatilho oportunista dentro do engine, se o custo de implementação for ~zero |
| **SBRI Tight V1** | +$574 holdout 43d, PF 1,68 | Candidato a shadow de baixa prioridade |
| Padrões do catálogo (N-1, G-3, S-4…) | 83–89% direcional OOS | Reservatório de **filtros/confirmações** para testes A/B no lab do scalp — nunca executores taker |

---

## 5. Protocolo de promoção (inalterado — Mestra 04/08, revisão V2 05/08)

1. **Lab → engine parity** da config V2 (cap20/ds25) — **feito 05/08**: `VARIANT_E_GOLDEN` no `scalp-engine.js` + testes unitários verdes.
2. **OOS congelado**: validar V2 em dados novos (agosto) antes de qualquer dry. **Feito 05/08** (01–04/08): WR 79,8%, PF 5,21, PnL +$584, DD $5,60 — alinhado ao IS.
3. **Dry/shadow ≥ 100 eventos / 7 dias** na Giovanna (latência real): **iniciado 05/08** (48 eventos, fill=cruel, budget=$5) no sidecar `pair-path-micro`. Log: `/tmp/scalp-e-golden-v2-dry.log`. Após conclusão, estender até ≥100 eventos. Gate: PF líquido ≥ 1,20 com IC.
4. **Micro live só com autorização explícita**: envelope $5/trade · 10 shares · $40 notional/sessão · −$8 loss-stop · 8 eventos.
5. **Escala $10** apenas após micro com ≥ 2 semanas e métricas dentro do envelope do lab (WR ≥ 75%, rescue_stop ≤ 6% dos trades).

**Kill-switches**: PF live < 1,0 em 200 trades · 3 sessões seguidas no loss-stop · taxa de fill maker < 60% da premissa do lab · qualquer orphan não reconciliado.

---

## 6. Cemitério (não reabrir sem evidência nova)

| Ideia | Veredito |
|---|---|
| Taker mid/late no favorito (TFC/MIDAS puro como executor) | PF ~1,0–1,3 antes de latência; repricing come o edge |
| Complete-set / pair-path / SHOTANDGO | −$42,8k / EV −$0,05/sh / PF 0,70 |
| Hopper 3–4, Escada Dupla | Positivos só com maker otimista; honesto = negativo |
| `rescueStop=0` (segurar até EOD) | PF 19,7 é paper-only; live = risco de −100% notional |
| Sizing sem cap em ask barato | Forense live: 1 loss engoliu 4× o win |
| Ladder curta +1/+2/+3¢ | Lab negativo/zero |
| Streaks, RSI extremo, imbalance sem spot | 50–54% = moeda |
| Backtests com ask congelado de t=0 | +1.186% fictício; auditado e invalidado em 05/08 |
| Motor Quântico/ensemble como executor taker 30–60s | PF 1,02 com ask real |

---

## 7. Artefatos desta versão

### Lab in-sample (mai–jul)
- `labs/sandbox/binance-lead-scalp/reports/scalp-2026-05-01_2026-07-31_maker-ladder-0p08-0p14_aud-golden-v2-c20-b5-ds25.{json,md}`
- `labs/sandbox/binance-lead-scalp/reports/scalp-2026-05-01_2026-07-31_maker-ladder-0p08-0p14_aud-golden-v2-c20-b10-ds25.{json,md}`

### OOS agosto (01–04/08/2026) — **aprovado 05/08**
| Métrica | V2 b5 OOS 4d | V2 b5 IS 92d |
|---|---:|---:|
| Trades | 1.245 | 45.906 |
| Win Rate | **79,8%** | 80,4% |
| PnL | **+$583,64** (~$146/dia) | +$20.095 |
| Profit Factor | **5,21** | 4,71 |
| Max DD | **$5,60** | $14,26 |
| Maker exit % | 94,6% | 94,1% |

Relatório: `labs/sandbox/binance-lead-scalp/reports/scalp-2026-08-01_2026-08-04_maker-ladder-0p08-0p14_oos-aug-golden-v2-c20-b5-ds25.{json,md}`

### Dry Giovanna (em curso)
- Sidecar `pair-path-micro`, fill=`cruel`, budget=$5, meta 48 eventos
- Log: `/tmp/scalp-e-golden-v2-dry.log` · boot: `labs/sandbox/binance-lead-scalp/start-dry-bg.sh`

### Comando de reprodução lab

```powershell
node --max-old-space-size=8192 labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs `
  --from 2026-05-01 --to 2026-07-31 --impulse-usd 8 --stale-mid 0.03 --timeout 20 `
  --impulse-vol-mult 2.5 --impulse-floor 5 --impulse-cap 20 --rescue --rescue-stop 0.25 `
  --exit-mode maker-ladder --ladder 0.08,0.14 --budget 5 --sizing sharesCap --shares-cap-ask 0.5 `
  --tag aud-golden-v2-c20-b5-ds25
```
