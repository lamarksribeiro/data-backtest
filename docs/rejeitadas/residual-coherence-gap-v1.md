# Residual Coherence Gap V1 (RCG)

> **Status: REJEITADA** — documento arquivado em `docs/rejeitadas/`. RCG V1 não atende critérios de promoção (PF holdout 1.10, últimas 72h negativas); ver seção 7.

**Mercado-alvo:** Polymarket BTC Up/Down 5 minutos  
**Laboratório:** `scripts/lab-residual-coherence-gap.js`  
**Comando:** `npm run lab:rcg`

---

## 1. Hipótese e intuição

O book da Polymarket precifica contratos Up/Down com base em uma probabilidade implícita derivada dos asks. Quando o Bitcoin já se deslocou materialmente do **Price to Beat (PTB)**, a probabilidade **estatisticamente coerente** de vitória do favorito — medida por volatilidade realizada e tempo restante — pode ficar **acima** do ask observado.

Isso não é inércia dinâmica de repricing (IRI), nem convexidade terminal (TC), nem cruzamento explosivo do strike (TAT). É um **desalinhamento de nível**: o mercado oferece o favorito barato demais para o z-score coerente atual.

A métrica **Residual Coherence Gap (RCG)** quantifica esse desalinhamento líquido de fees:

$$\text{RCG} = \Phi(z) - \text{ask}_{fav} - \text{fee/share}$$

onde:

$$z = \frac{|\Delta_{btc}|}{\max(\sigma_{real}, \sigma_{floor}) \cdot \sqrt{\tau}}$$

- $\Delta_{btc} = P_{btc} - PTB$
- $\tau$ = segundos restantes até expiração
- $\sigma_{real}$ = desvio-padrão de retornos BTC normalizados por $\sqrt{dt}$ (lookback ~45s)
- $\Phi$ = CDF normal padrão

**Entrada** quando RCG > 0, z em banda moderada (nem ruído, nem certeza extrema), ask do favorito em faixa barata, book executável e direção estável.

**Saída:** hold-to-settlement (máximo 1 posição por evento).

---

## 2. Por que é diferente das estratégias existentes

| Estratégia | Foco | RCG |
|---|---|---|
| Terminal Convexity | θ/gamma nos últimos 8–15s | Opera em janelas mais amplas (30–200s) |
| IRI | Razão Δdist/Δp (inércia dinâmica) | Gap estático Φ(z) − ask |
| TAT | Cruzamento PTB + aceleração física | Não exige cruzamento; exige z coerente |
| Convergence Undershoot | Dist 5–20 USD, 15–45s | Pode operar dist 30–55 ou early lock 50+ |
| Edge Sniper | Edge genérico por modelo | Modelo explícito de coerência estatística |

---

## 3. Variáveis e filtros

| Variável | Descrição |
|---|---|
| `zCoherent` | Distância normalizada por vol e tempo |
| `pCoherent` | Φ(zCoherent) |
| `edgeBruto` | pCoherent − askFav |
| `edgeLiquido` / `rcg` | edgeBruto − fee/share |
| `sigmaReal` | Vol realizada BTC (USD/√s) |
| `stabilityTicks` | Ticks consecutivos no mesmo lado do PTB |

### Filtros operacionais padrão

- Janela temporal configurável por variante (`entryWindowStart/End`)
- `minZCoherent` ≤ z ≤ `maxZCoherent` (evita ruído e certeza já precificada)
- `askMin` ≤ ask ≤ `askMax` (favorito barato o suficiente para payoff assimétrico)
- `minAbsDist` ≤ |dist| ≤ `maxAbsDist`
- Spread, odds sum, liquidez do book, slippage máximo
- **1 posição por evento**

---

## 4. Variantes testadas

| Variante | Janela τ | Dist | Ask | z-band |
|---|---|---|---|---|
| `rcg-mid` | 90–200s | 15–40 | 0.38–0.55 | 1.2–2.2 |
| `rcg-late` | 18–45s | 30–58 | 0.30–0.45 | 1.4–3.2 |
| `rcg-early` | 150–280s | 50–120 | 0.42–0.56 | 2.0–4.5 |
| `rcg-robust` | 85–200s | 18–48 | 0.38–0.52 | 1.25–2.4 |
| `rcg-strict` | base | 20–45 | 0.40–0.50 | 1.3–2.0 |

---

## 5. Execução e fees

- Simulação com **book histórico** (`up/down_book_asks`)
- Partial fills via consumo de níveis + reserva por preço
- Slippage: `entrySlippageMax` sobre best ask
- Fees: `calculatePolymarketTakerFee` de `src/services/polymarketFees.js` (categoria crypto, 7%)
- Settlement binário: payout 1.0 ou 0.0 menos cost e fee de entrada
- Split temporal 60/20/20 (train/validation/holdout)

---

## 6. Hipóteses alternativas investigadas (pré-lab)

### H1 — Sign-cross repricing lag
Comprar favorito imediatamente após cruzamento do PTB com ask ≤ 0.65.  
**Resultado SQL:** WR 54.5%, gross edge +0.015/share, **net −0.002 após fees**. Rejeitada.

### H2 — Acceleration Divergence Index (ADI)
Distância acelerando enquanto probabilidade do book estagnada.  
**Resultado SQL:** WR 68.6% mas ask ~0.68; **net −0.0077**. Rejeitada.

### H3 — Underdog fade near PTB
Comprar underdog quando dist < 8 USD.  
**Resultado SQL:** WR ~48%, edge bruto insuficiente. Rejeitada.

### H4 — Dog ask collapse
Favorito quando ask do underdog colapsa rápido.  
**Resultado SQL:** WR 71% mas ask fav ~0.72; **net −0.017**. Rejeitada.

### H5 — RCG (escolhida)
Gap Φ(z) − ask com z moderado e ask barato.  
**Evidência SQL preliminar:** buckets `z∈[1.2,2.0]` + ask cheap → WR 59.3%, **net +0.14**; `tau 20–45` + dist 35–55 + ask <0.45 → **net +0.22**.  
**Backtest:** sinal SQL não generalizou após fees, book e splits — teoria arquivada.

---

## 7. Resultados empíricos e veredicto

**Recorte:** `2026-05-04T15:00:00.000Z` → `2026-05-23T00:09:59.757Z`  
**Base:** 3.170.537 ticks | 5.294 eventos | book 100% disponível | odds sum médio 1.013

### Resultados consolidados (modo quick, splits 60/20/20)

| Variante | Entradas | WR | PnL bruto | Fees | **PnL líq** | PF | DD |
|---|---|---|---|---|---|---|---|
| **rcg-strict** | 132 | 53.8% | +277.71 | 69.20 | **+208.51** | 1.23 | 118.18 |
| rcg-robust | 198 | 56.1% | +420.27 | 100.65 | +319.62 | 1.25 | 102.63 |
| rcg-base | 630 | 54.1% | +574.00 | 305.39 | +268.61 | 1.06 | 250.34 |
| baseline-random | 1559 | 50.1% | +200.64 | 778.99 | **−578.35** | 0.95 | 821.91 |

### Holdout (20% final)

| Variante | Entradas | PnL líq | PF | Veredicto |
|---|---|---|---|---|
| rcg-strict | 20 | +15.09 | 1.10 | Marginal — insuficiente |
| rcg-robust | 26 | −38.66 | 0.81 | Rejeitado |
| rcg-base | 94 | −52.10 | 0.92 | Rejeitado |

### Janelas recentes (rcg-strict)

| Janela | Entradas | PnL líq | PF |
|---|---|---|---|
| Últimas 72h | 13 | **−34.75** | 0.71 |
| Últimas 24h | 1 | −14.92 | 0.00 |

### Motivos da rejeição

- PF holdout **1.10** (critério mínimo 2.0)
- Últimas **72h negativas**
- Variantes menos restritivas **degradam no holdout**
- Edge SQL pré-lab **não sobrevive** à simulação realista com book e fees

O lab permanece em `scripts/lab-residual-coherence-gap.js` apenas para reprodução.

---

## 8. Impacto das fees

- Fee drag ~6–7% do lucro bruto em baixa frequência
- Alta frequência (`rcg-base`, 630 trades) aumenta fees sem melhorar PF holdout

---

## 9. Limitações e riscos

- Modelo Φ(z) assume normalidade — caudas grossas invalidam z
- Hold-to-settlement sem stop
- Resultados históricos não garantem edge futuro
