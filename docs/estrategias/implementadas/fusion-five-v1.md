# Fusion Five V1

Fusion Five V1 e uma estrategia de backtest para BTC Up/Down 5 minutos que combina as teses ja testadas em cinco modulos:

- Edge Sniper V1: direcional defensivo com late exit otimizado.
- Gamma Ladder V1: ladder direcional e oportunidades de box com alto profit factor.
- Cofre Sete V1: motor agressivo de maior PnL bruto no recorte recente.
- Impulse Elasticity V1: sinal de inercia quando BTC se move e o book responde devagar.
- Terminal Convexity V1: compra de convexidade nos ultimos segundos quando o lado ja esta moderadamente vencedor.

A proposta nao e escolher um vencedor por intuicao. O laboratorio roda os cinco baselines no mesmo stream historico, monta candidatos de fusao e compara PnL, profit factor, drawdown, perda maxima e splits cronologicos.

## Implementacao

- Service: `src/services/fusionFiveBacktest.js`
- Endpoint: `POST /api/backtest/fusion-five`
- Laboratorio: `scripts/lab-fusion-five.js`
- NPM: `npm run lab:fusion-five`
- Saida do estudo: `tmp/fusion-five-study.json`

O modo default do service e `selectionMode=stack`, com os cinco modulos padrao ativos. Nesse modo, a estrategia empilha os sinais dos modulos quando mais de uma tese aparece no mesmo evento. O modo `single` tambem existe e seleciona apenas um modulo por evento segundo a prioridade configurada.

## Recorte Validado

Comando usado:

```bash
npm run lab:fusion-five -- --from 2026-05-04T13:00:00.000Z --batch-size 25000
```

Cobertura:

| Item | Valor |
|---|---:|
| Inicio pedido | `2026-05-04T13:00:00.000Z` |
| Primeiro tick | `2026-05-04T13:00:02.257Z` |
| Ultimo tick | `2026-05-16T20:18:20.987Z` |
| Ticks | `2,112,356` |
| Eventos | `3,544` |
| Gaps > 2s | `25` |
| Gaps > 5s | `6` |
| Gaps > 10s | `1` |
| Maior gap | `118.6s` |

Splits cronologicos do estudo:

| Split | Periodo |
|---|---|
| Train | `2026-05-04T13:00:00.000Z` -> `2026-05-11T22:11:00.592Z` |
| Validation | `2026-05-11T22:11:00.592Z` -> `2026-05-14T09:14:40.789Z` |
| Holdout | `2026-05-14T09:14:40.789Z` -> `2026-05-16T20:18:20.987Z` |

## Baselines no Mesmo Recorte

| Estrategia | PnL | Entradas | Win rate | PF | Max DD | Pior perda | Melhor ganho |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cofre Sete V1 | `+3329.55` | `792` | `69.9%` | `2.54` | `138.42` | `-35.90` | `680.77` |
| Gamma Ladder V1 | `+2158.24` | `136` | `50.7%` | `6.15` | `68.59` | `-34.40` | `453.05` |
| Terminal Convexity V1 max30 | `+1366.44` | `46` | `50.0%` | `3.66` | `54.39` | `-29.70` | `472.32` |
| Terminal Convexity V1 | `+858.81` | `52` | `50.0%` | `4.02` | `26.89` | `-14.85` | `237.32` |
| Edge Sniper V1 | `+396.20` | `130` | `73.8%` | `2.33` | `44.44` | `-14.50` | `42.73` |
| Impulse Elasticity V1 | `+389.55` | `115` | `75.7%` | `4.01` | `22.54` | `-12.54` | `32.24` |

## Candidatos Fusion

| Candidato | PnL | Entradas | Eventos ativos | Win rate | PF | Max DD | Holdout PnL |
|---|---:|---:|---:|---:|---:|---:|---:|
| `fusion-stack-tc30-all` | `+7639.98` | `1219` | `821` | `68.0%` | `3.17` | `227.33` | `+327.05` |
| `fusion-stack-all` | `+7132.35` | `1225` | `821` | `67.9%` | `3.17` | `216.23` | `+472.33` |
| `fusion-stack-top3` | `+6763.16` | `1186` | `821` | `68.0%` | `3.13` | `188.57` | `+345.48` |
| `fusion-stack-tc30-no-gamma` | `+5481.74` | `1083` | `820` | `70.2%` | `2.77` | `159.71` | `+217.65` |
| `fusion-stack-no-gamma` | `+4974.11` | `1089` | `820` | `70.1%` | `2.73` | `148.61` | `+362.93` |
| `fusion-single-terminal-first` | `+4194.54` | `821` | `821` | `70.3%` | `3.01` | `141.27` | `+298.12` |

## Decisao

O melhor PnL bruto foi `fusion-stack-tc30-all`, com `+7639.98`, mas ele nao deve ser o default operacional: o holdout ficou com PF `1.32` e max drawdown `227.33`, sinal de que o aumento de tamanho da Terminal Convexity melhora o agregado historico, mas torna a cauda recente pior.

O default promovido para Fusion Five V1 e `fusion-stack-all`, com os cinco modulos padrao. Ele bateu todos os baselines no mesmo recorte:

- PnL `+7132.35`, contra `+3329.55` da melhor baseline individual.
- PF `3.17`, acima da Cofre Sete (`2.54`) e Edge Sniper (`2.33`).
- Holdout positivo em `+472.33`, maior que o holdout dos demais candidatos testados.
- Usa Terminal default, nao o tier `max30`, preservando perda maxima terminal de `-14.85` no modulo.

Perfil alternativo mais defensivo: `fusion-stack-no-gamma`. Ele ainda supera todas as baselines em PnL total (`+4974.11`) e reduz max drawdown para `148.61`, mas abre mao do PnL incremental da Gamma.

## Contribuicao do Default

No `fusion-stack-all`, a contribuicao dos modulos foi:

| Modulo | PnL | Entradas | PF | Max DD |
|---|---:|---:|---:|---:|
| Cofre Sete | `+3329.55` | `792` | `2.54` | `138.42` |
| Gamma Ladder | `+2158.24` | `136` | `6.15` | `68.59` |
| Terminal Convexity | `+858.81` | `52` | `4.02` | `26.89` |
| Edge Sniper | `+396.20` | `130` | `2.33` | `44.44` |
| Impulse Elasticity | `+389.55` | `115` | `4.01` | `22.54` |

## Como Rodar

Laboratorio completo:

```bash
npm run lab:fusion-five -- --from 2026-05-04T13:00:00.000Z --batch-size 25000
```

Backtest via API:

```bash
curl -X POST http://localhost:3000/api/backtest/fusion-five \
  -H "Content-Type: application/json" \
  -d '{
    "from": "2026-05-04T13:00:00.000Z",
    "to": "2026-05-16T20:18:20.987Z"
  }'
```

Perfil defensivo sem Gamma:

```json
{
  "from": "2026-05-04T13:00:00.000Z",
  "to": "2026-05-16T20:18:20.987Z",
  "selectionMode": "stack",
  "includeModules": ["terminal", "cofre", "impulse", "edge"]
}
```

Perfil agressivo experimental:

```json
{
  "from": "2026-05-04T13:00:00.000Z",
  "to": "2026-05-16T20:18:20.987Z",
  "selectionMode": "stack",
  "includeModules": ["terminal", "cofre", "impulse", "edge", "gamma"],
  "terminalParams": { "maxOrderValue": 30 }
}
```

## Riscos

- `selectionMode=stack` soma modulos no mesmo evento. Isso e intencional para a tese de portfolio, mas pode superestimar execucao se dois modulos consumirem a mesma liquidez historica do book.
- A fusao aumenta PnL e tambem aumenta drawdown agregado. Nao deve ir para ordem real antes de paper trading com auditoria de fills.
- A Cofre Sete concentra uma parte grande do PnL em poucos vencedores. O Fusion Five herda essa caracteristica.
- O resultado e backtest local, nao garantia de lucro real.
