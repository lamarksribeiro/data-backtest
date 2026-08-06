# Early Favorite Rush — auditoria causal e canônica

**Data:** 2026-08-05  
**Status:** **REJEITADA / HOLD**  
**Escopo decisório:** BTC 5m com settlement canônico. Os outros ativos permanecem exploratórios porque o dump local usa o último tick como proxy de outcome.

## Decisão

A taxa de acerto alta era real como aparência, mas não como edge econômico. O backtest original percorria o evento do settlement para o início e selecionava um recuo/recruzamento futuro como se fosse o “primeiro toque”. Corrigida a direção temporal e aplicado o settlement canônico BTC, a estratégia perde antes das taxas, depois das taxas, no treino e no holdout.

O stop reduz algumas perdas, mas não transforma uma entrada negativa em estratégia positiva. **Não promover para shadow operacional ou live e não dimensionar capital pelos resultados antigos.**

## Falhas encontradas

1. **Lookahead na entrada:** os ticks chegam em `tau DESC` (início → settlement), mas `firstCross`/`findEntry` iterava do fim para o começo.
2. **Outcome não canônico:** em 24.975 entradas BTC cobertas, o proxy do último tick divergiu do settlement oficial em **505 (2,02%)**.
3. **Win rate confundido com EV:** comprar a 85¢ com payout 0,995 e taxa taker exige aproximadamente **86,32%** de acerto; o canônico realizou **84,96%**.
4. **Stops avaliados sobre uma entrada contaminada:** os relatórios anteriores de salvage, TP e reward/risk herdaram o lookahead.
5. **Capital infinito implícito:** o replay continuava apostando US$10 depois de o saldo já não financiar a próxima entrada.

## Evidência principal — BTC canônico

Fonte: `scratch/canonical-outcomes-v1.csv`, 2026-04-23 a 2026-07-30. Foram usados 25.313 eventos canônicos, zero outcomes proxy e recusados 1.222 eventos sem settlement canônico.

| Regra causal | Trades | Win | PnL pré-taxa | Taxas | PnL líquido | PF | MaxDD | Dias+ | Train | Holdout |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1º toque ≥85¢, τ≥120s, spot concorda | 14.813 | 84,96% | **−US$1.911,68** | US$1.488,29 | **−US$3.399,97** | 0,849 | US$3.485,63 | 25,00% | −US$2.281,02 | −US$1.118,95 |
| 1º toque ≥90¢, τ≥120s, spot concorda | 10.794 | 90,09% | **−US$852,87** | US$728,76 | **−US$1.581,62** | 0,853 | US$1.680,91 | 28,85% | −US$753,08 | −US$828,54 |

Subir o preço aumenta a taxa de acerto e também o break-even. Nenhuma célula de threshold × tempo ficou líquida positiva e estável.

| Célula menos ruim | Trades | Win | Pré-taxa | Taxa | Líquido | Train | Holdout |
|---|---:|---:|---:|---:|---:|---:|---:|
| 87¢ em 10–30s | 1.804 | 89,47% | +US$71,53 | US$142,53 | **−US$71,00** | −US$164,64 | +US$93,63 |
| 95¢ em 120–150s | 2.492 | 95,55% | +US$1,34 | US$86,11 | **−US$84,76** | −US$88,31 | +US$3,54 |
| 92¢ em 3–10s | 1.596 | 93,98% | −US$24,81 | US$70,31 | **−US$95,12** | −US$110,71 | +US$15,59 |

As células pré-taxa levemente positivas não têm margem para taxa, slippage ou erro de fill e mudam de sinal entre treino e holdout.

## Stop: falsos stops versus salvage

Comparação no subconjunto causal BTC 85¢/τ≥120/spot, com venda taker no bid e taxa na saída. O teste temporal começa em 2026-07-02.

| Defesa | PnL total | Δ vs hold | Saídas | Falsos | Falso/saídas | PnL teste | Δ teste |
|---|---:|---:|---:|---:|---:|---:|---:|
| Hold | −US$3.395,51 | — | 0 | 0 | — | −US$1.229,86 | — |
| Atual: bid≤25¢, τ≤120s, spot+book viraram | −US$3.141,84 | +US$253,67 | 2.265 | 358 | **15,81%** | −US$1.193,27 | +US$36,59 |
| Confirmado: bid≤25¢, τ≤60s, persistência ~2s | −US$3.255,55 | +US$139,96 | 1.900 | 221 | **11,63%** | −US$1.244,84 | **−US$14,98** |
| `z≤−2,0` dinâmico | −US$3.268,02 | +US$127,49 | 1.735 | 141 | **8,13%** | −US$1.210,18 | +US$19,68 |

Reduzir falso-stop isoladamente não é suficiente: a confirmação e o `z` saem mais tarde, recebem bid pior e perdem salvage. O stop atual melhora modestamente o agregado, mas o teste continua fortemente negativo. Nenhum stop é aprovado.

O pior trade permanece aproximadamente **−US$10,105**; nem todo desastre oferece uma saída executável antes do settlement.

## Challengers rejeitados

- **Gate terminal `τ≤30s & z≥1,25`:** +US$80,88 treino, +US$10,95 validação e **−US$77,78 teste canônico BTC**.
- **Modelo logístico causal BTC:** AUC 0,552 treino, 0,537 validação e **0,500 teste**; sem poder preditivo estável.
- **Hedge no underdog:** hedge adicional de 10% reduz o pior trade de −US$10,105 para −US$9,197, mas piora o PnL total para **−US$5.233,67**.
- **Multiasset:** com outcomes proxy, as regras operáveis causais já fizeram 77.821 entradas, PnL −US$20.316,84, PF 0,825 e holdout −US$5.324,76. Isso é corroborativo, não promovível.

## Bankroll finito

Com aposta fixa de US$10 e sem nova entrada quando o saldo fica abaixo do custo:

| Inicial | Trades até shortfall | Data | Saldo |
|---:|---:|---|---:|
| US$100 | 628 | 2026-05-01 | US$7,68 |
| US$210 | 1.952 | 2026-05-09 | US$5,55 |
| US$500 | 3.174 | 2026-05-16 | US$9,08 |
| US$1.000 | 4.683 | 2026-05-26 | US$1,94 |

O capital infinito mascara insolvência. Um bankroll de ~US$3,5 mil apenas atravessa a curva histórica e termina perto de US$104 no subconjunto reconstituído; isso não valida a estratégia.

## A melhoria correta

A melhoria defensável é um **gate causal-canônico que sabe não operar**:

### Ataque

1. Primeiro cruzamento apenas em ordem causal e sem rearmar em recross posterior.
2. Outcome canônico obrigatório para backtest decisório.
3. Preço executável, profundidade, taxa e slippage entram no break-even.
4. Só promover uma entrada se o limite inferior do IC do win rate superar o break-even líquido em treino, validação e OOS congelado.

Hoje nenhuma regra passa o item 4; a ação correta é **zero entradas**.

### Defesa

1. O stop permanece challenger de pesquisa, não correção aprovada.
2. Notional por evento e bankroll finito devem estar no runner.
3. Próxima hipótese permitida: maker/passive em shadow, porque poucas células são levemente positivas pré-taxa. Ela exige prints, fila, cancelamento e fill medidos; tocar o book não conta como fill.

## Implementação e reprodução

- Detector causal: `src/research/earlyFavoriteRush.js`
- Regressão: `tests/earlyFavoriteRush.test.js`
- Runner auditado: `scratch/multi-asset-early-fav-rush.mjs`
- Extrator: `scratch/efr-extract-features.mjs`
- Relatório máquina: `.tmp/early-fav-causal-canonical-btc.json`

```powershell
node scratch/multi-asset-early-fav-rush.mjs --assets=BTC --no-doc --out=.tmp/early-fav-causal-canonical-btc.json
node --test tests/earlyFavoriteRush.test.js
```

## Medido, inferido e desconhecido

- **Medido:** ticks locais, cruzamento causal, settlement canônico BTC, taker no ask/bid, taxas, PnL pré/pós-taxa, PF, drawdown, stop e shortfall.
- **Inferido:** os seis ativos sem settlement canônico local; servem apenas para triagem negativa.
- **Desconhecido:** fill/latência real, fila maker, slippage além do top of book, outcomes canônicos dos outros ativos e período posterior a 2026-07-30.

**Gate final:** `REJECTED / HOLD`. Pesquisa não autoriza ordem real, mudança de `.env`, canary ou micro-live.
