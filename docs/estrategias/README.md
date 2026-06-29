# Estratégias — índice

Documentação das teorias quantitativas para BTC Up/Down 5 minutos. Transferida do repositório `polymarket-test` (jun/2026) para servir de referência no `data-backtest`.

Os laboratórios originais (`scripts/lab-*.js`, `npm run lab:*`) permanecem no **polymarket-test** em modo somente leitura. O catálogo canônico de port e status no Studio está em `labs/strategies/_catalog/port-catalog.json` e `scripts/port-catalog.js`.

## Pastas

| Pasta | Critério |
|---|---|
| [`implementadas/`](implementadas/) | Runner portado e promovido ao Backtest Studio (`labs/strategies/*/strategy.json` com `promotedToStudio: true`). |
| [`nao-implementadas/`](nao-implementadas/) | Teoria documentada e lab concluído no polymarket-test; **ainda sem** runner no data-backtest. |
| [`../rejeitadas/`](../rejeitadas/) | Teoria **rejeitada no veredito final** (falência líquida, PF holdout inviável ou decisão explícita de arquivar). |

## Implementadas no data-backtest

Índice completo com 19 documentos: [`implementadas/README.md`](implementadas/README.md).

Inclui as 16 teorias transferidas do polymarket-test, mais:
- [`implementadas/edge-snipper.md`](implementadas/edge-snipper.md) — evolução compilada no Studio
- [`implementadas/vsmr-v1.md`](implementadas/vsmr-v1.md) — VSMR (nativa data-backtest)
- [`implementadas/bs-lead-v1.md`](implementadas/bs-lead-v1.md) — BS-Lead (runner portado, Studio pendente)

Estudo de suporte: [`../analise-quantitativa/estudo-correlacao-binance-polymarket.md`](../analise-quantitativa/estudo-correlacao-binance-polymarket.md).

## Não implementadas (backlog de port)

Prioridade e `sourceDoc` no catálogo de port:

| Prioridade | Documento | ID |
|---:|---|---|
| 1 | `strike-boundary-repricing-inelasticity-v1.md` | SBRI |
| 2 | `stochastic-escape-barrier-theory-v1.md` | SEBT |
| 2 | `transition-acceleration-threshold-v1.md` | TAT |
| 2 | `u-shape-volatility-v1.md` | USVM |
| 2 | `sch-theory-v1.md` | SCH (hipótese impulsiva aprovada; reversion rejeitada no doc) |
| — | `avdt-v1.md` | AVDT |
| — | `barrier-gravitational-equilibrium-theory-v1.md` | BGET |
| — | `kinetic-probability-lag-theory-v1.md` | KPLT |
| — | `path-memory-asymmetry-v1.md` | PMA |
| — | `repricing-inertia-index-v1.md` | IRI (reserva de pesquisa; holdout positivo, PF < 2) |

## Rejeitadas (`docs/rejeitadas/`)

Estratégias com veredito final negativo (também listadas em `port-catalog.json` → `rejected` quando aplicável):

- `ambiguity-equilibrium-dispersal-v1.md` — AED V1
- `dynamic-probability-decoupling-v1.md` — DPD V1
- `coherence-hazard-edge-v1.md` — CHE V1
- `residual-coherence-gap-v1.md` — RCG V1
- `sigma-adaptive-drift-v1.md` — SAD V1
- `order-book-imbalance-transition-pressure-v1.md` — OBITP V1
- `tptca-theory-v1.md` — TPTCA V1

Estudos e post-mortems (sem port planejado):

- `consensus-hysteresis-vacuum-study-2026-05-21.md`
- `estudo-falhas-2026-05-18.md`

## Análise comparativa

[`analise-comparativa-estrategias.md`](analise-comparativa-estrategias.md) — panorama de janelas operacionais, gatilhos e sinergia entre teorias.

## Fluxo para novo port

1. Ler a teoria em `nao-implementadas/` ou `rejeitadas/`.
2. Reproduzir paridade no polymarket-test (`npm run lab:*`).
3. Portar runner para `data/strategy-libraries/` + manifest em `labs/strategies/`.
4. Atualizar `scripts/port-catalog.js` e `labs/strategies/_catalog/port-catalog.json`.
5. Mover o doc para `implementadas/` quando `promotedToStudio: true`.

Guia operacional: [`../referencia/guia-criacao-e-teste-de-laboratorios.md`](../referencia/guia-criacao-e-teste-de-laboratorios.md).