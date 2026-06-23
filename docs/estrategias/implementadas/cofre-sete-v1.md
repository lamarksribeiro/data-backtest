# Cofre Sete V1

A **Cofre Sete V1** e uma estrategia independente para o mercado BTC Up/Down 5 minutos da Polymarket. Ela roda em `src/services/cofreSeteBacktest.js`, expõe a rota `POST /api/backtest/cofre-sete` e aparece no dashboard como `Cofre Sete V1`.

Ela nao substitui Edge Sniper, Gamma Ladder ou Meta Shield. A proposta e combinar tres ideias em uma engine multi-perna por evento:

1. **Vault Box**: tenta comprar UP e DOWN quando a soma dos asks permite travar lucro na expiracao.
2. **Flux Sniper**: compra tranches direcionais quando o modelo estima edge contra o ask.
3. **Hedge/Trap opcionais**: podem ser ligados via parametros, mas ficam desligados por default porque pioraram a validacao inicial.

---

## Resultado validado

Periodo principal: `2026-05-04T14:00:00.000Z` ate `2026-05-13T23:00:00.000Z`.

Cobertura: `1,616,932` ticks.

| Estrategia | PnL | Entradas | Win rate | Profit factor | Max drawdown | Pior perda | Perdas |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cofre Sete V1 | 3185.83 | 1561 | 71.4% | 3.44 | 95.23 | -35.90 | 170 |
| Gamma Ladder V1 | 2057.57 | 263 | 54.6% | 7.81 | 49.99 | -34.40 | 49 |
| Edge Sniper V1 | 328.14 | 104 | 72.1% | 2.52 | 25.27 | -14.49 | 28 |
| Meta Shield V1 | 28.73 | 137 | 70.8% | 2.05 | 3.50 | -1.59 | 37 |

Periodo equivalente provavel em horario Brasil: `2026-05-04T17:00:00.000Z` ate `2026-05-14T02:00:00.000Z`.

| Estrategia | PnL | Entradas | Win rate | Profit factor | Max drawdown | Pior perda | Perdas |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cofre Sete V1 | 3201.94 | 1525 | 71.5% | 3.52 | 95.23 | -35.90 | 167 |
| Gamma Ladder V1 | 2051.58 | 259 | 51.9% | 7.74 | 52.69 | -34.40 | 50 |
| Edge Sniper V1 | 318.57 | 102 | 72.5% | 2.48 | 25.27 | -14.49 | 27 |
| Meta Shield V1 | 31.51 | 133 | 72.2% | 2.25 | 3.50 | -1.59 | 34 |

Leitura: a Cofre Sete bateu a Gamma em PnL absoluto no periodo testado, mas com mais operacoes, drawdown maior e profit factor menor. Ela e mais agressiva e depende mais de grandes vencedores. Nao deve ser tratada como perfil conservador.

---

## Validacao em folds

Comando usado:

```bash
node scripts/tune-cofre-sete.js 2026-05-04T14:00:00.000Z 2026-05-13T23:00:00.000Z 6 quick 120 8 25000
```

Melhor preset (`wide-nohedge`), promovido para default:

| Preset | PnL folds | Entradas | Win rate | Profit factor | Max drawdown | Pior perda | Folds positivos |
|---|---:|---:|---:|---:|---:|---:|---:|
| wide-nohedge | 3174.12 | 1562 | 71.4% | 3.43 | 95.23 | -35.90 | 6/6 |

Baselines no mesmo comando:

| Estrategia | PnL | Entradas | Profit factor | Max drawdown | Pior perda |
|---|---:|---:|---:|---:|---:|
| Gamma Ladder V1 | 2057.57 | 263 | 7.81 | 49.99 | -34.40 |
| Edge Sniper V1 | 328.14 | 104 | 2.52 | 25.27 | -14.49 |

Observacao: o tuning tambem apontou concentracao alta nos maiores vencedores. Isso nao invalida o resultado, mas aumenta o risco de overfit; por isso a estrategia deve continuar sendo revalidada a cada novo bloco de dados.

---

## Defaults principais

| Parametro | Default | Motivo |
|---|---:|---|
| `walletSize` | 100 | Padrao das comparacoes locais. |
| `entryWindowStart` | 118 | Comeca depois de haver amostras suficientes do evento. |
| `entryWindowEnd` | 3 | Mantem entradas ate perto do fim quando ha edge. |
| `maxEntryValue` | 8 | Tamanho por tranche do Flux Sniper. |
| `maxEventExposure` | 36 | Limite de custo aberto por evento. |
| `maxEntriesPerEvent` | 8 | Permite escalar dentro de um evento forte. |
| `cooldownSec` | 8 | Evita comprar em cada tick. |
| `minAsk` | 0.035 | Permite convexidade barata sem aceitar micro-ask extremo. |
| `maxAsk` | 0.74 | Envelope amplo para capturar vencedores tardios. |
| `minEdge` | 0.055 | Exige 5.5pp de edge estimado. |
| `minDirectionalProb` | 0.57 | Evita entradas perto de 50/50. |
| `minDistanceAbs` | 25 | Aceita mais trades que a Gamma, mas evita zona colada no PTB. |
| `kellyFraction` | 0.22 | Sizing fracionado pelo edge estimado. |
| `maxKellyPct` | 0.20 | Limite por carteira. |
| `riskBudgetPct` | 0.45 | Perfil agressivo validado no periodo. |
| `maxWorstLossAbs` | 45 | Evita pior caso acima do envelope observado da Gamma. |
| `vaultBoxEnabled` | true | Mantem oportunidade de lucro travado quando existir. |
| `hedgeEnabled` | false | Desligado por default; reduziu resultado no tuning rapido. |
| `trapEnabled` | false | Desligado por default; gerou ruido e drawdown maior. |

---

## Como rodar

Via dashboard: selecione `Cofre Sete V1` no painel de Backtest.

Via API autenticada:

```bash
curl -X POST http://localhost:3000/api/backtest/cofre-sete \
  -H "Content-Type: application/json" \
  -d '{
    "from": "2026-05-04T14:00:00.000Z",
    "to": "2026-05-13T23:00:00.000Z"
  }'
```

Via runner direto:

```js
import { createCofreSeteBacktestRunner } from './src/services/cofreSeteBacktest.js';
import { getTicksForBacktestBatches } from './src/database.js';

const runner = createCofreSeteBacktestRunner({});
for await (const batch of getTicksForBacktestBatches(from, to, 25000)) {
  for (const tick of batch) runner.processTick(tick);
}
console.log(runner.finish().summary);
```

---

## Proximos testes recomendados

1. Rodar `mode=full` no script de tuning para buscar perfil com menor drawdown.
2. Comparar `wide-nohedge` contra um perfil `profit-factor` quando houver mais dias de base.
3. Revalidar concentracao dos maiores vencedores; se `top5ProfitShare` continuar alto, reduzir `maxAsk` ou aumentar `minEdge`.
4. Nao ativar `trapEnabled` em default sem nova validacao, porque o preset com trap ficou positivo, mas instavel.
