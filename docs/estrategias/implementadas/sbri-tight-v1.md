# SBRI Tight V1 — Strike Boundary Repricing Inelasticity

**Status:** candidata (lab GLS validado) · **Lab:** `labs/strategies/microstructure/sbri-tight-v1/` · **GLS:** `src/backtestStudio/gls/strategies/SbriTight.gls` · **Data:** 2026-07-26

## Por que esta estratégia (e não paridade pura)

Antes de fechar o desenho, mineramos edges **estritamente side-neutral** (PnL idêntico se UP ou DOWN vencer):

| Tese | Resultado |
|---|---|
| Par completo simultâneo (ask_up+ask_down + fees &lt; 1) | Lucrativo, mas **~12–24 trades / 75 dias**; some com **1 tick de latência** |
| Completação causal (1ª perna barata → hedge) | Pares travados têm exp ~+US$ 1,1; **residual destrói** (exp ~−US$ 9 a −10) |
| Dump / abort de residual | Com accounting honesto, **não salva** o sinal |

Conclusão: arbitragem de par completo existe, mas **não escala**. A SBRI é a melhor alternativa **side-symmetric** (sem bias a priori UP vs DOWN) com frequência e PnL reais no lab.

> **Side-symmetric ≠ outcome-independent.** A SBRI escolhe o lado pelo **favorito pós-flip** (geometria spot×PTB). O lucro ainda depende desse favorito segurar até o settlement (~55–60% WR), compensado por ask barato e EV positiva.

## Tese

Imediatamente após o BTC **cruzar o PTB**, a probabilidade física do novo favorito salta, mas o book da Polymarket **atrasa** (hesitação de MM, medo de whipsaw, latência de hedge). O ask do favorito fica com desconto vs \(P_{phys}\) browniano.

$$
z = \frac{|BTC - PTB|}{\sigma_{ps}\sqrt{\tau}},\quad
P_{phys}=\Phi(z),\quad
\mathcal{E}_{sbri}=P_{phys}-Ask_{fav}
$$

Entrada taker no favorito quando \(\mathcal{E}_{sbri}\) e filtros de book passam; **hold to settlement** (sem saída taker).

## Parâmetros campeão (`btc-champion`)

| Parâmetro | Valor | Papel |
|---|---:|---|
| `maxSecsSinceFlip` | 8 | Flip recente (via `ptbFlipCount`) |
| `minDistAbs` | 12 | Confirmação física do rompimento |
| `minEdge` | 0.08 | Desconto mínimo vs \(P_{phys}\) |
| `maxAsk` | 0.52 | Payoff assimétrico (favorito ainda “barato”) |
| `maxSpread` | 0.04 | Liquidez executável |
| `minSecondsLeft` / `maxSecondsLeft` | 35 / 120 | Janela intermediária-final |
| `minOddsSum` / `maxOddsSum` | 0.96 / 1.06 | Book coerente |
| `entryBudget` | 10 | US$ por entrada |
| `volStepSecs` | 30 | σ realizada (3 passos × 30s) |

## Resultados lab GLS (compiled-soa, book depth 25, fees crypto)

| Janela | Variante | PnL | Entradas | WR | PF | Max DD | Dias+ |
|---|---|---:|---:|---:|---:|---:|---:|
| Train 27/04–31/05 (35d) | **champion** | **+632,70** | 135 | 59,3% | 2,19 | 29,46 | 24/35 |
| Train | catalog-tight | +269,95 | 31 | 64,5% | 3,55 | 19,73 | 14/35 |
| Holdout 01/06–13/07 (43d) | **champion** | **+574,36** | 194 | 54,1% | 1,68 | 77,89 | 25/43 |
| Holdout | edge10-ask52 | +608,62 | 177 | 55,4% | 1,80 | 67,96 | 24/43 |
| Holdout | catalog-tight | +404,78 | 68 | 58,8% | 2,53 | 46,36 | 20/43 |

**Champion combinado (aprox.):** ~**+US$ 1.207** em 78 dias, budget fixo US$ 10/entrada.

Relatórios:

- `reports/labs/sbri-tight-v1/2026-07-26T02-23-10-468Z-sbri-tight-train/`
- `reports/labs/sbri-tight-v1/2026-07-26T02-23-21-031Z-sbri-tight-holdout/`

## Variantes

| ID | Diff vs champion | Uso |
|---|---|---|
| `champion` | defaults | PnL absoluto; preset oficial |
| `edge10-ask52` | `minEdge=0.10` | Levemente melhor no holdout |
| `spread03` | `maxSpread=0.03` | Vizinho estável |
| `catalog-tight` | flip≤10s, dist≥15, edge≥0,10, ask≤0,48, τ 40–100 | Conservador (melhor PF/DD, menos trades) |

## Reproduzir

```powershell
npm run lab:run -- --experiment labs/strategies/microstructure/sbri-tight-v1/experiments/smoke.json --variant-workers 2
npm run lab:run -- --experiment labs/strategies/microstructure/sbri-tight-v1/experiments/train.json --variant-workers 4
npm run lab:run -- --experiment labs/strategies/microstructure/sbri-tight-v1/experiments/holdout.json --variant-workers 4
npm run lab:run-preset -- --preset btc-champion --strategy sbri-tight-v1 --strategy-family microstructure --from 2026-04-27 --to 2026-07-13 --daily-metrics
```

## Distinção de estratégias próximas

| Estratégia | Gatilho | Diferença |
|---|---|---|
| Whipsaw Lock | ≥3 flips + spot estável | Exige multi-oscilação; SBRI opera no **primeiro** pós-cruzamento com edge físico |
| TFC / MIDAS | τ≤30s, favorito terminal | Janela terminal; SBRI é mid-late (35–120s) pós-flip |
| LIM Prime | τ alto, dist 60–100 | Início do evento; SBRI é transição de barreira |
| Paridade Invariante | par completo sum&lt;1 | Side-neutral verdadeiro; frequência ~0 com latência |

## Limitações

1. **Não é market-neutral de settlement** — WR ~54–59%; perdas cheias no underdog residual quando o flip reverte.
2. GLS usa `ptbFlipCount(window)` como proxy de “flip recente”; o cubo usa `secs_since_flip` contínuo — contagens podem diferir levemente.
3. Holdout DD (~US$ 78) é material vs banca US$ 100 com budget US$ 10; para conta real preferir micro-budget ou `catalog-tight`.
4. Ainda não seedado no Studio (`promotedToStudio: false`) — promover após seed de preset se desejado.
