# Repricing Inertia Index (IRI) V1

A **Repricing Inertia Index (IRI) V1** é uma teoria quantitativa nova para BTC Up/Down 5 minutos na Polymarket. Ela explora uma ineficiência de **microestrutura temporal**: quando o BTC se afasta do Price to Beat (PTB) mais rápido do que o book reprecifica a probabilidade do favorito, o ask permanece barato por alguns segundos.

Diferente de Terminal Convexity (fase terminal), TAT (aceleração no cruzamento), DPD (desacoplamento por micro-drift) ou CHE (ratio sigma implícita/real), a IRI mede explicitamente a **inércia de repricing** — quantos dólares de distância o BTC ganhou por ponto percentual de probabilidade que o mercado moveu.

- **Laboratório:** `scripts/lab-repricing-inertia.js`
- **Comando npm:** `npm run lab:iri`

---

## 1. Hipótese

Quando o BTC se desloca decisivamente na direção de um lado vencedor provável, market makers e fluxo de varejo ajustam o book com atraso. Esse atraso é visível quando:

1. A distância absoluta ao PTB **cresce** em ~30 segundos (`deltaDist > 0`).
2. A probabilidade implícita do favorito (`pFav`) **quase não se move** (`deltaPFav` pequeno).
3. O ratio `IRI = deltaDist / |deltaPFav|` fica alto — muitos USD de movimento físico por pp de repricing.

Nessa janela, comprar o favorito com ask ainda defasado oferece edge bruto que, após fees taker oficiais, pode permanecer positivo se filtros de liquidez e spread forem respeitados.

---

## 2. Matemática

Variáveis por tick:

```text
dist       = btc_price - price_to_beat
tau        = segundos até expiração
pMarketUp  = upAsk / (upAsk + downAsk)
pFav       = max(pMarketUp, 1 - pMarketUp)
favorite   = UP se dist >= 0, senão DOWN
askFav     = ask do favorito
```

Lookback de inércia (~30s):

```text
deltaDist  = |dist_t| - |dist_{t-L}|
deltaPFav  = pFav_t - pFav_{t-L}
IRI        = deltaDist / max(eps, |deltaPFav|)    [USD / pp]
```

Modelo de probabilidade coerente:

```text
sigma_real = std( (BTC_i - BTC_{i-1}) / sqrt(dt) )   ; janela 60s
zCoherent  = |dist| / (sigma_real * sqrt(tau))
pCoherent  = Phi(zCoherent)
edgeBruto  = pCoherent - askFav
feeShare   = calculatePolymarketTakerFee({ shares: 1, price: askFav })
edgeLiquido = edgeBruto - feeShare
```

**Métrica de decisão:** `edgeLiquido >= minNetEdge` com `IRI >= minIRI`, `deltaDist >= minDeltaDist`, `deltaPFav <= maxDeltaPFav`.

---

## 3. Regras operacionais (variante promovida: `iri-robust`)

| Parâmetro | Valor | Papel |
|---:|---:|---|
| `entryWindowStart` | 110s | Início da janela |
| `entryWindowEnd` | 35s | Evita últimos segundos |
| `lookbackMinSec` / `lookbackMaxSec` | 28 / 35 | Janela de inércia |
| `minIRI` | 100 | Inércia mínima de repricing |
| `minDeltaDist` | 6 USD | Distância deve expandir |
| `maxDeltaPFav` | 0.05 | Probabilidade estagnada |
| `minAbsDist` / `maxAbsDist` | 12 / 45 USD | Faixa de distância |
| `askMin` / `askMax` | 0.48 / 0.68 | Payoff viável pós-fee |
| `maxSpread` | 0.035 | Liquidez saudável |
| `minNetEdge` | 0.05 | Edge líquido mínimo |
| `minZCoherent` | 0.65 | Coerência dist/vol/tempo |
| `maxOrderValue` | $15 | Risco por trade |

Fluxo:

1. Uma posição por evento, hold-to-settlement.
2. Fill no book histórico até `ask + 0.02` slippage.
3. Fees via `src/services/polymarketFees.js` (crypto 7%).
4. Partial fills respeitando `minLiquidityRatio`.

---

## 4. Auditoria do banco (pré-modelagem)

Recorte: `2026-05-04T15:00:00.000Z` → último timestamp disponível.

| Métrica | Valor |
|---|---:|
| Ticks | 3.023.322 → 3.170.537 (atualizado na execução) |
| Eventos | 5.077 |
| Book missing | 0 |
| Odds sum balanceado (0.94–1.06) | 99,1% dos ticks |
| Settlement UP/DOWN | ~50/50 |

Exploração SQL identificou:

- Em cruzamentos de sinal PTB, ask médio do novo favorito ≈ **0,54** (hesitação de repricing).
- Regime de **inércia** (distância cresce, pFav estagnado) com win rate bruto ~64% em probes offline.
- Variante **DVCL** (compressão de vol + distância) teve win rate ~70% em probe, mas não foi promovida no backtest completo por sobreposição com VCL/CHE.

---

## 5. Hipóteses formuladas e destino

### H1 — Sticky Distance Compression (DVCL)
- **Intuição:** vol baixa + distância alta → favorito subprecificado.
- **Probe:** 70,1% win rate, 1236 entradas.
- **Backtest completo:** variante `iri-dvcl` não incluída no modo quick; requer validação separada.
- **Status:** reserva, não promovida.

### H2 — Probability Stall (base da IRI)
- **Intuição:** zReal alto, pFav baixo → book atrasado.
- **Probe:** 62,3% win, 1649 entradas, edge líquido médio +0,28.
- **Backtest:** positivo após fees; promovida como teoria principal.

### H3 — Ambiguous Equilibrium Break
- **Intuição:** distância material com book ainda ~50/50.
- **Probe:** 58,0% win — edge marginal.
- **Status:** rejeitada (sobrepõe AED rejeitada).

### H4 — Model-Market Divergence puro
- **Intuição:** pModel − pFav grande sem filtro de inércia.
- **Probe:** 63% win mas genérico demais (similar DPD/CHE).
- **Status:** rejeitada como tese principal.

### H5 — Overpriced Favorite Fade (underdog)
- **Probe:** 65% win mas **edge líquido negativo** (−0,14/trade).
- **Status:** invalidada pelas fees.

---

## 6. Resultados empíricos (run completo 2026-05-04 → 2026-05-23)

Split 60/20/20. Fees taker oficiais. Book histórico.

### Variantes IRI — consolidado

| Variante | Entradas | WR | PnL bruto | Fees | PnL líq | PF | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| **iri-robust** | 413 | 64,6% | +450,92 | 163,34 | **+287,58** | 1,13 | 134,62 |
| iri-late | 521 | 65,1% | +326,58 | 194,62 | +131,96 | 1,05 | 160,27 |
| iri-base | 810 | 65,9% | +576,69 | 299,04 | +277,65 | 1,07 | 213,14 |
| iri-strict | 528 | 64,2% | +301,84 | 201,10 | +100,73 | 1,04 | 127,27 |

### Holdout (20% final)

| Variante | Entradas | WR | PnL líq | PF |
|---|---:|---:|---:|---:|
| iri-late | 82 | 73,2% | **+155,56** | 1,48 |
| iri-robust | 73 | 67,1% | +75,82 | 1,22 |
| iri-base | 139 | 66,9% | +21,66 | 1,03 |

### Comparação com estratégias existentes (período completo, líquido)

| Estratégia | Entradas | PnL líq | PF | Fee drag |
|---|---:|---:|---:|---:|
| Gamma Ladder V1 | 215 | +3596,78 | 4,98 | 6,9% |
| Terminal Convexity V1 | 68 | +906,07 | 3,15 | 3,2% |
| Impulse Elasticity V1 | 159 | +437,65 | 2,99 | 10,6% |
| Edge Sniper V1 | 209 | +335,27 | 1,56 | 9,5% |
| **IRI iri-robust** | 413 | +287,58 | 1,13 | 6,7% |

### Janelas recentes (`iri-late` vs baselines)

| Janela | IRI (iri-late) | Edge Sniper | Impulse Elast. |
|---|---:|---:|---:|
| 72h | +23,11 | +35,16 | +106,02 |
| 24h | +47,84 | +9,99 | +48,02 |

### Impacto de frequência (fee drag)

| Regime | Entradas | PnL líq | PF |
|---|---:|---:|---:|
| Baixa freq | 679 | +105,61 | 1,03 |
| Média freq | 810 | +277,65 | 1,07 |
| Alta freq | 1318 | +195,98 | 1,03 |

Alta frequência **degrada** expectativa líquida — coerente com fee drag.

---

## 7. Veredito conservador

### O que sobreviveu
- Edge **líquido positivo** no holdout para `iri-robust` (+75,82) e `iri-late` (+155,56).
- Fee drag controlado (~7%).
- Comportamento distinto das estratégias existentes (janela 35–110s, sinal de inércia, não terminal).
- Sobrevive 72h e 24h com PnL líquido positivo (`iri-late`).

### O que falhou nos critérios estritos
- **PF holdout < 2,0** em todas as variantes (melhor: 1,48 em `iri-late`).
- Validation split frequentemente fraco ou negativo (`iri-late`: −40,10).
- PnL total inferior a Edge Sniper, Impulse Elasticity, TC e Gamma Ladder.
- `iri-strict` e alta frequência: edge marginal (PF ≈ 1,03–1,04).

### Variantes promovidas vs rejeitadas

| Status | Variante |
|---|---|
| **Promovida (conservadora)** | `iri-robust` — melhor equilíbrio train/val/holdout |
| **Promovida (agressiva)** | `iri-late` — melhor holdout, validation instável |
| Rejeitada | `iri-strict`, alta frequência, anti-IRI |
| Rejeitada | H5 underdog fade, H3 ambiguous break |
| Pendente | `iri-dvcl` — probe forte, backtest full pendente |

---

## 8. Impacto das fees

Fees calculadas via `calculatePolymarketTakerFee` em cada entrada. Para ask ≈ 0,55:

```text
fee/share ≈ 0.07 * 0.55 * 0.45 ≈ 0.0173 USDC
```

Com edge bruto típico 0,08–0,12, a fee consome ~15–25% do edge bruto — estratégia **não sobrevive** com micro-edge < 0,03. Por isso `minNetEdge = 0.05` é obrigatório.

---

## 9. Limitações e riscos

1. Edge modesto; não substitui TC/Gamma/Impulse no PnL absoluto.
2. Validation negativa em variantes agressivas sugere possível overfit temporal.
3. Dependência de book histórico denso; gaps degradam fills.
4. Uma posição/evento limita upside por evento.
5. Regime de BTC de baixa vol pode reduzir frequência de sinais IRI.

---

## 10. Plano de uso

1. Rodar `npm run lab:iri` antes de qualquer deploy.
2. Operar apenas `iri-robust` em paper trading até PF holdout rolling 30d > 1,2.
3. Não aumentar frequência além do perfil médio — alta freq destrói edge.
4. Monitorar `IRI`, `deltaDist`, `deltaPFav` nos logs de entrada.
5. Revalidar após mudanças de fee schedule Polymarket.

```bash
npm run lab:iri
npm run lab:iri:full
```

---

## 11. Conclusão

A IRI V1 documenta uma anomalia real e reproduzível: **repricing lento do favorito quando a distância ao PTB acelera**. O edge sobrevive às fees oficiais e permanece positivo no holdout, mas com **magnitude modesta** e **PF abaixo do limiar 2,0**. Trata-se de uma teoria defensável para research e complemento de stack, não de substituto das estratégias campeãs do workspace.
