# Early Favorite Rush V0 — pesquisa multi-asset

> ## ⛔ REJEITADA — 2026-08-05
> **Todos os números deste documento são inválidos.** A função `firstCross()` de
> `scratch/multi-asset-early-fav-rush.mjs` varre o evento de trás para frente e
> devolve o **último** cruzamento para baixo de 85¢ — o que só se sabe depois que o
> evento acabou. É lookahead na seleção da entrada.
>
> Com a entrada honesta o sinal **inverte em 7/7 ativos**: +$19.270 → **−$24.639**.
> Ver `docs/estrategias/rejeitadas/early-favorite-rush-v0-lookahead.md`.
>
> Herdam o mesmo artefato: `-optimize`, `-disaster-exit`, `-take-profit`,
> `-reward-risk-exit`, `-corr` e os `xrp-early-fav-*`.

**Status:** ~~pesquisa / lab scratch (não portado ao Studio)~~ **REJEITADA (lookahead)**  
**Janela canônica XRP:** 2026-05-24 → 2026-08-04 (73d)  
**Scripts:**  
- `scratch/xrp-early-fav-rush.mjs`  
- `scratch/xrp-early-fav-combo-xrpdist.mjs`  
- `scratch/xrp-early-fav-robustness.mjs`  
- `scratch/multi-asset-early-fav-rush.mjs`  
**Reports:** `.tmp/xrp-early-fav-*.json`, `.tmp/multi-asset-early-fav-rush.json`

## Tese

Em mercados crypto up/down 5m, o favorito do book frequentemente **cruza ≥85–90¢ cedo** (ainda com ≥2 min no relógio). Entrar nesse **primeiro toque precoce** e segurar até o settlement captura um edge de timing — não o mesmo sinal que “comprar favorito caro no terminal”.

Contraste importante:

| Regra | Resultado típico |
|-------|------------------|
| Comprar favorito **no instante τ=120s** (snapshot fixo) | PnL negativo em quase todas as faixas de ask |
| Comprar no **1º cruzamento ≥85¢** se naquele momento **τ≥120s** | PnL positivo, win ~91–94% (XRP) |

O edge está no **evento de rush precoce**, não em “estar favorito faltando 2 minutos”.

## Regra operacional recomendada (XRP)

1. Detectar o **primeiro tick** em que `max(up_ask, down_ask) ≥ 0.85`.
2. Entrar **somente se** `tau ≥ 120` nesse tick.
3. Filtro opcional barato: **spot concorda** com o lado do book (`spot` vs `price_to_beat`).
4. Hold até settlement (payout modelado a `0.995`, fee taker crypto 7%).
5. Budget de referência no lab: **$10**/trade.

**Não recomendado como regra principal:** filtros fortes de distância (`distAbs ≥ 0.001` / `0.0015`). Sobem win rate, mas **pioram generalização** (menos dias positivos, holdout mais fraco, pior em ~56/73 dias vs ampla).

### Números XRP (73d, ~19.4k eventos)

| Variante | Trades | Win% | PnL | PF | Dias+ | Holdout PnL (≥15/07) |
|----------|--------|------|-----|-----|-------|----------------------|
| Ampla 85@τ≥120 | 4669 | 91.6% | +$2310 | 1.58 | 89% | +$659 |
| + spotAgree | 4641 | 91.7% | **+$2386** | 1.62 | **90%** | **+$679** |
| + spot + dist≥0.001 | 2417 | 92.6% | +$1489 | 1.82 | 81% | +$238 |
| + spot + dist≥0.0015 | 1072 | 93.3% | +$747 | 2.03 | 77% | +$48 |

Concentração: top 5 dias positivos da ampla ≈ **18%** do lucro positivo (~3–4% cada) — **não** é artefato de 2–3 dias.

Heatmap de 1º toque (simplificado): τ no cruzamento **≥120s → verde**; **&lt;60s → vermelho forte**.

## Escala de preço / distância por ativo

`|spot − PTB|` é em **USD do underlying**, não uma unidade universal.

Referência lab MIDAS `scaled` (`maxDistAbs`):

| Asset | `maxDistAbs` scaled | Ordem de preço |
|-------|---------------------|----------------|
| BTC | 40 | ~$60k–120k |
| ETH | (ref 40 / calibrar) | ~$2k–4k |
| BNB | 0.28 | ~$600 |
| SOL | 0.08 | ~$100–200 |
| HYPE | 0.016 | ~$20–40 |
| XRP | **0.001** | ~$1.0–1.4 |
| DOGE | 0.00008 | ~$0.10–0.20 |

No entry XRP 85@τ≥120: mediana `|Δ|≈0.001` (~8 bps), p90≈0.002.  
Para comparação **cross-asset**, preferir **bps** = `1e4 × |Δ| / PTB` (comparável entre coins). Distância absoluta só com limiar **do próprio ativo**.

Erro clássico: reusar `dist≥10` (mentalidade BTC) em XRP/DOGE — o gate nunca dispara.

## Multi-asset

Rodar:

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node scratch/multi-asset-early-fav-rush.mjs
```

O script:

1. Inventaria partições locais `lake/backtest_ticks/underlying=*/interval=5m/book_depth=25`.
2. Estima escala (preço médio, p50/p90 de `|Δ|` e bps) por asset.
3. Avalia a mesma família de regras (1º toque × τ, ampla / spot / bps).
4. Reporta win rate, PnL, % dias+, holdout temporal e células thr×tau.

Veredito multi-asset: ver `.tmp/multi-asset-early-fav-rush.json` e seção de resultados no fim deste doc (atualizada após o run).

## O que isto NÃO é

- Não é MIDAS/TFC terminal (janela 5–30s com gates OBI/z).
- Não é Shotandgo / Relux5 (escada).
- Não valida fill real / latência / FAK — lab de ticks com ask tocável idealizado.

## Próximos passos

- [x] Confirmar multi-asset (mesma regra generaliza?) — **sim em 6/7**; HYPE só na janela 180–240s
- [ ] Smoke com execução honesta (slippage / book depth)
- [ ] Se estável: port GLS ou library-runner + preset por underlying
- [ ] Paper/dry na Giovanna antes de capital real
- [ ] HYPE: investigar por que τ≥120 falha mas 180–240s funciona (mais flips tardios?)

## Resultados multi-asset

_Gerado em 2026-08-06T00:17:37.827Z por `scratch/multi-asset-early-fav-rush.mjs`._

### Escala por ativo (no entry 85@τ≥120)

| Asset | Dias | Px~ | dist p50 | dist p90 | bps p50 | MIDAS scaled |
|-------|------|-----|----------|----------|---------|--------------|
| BNB | 63 | 597.17 | 0.383156 | 0.81214 | 6.54 | 0.28 |
| BTC | 104 | 68395.06 | 47.443597 | 93.392533 | 6.95 | 40 |
| DOGE | 63 | 0.08 | 0.000078 | 0.000148 | 9.56 | 0.00008 |
| ETH | 64 | 1783.14 | 1.657296 | 3.374469 | 9.29 | 1.5 |
| HYPE | 63 | 64.67 | 0.076945 | 0.166318 | 12.02 | 0.016 |
| SOL | 63 | 74.66 | 0.087391 | 0.158811 | 11.69 | 0.08 |
| XRP | 73 | 1.14 | 0.001021 | 0.00202 | 8.98 | 0.001 |

### Regra operacional por asset

Demais ativos: `85@τ≥120 + spotAgree`. **HYPE:** intervalo restrito `85@τ∈[180,240)` (sem exigir spot na célula reportada abaixo; ver script).

| Asset | Regra | Veredito | Trades | Win% | PnL | PF | Dias+ | Holdout PnL |
|-------|-------|----------|--------|------|-----|-----|-------|-------------|
| BNB | 85@τ≥120+spot | **PROMISING** | 4353 | 90.9% | $1591.69 | 1.398 | 73.02% | $146.05 |
| BTC | 85@τ≥120+spot | **PROMISING** | 5564 | 93.0% | $3759.03 | 1.952 | 87.5% | $1179.68 |
| DOGE | 85@τ≥120+spot | **PROMISING** | 4108 | 90.9% | $1780.98 | 1.472 | 85.71% | $471.53 |
| ETH | 85@τ≥120+spot | **PROMISING** | 3766 | 92.1% | $2171.27 | 1.724 | 89.06% | $623.4 |
| HYPE | **85@τ180–240s** | **PROMISING** | 1665 | **93.2%** | $1240.66 | **2.087** | 84.13% | $222.8 |
| SOL | 85@τ≥120+spot | **PROMISING** | 3846 | 92.8% | $2521.24 | 1.895 | 95.24% | $597.86 |
| XRP | 85@τ≥120+spot | **PROMISING** | 4641 | 91.7% | $2386.22 | 1.615 | 90.41% | $744.55 |

> Nota: a regra ampla `85@τ≥120+spot` em HYPE continua **NO_GO** (win 86.5%, PnL −$436, holdout −$744). O preset HYPE deve usar o intervalo restrito.

### Melhor célula thr×τ (score PnL/DD, n≥50) por asset

- **BNB:** thr≥0.85 @ 180-240s → win 92.03%, PnL $782.81, PF 1.631, dias+ 77.78%, holdout $25.81
- **BTC:** thr≥0.87 @ 180-240s → win 94.51%, PnL $998.19, PF 2.164, dias+ 80.77%, holdout $275.5
- **DOGE:** thr≥0.85 @ 180-240s → win 92.73%, PnL $871.17, PF 1.899, dias+ 84.13%, holdout $203.26
- **ETH:** thr≥0.85 @ 180-240s → win 93.2%, PnL $934.94, PF 2.052, dias+ 76.56%, holdout $341.52
- **HYPE:** thr≥0.85 @ 180-240s → win 93.21%, PnL $1240.66, PF 2.087, dias+ 84.13%, holdout $222.8
- **SOL:** thr≥0.85 @ 180-240s → win 93.17%, PnL $917.08, PF 2.044, dias+ 82.54%, holdout $199.55
- **XRP:** thr≥0.85 @ 180-240s → win 92.54%, PnL $1033.76, PF 1.839, dias+ 83.56%, holdout $299.94

## Otimização por asset (sweep thr × τ)

_Gerado em 2026-08-06T00:37:25.249Z por `scratch/multi-asset-early-fav-optimize.mjs`._

Cada asset foi otimizado **separadamente** (não só aplicar a regra do XRP). Critério de escolha: holdout>0, dias+≥65%, n≥80; score = blend PnL/DD + holdout + PF.

### Melhor regra por asset (métricas completas)

| Asset | Regra ótima | Trades | Win% | PnL | $/trade | PF | Dias+ | Holdout | MaxDD |
|-------|-------------|--------|------|-----|---------|-----|-------|---------|-------|
| BTC | `85@≥60+spot` | 10159 | 92.0% | $5495 | 0.54 | 1.67 | 86.5% | $1791 | $68 |
| ETH | `85@≥90+spot` | 5331 | 92.2% | $3045 | 0.57 | 1.72 | 92.2% | $853 | $59 |
| SOL | `85@≥60+spot` | 6948 | 92.0% | $3782 | 0.54 | 1.68 | 95.2% | $919 | $57 |
| XRP | `85@≥120+spot` | 4641 | 91.7% | $2386 | 0.51 | 1.62 | 90.4% | $745 | $61 |
| BNB | `85@180–240s` | 1544 | 92.0% | $783 | 0.51 | 1.63 | 77.8% | $26 | $47 |
| DOGE | `87@≥60+spot` | 6767 | 91.3% | $1729 | 0.26 | 1.29 | 82.5% | $489 | $85 |
| HYPE | `85@180–240s` | 1665 | 93.2% | $1241 | 0.75 | 2.09 | 84.1% | $223 | $41 |

### Baseline XRP (`85@≥120+spot`) vs ótimo

| Asset | Base Win | Base PnL | Base Hold | Base PF | Ótimo | Ótimo Win | Ótimo PnL | Ótimo Hold | Ótimo PF | Δ PnL |
|-------|----------|----------|-----------|---------|-------|-----------|-----------|------------|----------|-------|
| BTC | 93.0% | $3759 | $1180 | 1.95 | `85@≥60+spot` | 92.0% | $5495 | $1791 | 1.67 | **+$1736** |
| ETH | 92.1% | $2171 | $623 | 1.72 | `85@≥90+spot` | 92.2% | $3045 | $853 | 1.72 | **+$874** |
| SOL | 92.8% | $2521 | $598 | 1.90 | `85@≥60+spot` | 92.0% | $3782 | $919 | 1.68 | **+$1261** |
| XRP | 91.7% | $2386 | $745 | 1.62 | `85@≥120+spot` | 91.7% | $2386 | $745 | 1.62 | 0 |
| BNB | 90.9% | $1592 | **$146** | 1.40 | `85@180–240s` | 92.0% | $783 | $26 | 1.63 | −$809 |
| DOGE | 90.9% | $1781 | $472 | 1.47 | `87@≥60+spot` | 91.3% | $1729 | $489 | 1.29 | −$52 |
| HYPE | 86.5% | −$436 | −$744 | 0.94 | `85@180–240s` | **93.2%** | $1241 | $223 | **2.09** | **+$1677** |

> **BNB:** a regra restrita sobe win/PF, mas a ampla ainda tem mais PnL e holdout melhores — trade-off volume vs qualidade.

### Heat 85¢ por janela de τ no 1º toque (PnL)

- **BTC:** 240-300s:213.8 · 180-240s:1277.29 · 150-180s:1331.71 · 120-150s:878.58 · 90-120s:921.06 · 60-90s:742.58 · 45-60s:382.56 · 30-45s:179.41 · 10-30s:-1504.24 · 3-10s:-4967.39
- **ETH:** 240-300s:69.09 · 180-240s:934.94 · 150-180s:637.81 · 120-150s:506.71 · 90-120s:846.74 · 60-90s:119.59 · 45-60s:-160.85 · 30-45s:-364.59 · 10-30s:-963.45 · 3-10s:-1218.77
- **SOL:** 240-300s:180.09 · 180-240s:917.08 · 150-180s:925.43 · 120-150s:438.23 · 90-120s:562.21 · 60-90s:613.71 · 45-60s:246.93 · 30-45s:-30.81 · 10-30s:-1000.56 · 3-10s:-1771.38
- **XRP:** 240-300s:183 · 180-240s:1033.76 · 150-180s:508.36 · 120-150s:584.39 · 90-120s:396.39 · 60-90s:365.15 · 45-60s:-370.69 · 30-45s:-50.03 · 10-30s:-2311.32 · 3-10s:-2404.04
- **BNB:** 240-300s:-1079.69 · 180-240s:782.81 · 150-180s:496.04 · 120-150s:373.83 · 90-120s:149.81 · 60-90s:232.77 · 45-60s:-570.75 · 30-45s:-890.14 · 10-30s:-4951.07 · 3-10s:-1860.39
- **DOGE:** 240-300s:-359.14 · 180-240s:871.17 · 150-180s:413.98 · 120-150s:471.23 · 90-120s:333.83 · 60-90s:315.85 · 45-60s:-581.48 · 30-45s:-518.49 · 10-30s:-2628.88 · 3-10s:-2342.69
- **HYPE:** 240-300s:-9071.32 · 180-240s:1240.66 · 150-180s:608.07 · 120-150s:807.46 · 90-120s:61.95 · 60-90s:340.96 · 45-60s:-105.55 · 30-45s:-286.59 · 10-30s:-3055.53 · 3-10s:-2350.69

