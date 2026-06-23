# Volatility Spike Mean Reversion V1 (VSMR)

**Volatility Spike Mean Reversion (VSMR)** é uma estratégia de mean reversion desenvolvida no `data-backtest` para contratos BTC Up/Down 5 minutos na Polymarket. Ela explora mispricing temporário no favorito quando um **choque de volatilidade adverso** (spike rápido contra o lado líder) faz o book subprecificar a probabilidade de settlement.

* **Implementação:** `src/backtestStudio/gls/strategies/VolatilitySpikeMeanReversion.gls`
* **Studio slug:** `vsmr`
* **Kind:** compiled-native (GLS → Strategy JS)

---

## 1. Hipótese

Quando o BTC já está do lado vencedor do PTB, mas sofre um movimento **adverso rápido** nos últimos ~15s, market makers hesitam em reprecificar o favorito. O ask permanece abaixo da probabilidade física de longo prazo estimada por vol realizada e tempo restante.

A entrada compra o favorito nesse “pânico” de book, apostando na reversão do spike e na convergência ao settlement.

---

## 2. Sinais e regras

| Componente | Regra |
|---|---|
| Janela | `entryWindowStart` 150s → `entryWindowEnd` 45s restantes |
| Spike de vol | `volFast / volSlow ≥ vrThreshold` (padrão 2.0; fast 15s, slow 45s) |
| Choque adverso | `priceChange` nos últimos 15s **contra** o sinal da distância ao PTB |
| Probabilidade justa | `pFair = Φ(|dist| / (σ_slow · √τ))` |
| Edge líquido | `pFair − ask ≥ minNetEdge` (padrão 0.08) |
| Book | `minAsk ≤ ask ≤ maxAsk`, `spread ≤ maxSpread`, liquidez mínima |
| Saída | Hold to settlement (sem stop-reverse na V1 GLS) |

---

## 3. Parâmetros padrão

```text
walletSize=100  maxOrderValue=15  minShares=5
entryWindowStart=150  entryWindowEnd=45
vrThreshold=2.0  minNetEdge=0.08
minAsk=0.10  maxAsk=0.88  maxSpread=0.06
entrySlippageMax=0.02  minLiquidityRatio=0.60
volLookbackSec=45
```

---

## 4. Status no data-backtest

- Promovida ao Backtest Studio (`labs/strategies/volatility/vsmr/strategy.json`).
- Documentação de teoria original não existia no `polymarket-test`; esta página consolida a especificação a partir do GLS e do manifest do lab.
- Janela de validação referenciada no manifest: 2026-05-04 a 2026-06-07.

---

## 5. Relação com outras estratégias

- **Volatility Compression Lock:** comprime vol e lock de carry — regime distinto.
- **Impulse Elasticity:** momentum elástico pós-impulso, não spike adverso no favorito.
- **USVM (backlog):** também modela vol, mas na fase intermediária em formato de U — ainda não portada.