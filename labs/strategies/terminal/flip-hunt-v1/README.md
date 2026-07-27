# Flip Hunt V1

Caça a **flips pós-cruzamento do PTB** no BTC Up/Down 5m.

| | |
|---|---|
| **Tese** | H2 `post_cross_lead` — após o spot cruzar a barreira, o book atrasa; compra o **novo líder** com edge físico |
| **Saída** | Hold-to-settlement |
| **Budget** | US$ 10 / trade |
| **Lab** | `labs/strategies/terminal/flip-hunt-v1/` |
| **GLS** | `src/backtestStudio/gls/strategies/FlipHuntV1.gls` |
| **Status** | **candidate** — lab GLS holdout positivo (PF ≥ 1.6) |

## Veredito do lab (compiled-soa, depth 25)

| Variant | Train PnL | Train n | Train WR | Train PF | Holdout PnL | Holdout n | Holdout WR | Holdout PF | MaxDD hold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **`tight-spread`** ⭐ | **+287.8** | 559 | 65.7% | 1.16 | **+459.0** | 238 | **72.7%** | **1.74** | 38.7 |
| `champion-h2` | +281.6 | 480 | 67.9% | 1.19 | +334.9 | 205 | 72.7% | 1.63 | 42.5 |
| `sbri-like-mid` | — | — | — | — | −38.7 | 41 | 46.3% | 0.82 | 39.3 |

- Train: `2026-05-28` → `2026-06-30` · Holdout: `2026-07-01` → `2026-07-26`
- Relatórios:
  - `reports/labs/flip-hunt-v1/2026-07-27T04-59-09-401Z-flip-hunt-train/`
  - `reports/labs/flip-hunt-v1/2026-07-27T05-02-31-958Z-flip-hunt-holdout/`
- **Holdout > train** em WR e PF nas duas variantes H2 — bom sinal de robustez.
- Janela mid estilo SBRI (`sbri-like-mid`) **não** funciona no mesmo harness terminal com esses cortes.

Campeã de produção sugerida: **`btc-tight-spread`** (maior PnL holdout + PF).

## O que o miner matou / manteve

| Tese | Resultado |
|---|---|
| H1 fake_leader_dog (comprar azarão *antes* do flip) | **Rejeitada** — train negativo |
| **H2 post_cross_lead** | **Campeã** — único strict survivor |
| H3 late_phys_cheap (miner simplificado) | Overfit; LCF mode3 separado ainda vale no próprio lab |
| H4 momentum through barrier | **Rejeitada** |

Scripts: `scratch/mine-flip-hunt.mjs`, `scratch/mine-flip-hunt-h2-refine.mjs`, taxas base `scratch/late-flip-rates.json`.

## Mecânica

```text
ptbFlipCount(maxSecsSinceFlip) ≥ 1
AND minSecondsLeft ≤ τ ≤ maxSecondsLeft
AND |spot − PTB| ≥ minDistAbs
AND minAsk ≤ ask_fav ≤ maxAsk AND spread ≤ maxSpread
AND Φ(|dist|/(σ√τ)) − ask ≥ minEdge
→ buy fav, hold to settlement
```

### Params `btc-tight-spread` (lab campeã)

| Parâmetro | Valor |
|---|---:|
| `maxSecsSinceFlip` | 15 |
| `minSecondsLeft` / `maxSecondsLeft` | 10 / 50 |
| `minDistAbs` | 8 |
| `minEdge` | 0.05 |
| `maxAsk` | 0.78 |
| `maxSpread` | **0.02** |

### Params `btc-champion` (robust miner)

| Parâmetro | Valor |
|---|---:|
| `maxSecsSinceFlip` | 15 |
| `minSecondsLeft` / `maxSecondsLeft` | 8 / 40 |
| `minDistAbs` | 8 |
| `minEdge` | 0.03 |
| `maxAsk` | 0.78 |
| `maxSpread` | 0.05 |

## Relação com outras strats

- **SBRI Tight**: mesma ideia pós-flip, janela **mid** (35–120s). Flip Hunt é a **prima terminal**.
- **Late Cheap Flip mode2**: post-flip com ask mais barato; mode3 não exige flip recente.
- **TFC reverse**: entra cedo e reverte no late flip; Flip Hunt **só entra** no pós-cross.

## Reproduzir

```powershell
node scratch/mine-flip-hunt.mjs --days 60 --holdout-from 2026-07-01
node scratch/mine-flip-hunt-h2-refine.mjs

npm run lab:run -- --experiment labs/strategies/terminal/flip-hunt-v1/experiments/smoke.json --variant-workers 2
npm run lab:run -- --experiment labs/strategies/terminal/flip-hunt-v1/experiments/train.json --variant-workers 2
npm run lab:run -- --experiment labs/strategies/terminal/flip-hunt-v1/experiments/holdout.json --variant-workers 2
```

## Próximos passos

1. Walk-forward por semana / sensibilidade ±20% nos cortes.
2. Micro-budget se MaxDD ~$40 for grande vs wallet live.
3. `npm run lab:promote-to-studio` só após (1).
