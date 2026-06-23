# Gamma Ladder V1 - Explicacao Didatica

Este documento explica a estrategia Gamma Ladder V1 de forma pratica e passo a passo.

Importante: no estado atual deste repositorio, a Gamma Ladder V1 e um backtest. Ela nao envia ordens reais para a Polymarket. Quando este texto fala em "enviar ordem", esta descrevendo como o backtest simula a execucao usando snapshots do book.

Se voce quiser a versao curta e mais tecnica, veja tambem `docs/gamma-ladder-v1.md`.

## 1. Ideia central em uma frase

A Gamma Ladder V1 tenta ganhar dinheiro de duas formas no mesmo evento de BTC Up/Down 5 minutos:

1. comprando UP e DOWN ao mesmo tempo quando a soma dos asks permite lucro travado
2. comprando varias vezes o lado que parece barato em relacao a uma probabilidade estimada pelo modelo

Em outras palavras, ela mistura uma camada "quase arbitragem" com uma camada direcional em escada.

## 2. O que significa "gamma ladder"

No codigo, o comportamento concreto e este:

1. a estrategia recalcula a probabilidade do lado vencedor a cada tick
2. ela compara essa probabilidade com o preco atual do contrato
3. se encontrar vantagem suficiente, entra no lado com maior edge
4. se a vantagem continuar aparecendo mais tarde no mesmo evento, ela pode adicionar outra entrada

O nome "ladder" vem exatamente desse comportamento de entrar em etapas, e nao em uma unica paulada.

## 3. Visao geral do ciclo de vida de um evento

Para cada mercado de 5 minutos, a estrategia segue sempre a mesma ordem:

1. detecta que um novo evento comecou
2. acumula amostras de BTC e do book para ter contexto
3. antes de pensar em novas entradas, gerencia o que ja estiver aberto
4. dentro da janela de entrada, tenta primeiro a entrada box
5. se nao houver box valido, tenta a entrada direcional
6. no vencimento, liquida tudo pelo lado vencedor do contrato

Esse detalhe da ordem importa muito: primeiro ela protege e administra a posicao existente, depois pensa em abrir novas posicoes.

## 4. O que ela observa em cada tick

Em cada snapshot, a estrategia olha principalmente para:

1. preco do BTC
2. `price_to_beat` do evento
3. melhor ask e melhor bid de UP
4. melhor ask e melhor bid de DOWN
5. niveis visiveis de asks dos dois lados
6. tempo restante ate o fim do evento

Com isso ela decide se existe edge estatistico, se o book esta liquido o suficiente e se o risco ainda cabe no limite do evento.

## 5. Como ela calcula a probabilidade

O motor probabilistico mistura duas leituras:

1. leitura estatistica do BTC em relacao ao PTB
2. leitura implicita do proprio mercado UP/DOWN

Formula simplificada:

`pFinal = modelWeight * pStat + (1 - modelWeight) * pMarket`

### 5.1 Componente estatistico

O componente estatistico responde a pergunta:

"Dado onde o BTC esta agora, o quanto ele esta acima ou abaixo do price to beat, qual a chance de terminar vencedor quando o evento fechar?"

Para isso, o modelo usa:

1. distancia atual entre BTC e PTB
2. volatilidade recente do BTC
3. momentum curto e momentum mais lento
4. tempo restante ate o vencimento

Ideia simplificada:

`pStat = Phi((distancia + drift) / sigma)`

Leitura intuitiva:

1. se o BTC ja esta bem acima do PTB, a chance de UP sobe
2. se o BTC esta bem abaixo do PTB, a chance de DOWN sobe
3. se a volatilidade esta muito alta, o modelo fica menos confiante
4. se o momentum recente ajuda o lado atual, a probabilidade sobe mais um pouco

O drift nao e liberado sem controle. Ele e travado por `driftClampSigma`, para evitar que um micro movimento recente distorca demais a previsao.

### 5.2 Componente de mercado

O componente de mercado vem do mid price de UP e DOWN.

Se o book implicar, por exemplo, que UP vale mais do que DOWN, isso entra como um voto a favor de UP. Assim a estrategia nao depende so do modelo estatistico; ela tambem respeita o que o mercado esta precificando.

### 5.3 Penalidade de odds ruins

Depois da mistura, o modelo ainda aplica uma penalidade quando a soma das odds fica fora de uma faixa considerada saudavel:

1. `askSum > maxOddsSum`
2. `askSum < minOddsSum`

Isso serve como filtro de sanidade. Se o mercado estiver muito desajustado, a estrategia reduz a confianca.

## 6. Primeira camada de entrada: Box

Antes de procurar uma aposta direcional, a estrategia sempre pergunta:

"Consigo comprar UP e DOWN juntos por menos de 1 e travar payout?"

Se sim, ela tenta a entrada box.

### 6.1 Regras para box

Ela so entra se tudo abaixo for verdadeiro:

1. `UP ask + DOWN ask <= boxMaxSumAsk`
2. lucro travado por par `>= boxMinProfit`
3. spreads dos dois lados aceitaveis
4. liquidez visivel suficiente nos asks de UP e DOWN
5. custo total dentro de `maxEntryValue` e `maxEventExposure`

O lucro travado por par e:

`lockedProfitPerPair = 1 - (upAsk + downAsk)`

Se a soma dos asks for 0.97, por exemplo, o lucro teorico travado por par e 0.03.

### 6.2 Como o tamanho do box e definido

Mesmo quando existe arbitragem aparente, a estrategia nao compra qualquer quantidade. Ela limita o tamanho usando o menor destes tetos:

1. `boxMaxPairValue`
2. `maxEntryValue`
3. `equityNow * maxKellyPct`
4. espaco restante ate `maxEventExposure`

Depois disso, ainda exige que a liquidez real visivel suporte a quantidade desejada.

### 6.3 Exemplo simples de box

Suponha:

1. UP ask = 0.47
2. DOWN ask = 0.50
3. soma = 0.97
4. lucro travado por par = 0.03

Se houver liquidez para 10 pares e o risco permitido suportar a operacao, a estrategia compra 10 UP e 10 DOWN.

Resultado teorico no vencimento:

1. um dos lados paga 1 por share
2. o outro lado vai a 0
3. como o custo combinado foi 0.97, sobra 0.03 por par

No papel, parece muito seguro. Na pratica, o proprio codigo reconhece a limitacao principal: snapshot de book nao garante fill simultaneo perfeito nos dois lados.

## 7. Segunda camada de entrada: Direcional em escada

Se o box nao estiver disponivel, a estrategia tenta a entrada direcional.

Ela nao escolhe um lado por intuicao. Ela monta candidatos, mede o edge e pega o melhor.

### 7.1 Filtros de elegibilidade

Um lado so entra na disputa se passar por estes filtros:

1. distancia minima entre BTC e PTB: `minDistanceAbs`
2. preco do contrato entre `minAsk` e `maxAsk`
3. probabilidade estimada `>= minDirectionalProb`
4. edge `>= minEdge`
5. spread `<= maxSpread`
6. soma de odds de UP e DOWN dentro da faixa saudavel

Aqui, edge e definido assim:

`edge = probabilidade estimada - ask`

Exemplo:

1. probabilidade estimada de UP = 0.68
2. ask de UP = 0.54
3. edge = 0.14

Como 0.14 e maior que o minimo padrao de 0.07, essa entrada pode ser aceita.

### 7.2 Por que ela e uma escada

A estrategia pode fazer mais de uma entrada no mesmo evento, desde que ainda haja vantagem e que os limites de risco deixem.

Os freios principais sao:

1. `maxEntriesPerEvent`
2. `cooldownSec`
3. `maxEventExposure`

Entao o fluxo e:

1. aparece edge forte, ela compra uma vez
2. alguns segundos depois, se o edge continuar e o cooldown tiver passado, ela pode comprar de novo
3. isso se repete ate o limite de entradas ou de exposicao

Ela nao usa martingale. O aumento de posicao depende de edge, liquidez e sizing, nao de recuperar prejuizo dobrando a mao.

## 8. Como o tamanho de cada entrada direcional e calculado

O tamanho usa uma versao conservadora de Kelly.

O codigo calcula primeiro um payoff teorico:

`winPayoff = (1 - ask) / ask`

Depois calcula uma Kelly bruta a partir da probabilidade estimada. Em seguida, reduz esse tamanho com dois freios:

1. `kellyFraction`, para usar apenas uma fracao da Kelly
2. `maxKellyPct`, para impedir que uma unica entrada use uma parte grande demais da carteira

No fim, o valor da entrada fica limitado por:

1. `maxEntryValue`
2. Kelly fracionario
3. espaco restante ate `maxEventExposure`

Traduzindo para portugues claro: mesmo quando o modelo gosta muito do trade, o tamanho continua pequeno e controlado.

## 9. Como as ordens sao simuladas

Esta e uma das partes mais importantes para entender o comportamento real do backtest.

### 9.1 Tipo de ordem nas compras

As compras de `box`, `directional` e `hedge` sao simuladas como compras agressivas com limite de preco.

Na pratica, o motor faz isto:

1. define um `maxFillPrice`
2. percorre os asks visiveis do book ate esse preco
3. consome quantidade nivel por nivel
4. calcula o preco medio real do fill

Isso se parece muito mais com uma ordem limite agressiva, ou uma ordem marketable limit, do que com uma ordem passiva esperando na fila.

Exemplo:

1. melhor ask = 0.54
2. `entrySlippageMax = 0.02`
3. preco maximo de fill = 0.56

Se o book tiver liquidez em 0.54, 0.55 e 0.56, a estrategia pode ser executada nesses niveis. Se so houver liquidez em 0.57, ela nao compra.

### 9.2 Tipo de ordem nas vendas

As saidas sao simuladas usando o bid atual do snapshot.

Ou seja, para parcial, trailing, stop ou saida final, o backtest assume que a estrategia consegue vender a quantidade desejada no bid exibido naquele tick.

Entao, em linguagem simples:

1. entradas = compra agressiva no ask com teto de preco
2. saidas = venda imediata no bid do snapshot

Nao existem no modelo:

1. ordem passiva maker esperando fila
2. cancelamento e reposicionamento de ordens
3. fila real do CLOB
4. latencia real de ida e volta

### 9.3 Como o codigo evita contar a mesma liquidez duas vezes

O backtest guarda quanto de cada nivel de ask ja foi consumido em `consumedAsksBySide`.

Isso reduz uma distorcao comum em simuladores: comprar varias vezes no mesmo snapshot como se o mesmo lote ainda estivesse inteiro disponivel.

## 10. Como o risco e gerenciado

O gerenciamento de risco esta espalhado pela estrategia inteira. Nao existe um unico interruptor; existem varias camadas.

### 10.1 Risco de contexto

Ela evita entrar cedo demais ou tarde demais usando:

1. `entryWindowStart = 105`
2. `entryWindowEnd = 4`
3. `minTicksBeforeEntry = 8`

Interpretacao:

1. ela nao entra logo no comeco do evento
2. ela tambem evita abrir posicao quase em cima do fechamento
3. exige algumas observacoes antes de confiar no modelo

### 10.2 Risco de preco ruim

Ela filtra contratos ruins ou caros demais com:

1. `minAsk` e `maxAsk`
2. `maxSpread`
3. `minEdge`
4. `minDirectionalProb`
5. `minDistanceAbs`

Isso evita comprar qualquer contrato so porque o BTC esta do lado "certo" do PTB. O contrato precisa ainda estar barato o suficiente para valer a pena.

### 10.3 Risco de liquidez

Ela exige book suficiente com:

1. `minLiquidityRatio`
2. leitura dos asks visiveis por nivel
3. consumo progressivo de book

Se a liquidez visivel nao suporta a maior parte da quantidade desejada, a ordem nao acontece.

### 10.4 Risco de tamanho

Os limites principais de tamanho sao:

1. `maxEntryValue`
2. `maxEventExposure`
3. `maxEntriesPerEvent`
4. `cooldownSec`
5. `kellyFraction`
6. `maxKellyPct`

Essa combinacao impede que a estrategia concentre demais o risco em um unico evento.

## 11. Como ela sai da posicao

Depois que uma posicao existe, o codigo passa a monitorar cinco mecanismos de saida.

### 11.1 Parcial de lucro

Se o bid atingir `takeProfitBid`, a estrategia tenta vender uma parte da posicao:

1. gatilho padrao: bid >= 0.88
2. tamanho padrao: `takeProfitPct = 0.40`

Ela so executa se a quantidade parcial ainda for pelo menos `minShares`.

### 11.2 Trailing stop

Quando o contrato ja subiu bem, a estrategia protege parte do ganho.

Regras padrao:

1. o bid precisa ter atingido pelo menos `trailAfterBid = 0.74`
2. se depois disso cair `trailDrop = 0.14` a partir do maximo, sai tudo

Isso deixa o trade respirar, mas nao devolve um ganho grande inteiro.

### 11.3 Stop por deterioracao

O stop mais defensivo usa duas condicoes juntas:

1. bid muito baixo, abaixo de `stopBid`
2. edge para o bid pior que `edgeExitBelow`

Nao e um stop cego so por preco. Ele exige que o modelo tambem tenha piorado.

### 11.4 Edge fade com lucro

Se o bid ainda esta acima do preco medio de entrada, mas o edge desapareceu, a estrategia pode sair mesmo sem stop duro.

Ideia: se a tese enfraqueceu e ainda da para sair no verde, melhor reduzir o risco.

### 11.5 Late exit

Perto do fim do evento, ela tenta simplificar risco.

Padrao:

1. faltam `lateExitSec = 8` segundos ou menos
2. se o bid estiver acima de `lateExitMinBid = 0.62`, ela vende

Isso serve para evitar ficar totalmente refem do settlement quando ainda existe um bid razoavel.

## 12. Como o hedge funciona

Quando `hedgeEnabled` esta ligado, a estrategia pode comprar o lado oposto para travar lucro.

Ela so faz isso se:

1. o ask do lado oposto estiver abaixo de `hedgeMaxAsk`
2. a diferenca entre os lados justificar o hedge
3. o lucro travado esperado for maior que `hedgeMinLockedProfit`
4. ainda houver exposicao disponivel no evento

Esse hedge nao e para salvar trade perdido. Ele e para transformar vantagem aberta em payout mais travado quando o preco do lado oposto ainda deixa isso valendo a pena.

## 13. Exemplo didatico completo de uma entrada direcional

Exemplo simplificado:

1. faltam 40 segundos para o fim do evento
2. PTB = 103000
3. BTC = 103090
4. modelo estima `pUp = 0.68`
5. book de UP: ask 0.54, bid 0.52
6. book de DOWN: ask 0.48, bid 0.46

### Passo 1: verificar se box existe

`0.54 + 0.48 = 1.02`

Como 1.02 e maior que `boxMaxSumAsk = 0.985`, nao existe box interessante. A estrategia vai para a camada direcional.

### Passo 2: medir edge de UP

`edgeUp = 0.68 - 0.54 = 0.14`

Como 0.14 passa com folga o minimo padrao de 0.07, UP vira candidato valido.

### Passo 3: conferir spread

`spreadUp = 0.54 - 0.52 = 0.02`

Como 0.02 e menor que `maxSpread = 0.10`, o spread esta saudavel.

### Passo 4: definir preco maximo de execucao

Com `entrySlippageMax = 0.02`, o backtest aceita comprar ate 0.56.

### Passo 5: definir quantidade

Suponha que o sizing resulte em aproximadamente 12 shares. Se houver liquidez suficiente entre 0.54 e 0.56, a ordem e executada.

Suponha fill medio em 0.55:

1. quantidade = 12
2. custo total = 6.60

### Passo 6: acompanhar a posicao

Mais tarde o bid sobe ate 0.78. A estrategia guarda esse pico como `maxBid`.

Depois o bid recua para 0.63.

Como:

1. o bid ja passou de `trailAfterBid = 0.74`
2. a queda desde o maximo foi `0.78 - 0.63 = 0.15`
3. `0.15` e maior que `trailDrop = 0.14`

o trailing dispara e vende o restante da posicao.

PnL aproximado:

`(0.63 - 0.55) * 12 = 0.96`

## 14. Exemplo didatico de box

Agora um exemplo rapido da outra perna da estrategia:

1. UP ask = 0.46
2. DOWN ask = 0.50
3. soma = 0.96
4. lucro travado por par = 0.04

Se a estrategia comprar 8 pares:

1. custo total = `8 * 0.96 = 7.68`
2. payout final garantido no modelo = `8 * 1.00 = 8.00`
3. lucro teorico = 0.32

Novamente: isso e o que o backtest modela se os fills ocorrerem como o snapshot sugere.

## 15. Como o evento termina e o PnL final e calculado

No vencimento:

1. o codigo identifica se UP venceu ou se DOWN venceu olhando BTC vs PTB
2. toda share restante do lado vencedor vale 1
3. toda share restante do lado perdedor vale 0
4. o PnL final do evento soma resultado de expiracao + vendas parciais + trailing + stop + hedge

Se a estrategia nao entrou no evento, ele fica registrado como `no_entry`.

## 16. O que a estrategia faz bem

Os pontos fortes da arquitetura sao:

1. mistura edge estatistico com informacao do proprio mercado
2. tenta box antes da aposta direcional
3. evita martingale
4. usa varios limites pequenos de risco em vez de um unico freio bruto
5. tem multiplas formas de reduzir risco antes do settlement

## 17. O que ela nao modela perfeitamente

As principais limitacoes do backtest sao:

1. snapshot de book nao garante fill real
2. nao existe simulacao de fila maker
3. saidas no bid podem ser otimistas em books finos
4. box depende de simultaneidade dificil de reproduzir ao vivo
5. parametros bons em historico ainda podem estar sobreajustados

## 18. Resumo final em portugues bem simples

Se eu tivesse que explicar a Gamma Ladder V1 para alguem em 30 segundos, eu diria isto:

1. ela observa BTC, PTB e book do mercado
2. tenta primeiro uma compra dos dois lados quando a conta fecha com lucro travado
3. se isso nao existir, compra o lado que o modelo considera barato
4. pode repetir a compra em escada, mas sempre com limites pequenos
5. depois administra a posicao com parcial, trailing, stop, late exit e hedge
6. se nada acontecer antes, no fim do evento o contrato e liquidado pelo lado vencedor

Essa e a ideia principal: aumentar o numero de oportunidades por evento sem perder o controle do risco.