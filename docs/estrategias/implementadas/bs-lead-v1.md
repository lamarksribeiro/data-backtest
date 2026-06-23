# BS-Lead V1 (Black-Scholes + Lead-Lag Binance)

**BS-Lead** é uma estratégia híbrida que combina valor justo **Black-Scholes** (âncora no oráculo Chainlink/Polymarket) com **timing direcional** via lead-lag da Binance spot. Foi desenvolvida após o estudo de correlação Binance↔Polymarket (maio/2026).

* **Origem (polymarket-test):** `src/services/bsLeadBacktest.js`, `scripts/tune-bs-lead.js`
* **Runner portado (data-backtest):** `bs-lead-runner` (`data/strategy-libraries/bs-lead-runner.v1.json`)
* **Estudo base:** [`../../analise-quantitativa/estudo-correlacao-binance-polymarket.md`](../../analise-quantitativa/estudo-correlacao-binance-polymarket.md) (seção BS-Lead)
* **Status Studio:** runner portado, `promotedToStudio: false` (pendente promoção)

---

## 1. Hipótese

1. **Âncora de valor justo:** a probabilidade de settlement deve ser modelada com $\Phi(d_2)$ usando o spot do oráculo oficial (`btc_price` / Chainlink), que define a liquidação.
2. **Gatilho de timing:** entradas só na direção do momentum rápido da **Binance** (`btc_binance`), antes do book local reprecificar.
3. **Proteção microestrutural:** evitar entradas nos últimos ~20s (colapso de spread) e usar **Fair Value Stop** quando a probabilidade teórica cai abaixo do limiar.

---

## 2. Pilares operacionais

| Pilar | Descrição |
|---|---|
| Edge BS | Exige `pFair − ask ≥ minEdge` (variantes de 5% a 10%) |
| Confirmação Binance | `binanceConfirmSec` + `binanceConfirmMinMove` — impulso mínimo em USD na direção do trade |
| Janela | `entryWindowStart` 105s → `entryWindowEnd` 20s |
| Stops | `stopFairProb`, `stopBid`, take-profit, trail, `lateExit` / `finalExit` |
| Sizing | `sizePriceAware` reduz tamanho quando ask > threshold |

---

## 3. Resultados empíricos (polymarket-test, com taxas)

Período: 04/05/2026 – 29/05/2026 (~4.26M ticks). Baseline Edge Sniper: PnL total $370.51, holdout $61.51.

| Variante | PnL total | PnL holdout | Entradas | Win rate | Max DD | PF |
|---|---:|---:|---:|---:|---:|---:|
| `edge-5pct` | **$2,083.22** | **$429.64** | 1,151 | 54.1% | $156.15 | 1.65 |
| `combo-opt2` | $1,897.55 | $368.77 | 992 | 54.9% | $120.19 | 1.65 |
| `bin-3s-m3` | $1,695.91 | $334.23 | 799 | 56.4% | $117.78 | 1.69 |
| `bs-lead-default` | $1,656.61 | $369.22 | 902 | 55.5% | $146.37 | 1.60 |

A variante `bin-3s-m3` equilibra frequência e defesa (menor drawdown, maior win rate).

---

## 4. Parâmetros padrão do runner

```text
walletSize=100  maxOrderValue=15  minShares=5
entryWindowStart=105  entryWindowEnd=20
minAsk=0.08  maxAsk=0.58  minEdge=0.10  maxSpread=0.06
volLookbackSec=45
binanceConfirmSec=2  binanceConfirmMinMove=1.0
stopBid=0.18  stopFairProb=0.35
takeProfitBid=0.90  takeProfitPct=0.35
trailAfterBid=0.78  trailDrop=0.10
lateExitSec=16  lateExitMinBid=0.64
```

---

## 5. Dependências de dados

Requer coluna `btc_binance` (ou equivalente) no dataset de ticks para o gatilho lead-lag. Sem feed Binance histórico, o backtest no lakehouse pode degradar para comportamento parcial — validar cobertura antes de promover ao Studio.

---

## 6. Próximo passo no data-backtest

1. Confirmar paridade runner portado vs polymarket-test em janela com `btc_binance`.
2. Criar `labs/strategies/momentum/bs-lead-v1/strategy.json` e `promotedToStudio: true`.
3. Rodar backtest lakehouse e comparar com tabela acima.