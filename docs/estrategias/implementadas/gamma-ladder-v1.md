# Gamma Ladder V1

Gamma Ladder V1 e uma estrategia de backtest para o mercado BTC Up/Down 5 minutos da Polymarket. Ela combina duas fontes de vantagem:

1. **Box arbitrage**: compra UP e DOWN no mesmo evento quando a soma dos asks permite payout travado maior que o custo.
2. **Ladder direcional**: faz multiplas entradas no lado com maior edge estimado, limitado por exposicao, cooldown, liquidez visivel e Kelly fracionario.

O objetivo e aumentar a quantidade de entradas por evento sem depender de martingale. A estrategia so aumenta posicao quando o preco do contrato esta abaixo da probabilidade estimada de expirar vencedor.

## Modelo Probabilistico

A probabilidade de UP mistura estatistica de preco e odds implicitas do mercado:

`pFinal = modelWeight * pStat + (1 - modelWeight) * pMarket`

Onde:

- `pStat` vem de uma aproximacao normal usando distancia BTC-PTB, volatilidade realizada e drift de momentum curto.
- `pMarket` vem do mid de UP e DOWN no book.
- O modelo aplica penalidade quando a soma das odds fica fora da faixa saudavel (`minOddsSum`/`maxOddsSum`).

A parte estatistica usa a ideia:

`pStat = Phi((btc - ptb + drift * T) / sigma(T))`

Com drift limitado por `driftClampSigma`, para evitar extrapolar movimentos recentes demais.

## Entradas

### Box

A entrada box e tentada antes da direcional. Ela exige:

- `UP ask + DOWN ask <= boxMaxSumAsk`
- lucro travado por par acima de `boxMinProfit`
- liquidez visivel suficiente dos dois lados
- custo dentro de `boxMaxPairValue` e `maxEventExposure`

No vencimento, um dos lados paga 1. Se ambos foram comprados abaixo de 1 no total, o lucro fica estruturalmente travado no backtest.

### Direcional

A entrada direcional exige:

- distancia minima entre BTC e PTB (`minDistanceAbs`)
- probabilidade minima (`minDirectionalProb`)
- edge minimo (`probabilidade - ask >= minEdge`)
- spread maximo (`maxSpread`)
- liquidez visivel acima de `minLiquidityRatio`
- cooldown entre entradas (`cooldownSec`)
- maximo de entradas por evento (`maxEntriesPerEvent`)

O tamanho usa Kelly fracionario com teto:

- `kellyFraction` reduz agressividade
- `maxKellyPct` limita uso da carteira
- `maxEntryValue` limita cada entrada
- `maxEventExposure` limita o evento inteiro

## Saidas e Hedge

A estrategia pode:

- vender parcial quando o bid atinge `takeProfitBid`
- sair por trailing depois de `trailAfterBid`
- cortar posicao quando bid e edge deterioram juntos
- sair perto do fim se `lateExitMinBid` estiver disponivel
- comprar o lado oposto para travar lucro quando `hedgeMinLockedProfit` for respeitado

No vencimento, o PnL soma todo inventario restante de UP e DOWN com payout do lado vencedor.

## Endpoint

`POST /api/backtest/gamma-ladder`

A rota exige cookie de sessao, como os demais endpoints privados da API.

Exemplo:

```json
{
  "from": "2026-04-23T00:39:24.755Z",
  "to": "2026-05-14T14:32:08.944Z",
  "walletSize": 100,
  "minEdge": 0.07,
  "minDirectionalProb": 0.60,
  "maxEntriesPerEvent": 6
}
```

## Tuning

Comando rapido:

```powershell
node scripts/tune-gamma-ladder.js --from 2026-04-23T00:39:24.755Z --to 2026-05-14T14:32:08.944Z --folds 4 --mode quick --min-entries 300 --top 10
```

Comando mais amplo:

```powershell
node scripts/tune-gamma-ladder.js --from 2026-04-23T00:39:24.755Z --to 2026-05-14T14:32:08.944Z --folds 4 --mode full --min-entries 300 --top 15
```

O leaderboard penaliza:

- entradas abaixo do minimo configurado
- folds negativos
- drawdown alto
- lucro concentrado em poucos eventos

## Criterio de Promocao

Um preset so deve ser promovido para paper trading se:

- superar o Edge Sniper default no mesmo periodo ou em score ajustado
- tiver profit factor acima de 2
- mantiver drawdown controlado
- produzir mais entradas que o Edge Sniper sem concentrar o lucro em poucos eventos
- vencer em folds cronologicos, nao apenas no periodo completo

## Riscos

- Snapshots de book nao garantem fill simultaneo real em box arbitrage.
- O backtest usa liquidez visivel historica, mas nao modela fila de ordens.
- Parametros vencedores no dump podem estar superajustados; por isso o walk-forward e obrigatorio.
- Antes de ordens reais, rode paper trading e compare fills simulados contra fills plausiveis no CLOB.
