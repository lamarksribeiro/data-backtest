# Estratégias implementadas — índice de documentação

Teorias portadas ao `data-backtest` (runners no Studio ou biblioteca). Origem principal: `polymarket-test/docs/estrategias/implementadas/` (sincronizado jun/2026).

## Compiled-native (hot path)

| Documento | Studio slug | Notas |
|---|---|---|
| [edge-snipper.md](edge-snipper.md) | `edge-snipper` | Evolução compilada; teoria em [edge-sniper-v2.md](edge-sniper-v2.md) |
| [edge-sniper-v2.md](edge-sniper-v2.md) | — | Especificação teórica base (legado polymarket-test) |
| [gamma-ladder-v1.md](gamma-ladder-v1.md) | `gamma-ladder-v1` | Box + ladder direcional |
| [gamma-ladder-v1-explicacao.md](gamma-ladder-v1-explicacao.md) | — | Guia didático |
| [vsmr-v1.md](vsmr-v1.md) | `vsmr` | Volatility Spike Mean Reversion (nativa data-backtest) |
| [whipsaw-lock-v1.md](whipsaw-lock-v1.md) | `whipsaw-lock` | Whipsaw Lock ANOM-22/33 (nativa data-backtest) |
| [midas-carry-v1.md](midas-carry-v1.md) | `midas-carry-v1` | TFC V7 + envelope high-ask em tier; supera TFC em treino e holdout |

## Library runners (tier A)

| Documento | Studio slug |
|---|---|
| [terminal-convexity-v1.md](terminal-convexity-v1.md) | `terminal-convexity-v1` |
| [terminal-convexity-v1-explicacao.md](terminal-convexity-v1-explicacao.md) | — |
| [cofre-sete-v1.md](cofre-sete-v1.md) | `cofre-sete-v1` |
| [impulse-elasticity-v1.md](impulse-elasticity-v1.md) | `impulse-elasticity` |
| [lead-inertia-v1.md](lead-inertia-v1.md) | `lead-inertia-v1` |
| [volatility-compression-lock-v1.md](volatility-compression-lock-v1.md) | `volatility-compression-lock-v1` |
| [stable-carry-compression-v1.md](stable-carry-compression-v1.md) | `stable-carry-compression-v1` |
| [convergence-undershoot-theory.md](convergence-undershoot-theory.md) | `convergence-undershoot-v1` |
| [momentum-edge-theory-v1.md](momentum-edge-theory-v1.md) | `momentum-edge-v1` |
| [bs-lead-v1.md](bs-lead-v1.md) | `bs-lead-v1` *(runner portado, Studio pendente)* |

## Library runners (tier B)

| Documento | Studio slug |
|---|---|
| [boundary-coherence-entropy-deviation-v1.md](boundary-coherence-entropy-deviation-v1.md) | `boundary-coherence-entropy-deviation-v1` |
| [empirical-residual-manifold-v1.md](empirical-residual-manifold-v1.md) | `empirical-residual-manifold-v1` |

## Portfolios (tier C)

| Documento | Studio slug |
|---|---|
| [fusion-five-v1.md](fusion-five-v1.md) | `fusion-five-v1` |
| [omni-edge-v1.md](omni-edge-v1.md) | `omni-edge-v1` |

## Estudos de suporte

| Documento | Relação |
|---|---|
| [../../analise-quantitativa/estudo-correlacao-binance-polymarket.md](../../analise-quantitativa/estudo-correlacao-binance-polymarket.md) | Origem empírica da BS-Lead |
| [../../referencia/paridade-edge-sniper-v2.md](../../referencia/paridade-edge-sniper-v2.md) | Golden test Edge Sniper |

Catálogo com `sourceDoc` por ID: `labs/strategies/_catalog/port-catalog.json`.