# Whipsaw Lock V1 (ANOM-22/33)

**Whipsaw Lock** é uma estratégia GLS nativa do `data-backtest` para contratos BTC Up/Down 5 minutos na Polymarket. Explora o padrão microestrutural em que o spot ziguezagueia repetidamente sobre o PTB (Price To Beat) e, após estabilizar, o favorito ainda negocia com ask descontado.

* **Implementação:** `src/backtestStudio/gls/strategies/WhipsawLock.gls`
* **Lab:** `labs/strategies/microstructure/whipsaw-lock`
* **Studio slug:** `whipsaw-lock`
* **Preset campeão:** `btc-champion` (`ws-spread25`)
* **Catálogo de descoberta:** `docs/analise-quantitativa/catalogo-anomalias.md` (ANOM-22, refinamento ANOM-33)

---

## 1. Hipótese

Quando o BTC cruza o PTB várias vezes em pouco tempo (whipsaw), market makers hesitam em assumir direção — o ask do favorito final fica artificialmente barato mesmo com o spot já estabilizado do lado vencedor. A entrada compra o favorito nesse vácuo de repricing pós-oscilação.

Mecanismo **distinto** de ODR, LIM, SBRI, SCH e teorias do backlog (`repricing-inertia`, `kinetic-probability-lag`).

---

## 2. Sinais e regras

| Componente | Regra |
|:---|:---|
| Flips PTB | `signals.ptbFlipCount(samples, 60) ≥ 3` — cruzamentos do PTB na janela de 60s |
| Estabilidade | `|ΔBTC₂₀ₛ| ≤ 5` USD |
| Distância | `|BTC − PTB| ≥ 22` USD |
| Tempo | `35 ≤ τ ≤ 160` segundos restantes |
| Preço | `ask_fav ≤ 0.57`, `spread ≤ 0.025` |
| Execução | Taker book depth 25, fee 0.07, hold to settlement |

---

## 3. Parâmetros campeão (`btc-champion`)

```text
walletSize=100  entryBudget=10  minFlips=3  flipWindowSecs=60
minDistAbs=22  stableLookbackSecs=20  stableMaxMove=5
minSecondsLeft=35  maxSecondsLeft=160
maxEntryPrice=0.57  maxSpread=0.025
```

---

## 4. Resultados de validação

Período: **2026-05-04 → 2026-06-14** (41 dias), book depth 25, taxa taker 0.07.

| Janela | Trades | WR | Exp/trade (miner) | Exp/trade (GLS) |
|:---|:---:|:---:|:---:|:---:|
| Full | 46 / 44 | ~63% | $+13.60 | $+9.82 |
| Holdout (20d) | 34 / 32 | ~62% | $+16.48 | $+11.50 |

---

## 5. Como executar no lab

```bash
node labs/cli/run-preset.js --preset btc-champion --strategy whipsaw-lock --strategy-family microstructure --from 2026-05-04 --to 2026-06-14
```

---

## 6. Runner-up relacionado

**Late Drift Confirm (ANOM-26)** — maior frequência (~116 trades holdout), menor exp por trade ($+9.81). Documentado no catálogo de anomalias; ainda não portado como estratégia de lab.