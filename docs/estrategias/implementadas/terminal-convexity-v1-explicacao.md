# Terminal Convexity V1 - Explicacao Didatica

Este documento explica a estrategia Terminal Convexity V1 de forma simples, pratica e passo a passo.

Importante: no estado atual deste repositorio, a Terminal Convexity V1 e um backtest. Ela nao envia ordens reais para a Polymarket. Quando este texto fala em "enviar ordem", esta descrevendo como o backtest simula a execucao usando snapshots do book.

Se voce quiser a versao curta e mais tecnica, veja tambem `docs/terminal-convexity-v1.md`.

## 1. Ideia central em uma frase

A Terminal Convexity V1 tenta comprar, no fim do evento, o lado que ja esta moderadamente na frente do `price_to_beat` quando o ask ainda esta abaixo do valor que o modelo considera justo.

Traduzindo para portugues claro:

1. ela nao quer adivinhar a direcao no comeco
2. ela espera o mercado entrar nos segundos finais
3. ela procura um lado que ja esta com vantagem no BTC
4. ela so compra se o preco ainda parecer barato em relacao a chance estimada pelo modelo

Aqui, "comprar barato" nao quer dizer comprar o lado que caiu mais ou o lado que esta perdendo. Quer dizer comprar um contrato cujo preco esta abaixo da probabilidade que o modelo estima para ele.

Exemplo rapido:

1. se o modelo acha que UP deveria valer `0.46`
2. e o ask de UP esta em `0.34`
3. esse UP esta barato para o modelo

Ou seja, barato aqui e uma ideia de valor relativo, nao uma ideia de "voltou demais, entao deve reverter".

## 2. O que significa "convexidade terminal"

O nome parece complicado, mas a ideia e simples.

Perto do vencimento, o tempo passa a ter muito peso. Se faltam poucos segundos e o BTC ja esta alguns dolares acima do PTB, o simples fato de o relogio andar sem grande reversao ja ajuda muito o lado UP. O mesmo vale para DOWN quando o BTC esta abaixo do PTB.

Entao a estrategia tenta explorar exatamente isso:

1. um lado ja esta na frente
2. falta pouco tempo
3. o book ainda oferece esse lado por um ask que o modelo considera barato

Perceba a direcao da aposta: ela compra o lado que ja esta favorecido naquele momento. Se o BTC esta acima do PTB, ela pode comprar UP. Se o BTC esta abaixo do PTB, ela pode comprar DOWN. Ela nao entra no lado atrasado esperando uma virada heroica.

Ela nao compra porque "acha bonito" o grafico. Ela compra porque o contrato ainda pode estar subprecificado no trecho final do evento.

## 3. Visao geral do ciclo de vida de um evento

Para cada mercado BTC Up/Down de 5 minutos, a estrategia segue esta ordem:

1. identifica que um novo evento comecou
2. guarda amostras recentes de preco do BTC e do book
3. quando o evento esta perto do fim, calcula candidatos para UP e DOWN
4. aplica filtros de risco e de qualidade do book
5. escolhe o melhor lado elegivel
6. simula uma compra agressiva com limite de preco
7. se o lado cruzar contra o PTB, pode sair antes do vencimento
8. se nao houver saida antecipada, segura ate o settlement

Tem um detalhe importante: ela entra no maximo uma vez por evento na configuracao promovida. Ou seja, nao fica piramidando e nem dobrando a mao varias vezes.

## 4. O que ela observa em cada tick

Em cada snapshot, a estrategia olha principalmente para:

1. preco atual do BTC
2. `price_to_beat` do evento
3. tempo restante ate o vencimento
4. melhor ask e melhor bid de UP
5. melhor ask e melhor bid de DOWN
6. niveis de asks disponiveis no book
7. comportamento recente do BTC nos ultimos segundos

Com isso ela tenta responder duas perguntas:

1. qual lado parece estar barato em relacao a probabilidade estimada?
2. existe liquidez boa o bastante para entrar sem assumir fill magico?

## 5. Como ela estima a chance de UP ou DOWN ganhar

O modelo interno usa quatro ideias ao mesmo tempo:

1. distancia do BTC em relacao ao PTB
2. tempo restante
3. volatilidade recente
4. momentum recente do BTC

### 5.1 Distancia em relacao ao PTB

Para cada lado, ela transforma a distancia em um numero com sinal:

1. para UP, estar acima do PTB e bom
2. para DOWN, estar abaixo do PTB e bom

Entao:

1. se o BTC esta $32 acima do PTB, UP tem `signedDistance = +32`
2. no mesmo caso, DOWN teria `signedDistance = -32`

Esse e o primeiro ingrediente da leitura.

### 5.2 Volatilidade recente

Depois a estrategia mede o quanto o BTC andou recentemente. Se o mercado esta muito nervoso, o modelo fica menos confiante porque ainda pode haver reversao. Se o mercado esta mais comportado, a vantagem atual pesa mais.

Na pratica:

1. mais volatilidade aumenta o `sigma`
2. `sigma` maior dilui a confianca
3. `sigma` menor deixa a distancia atual valer mais

### 5.3 Drift ou impulso recente

O modelo tambem olha movimento rapido e movimento um pouco mais lento.

Ideia simples:

1. se UP esta na frente e o BTC ainda esta andando para cima, isso ajuda UP
2. se UP esta na frente mas o BTC esta devolvendo forte, o modelo reduz a confianca

Esse drift nao fica solto. O codigo limita o quanto ele pode influenciar para evitar exagero por causa de um micro movimento.

### 5.4 Probabilidade final do modelo

Depois disso, a estrategia monta uma probabilidade estimada para cada lado.

Voce nao precisa decorar a formula, mas a leitura intuitiva e esta:

1. distancia maior a favor do lado aumenta a probabilidade
2. menos tempo restante aumenta o peso dessa distancia
3. volatilidade maior reduz a confianca
4. momentum favoravel ajuda um pouco

## 6. O que ela chama de edge

Depois de calcular a probabilidade do modelo, a estrategia compara essa chance com o ask do contrato.

Esse e o ponto principal para entender "comprar barato".

Barato, para esta estrategia, significa isto:

1. o modelo enxerga uma chance maior do que o preco implicito no ask
2. entao o contrato esta mais barato do que o valor que o modelo atribui a ele

Nao significa isto:

1. o contrato caiu bastante
2. o lado esta perdendo
3. entao vale comprar esperando reversao

Formula simples:

`modelEdge = probabilidade_do_modelo - ask`

Exemplo:

1. o modelo acha que UP vale 0.46
2. o ask de UP esta em 0.34
3. o edge e `0.46 - 0.34 = 0.12`

Como a configuracao promovida exige `minModelEdge = 0.08`, esse exemplo passaria nesse criterio.

Agora um contraexemplo importante:

1. o BTC esta $32 acima do PTB
2. UP provavelmente e o lado favorecido naquele instante
3. DOWN pode ate estar com ask baixo, por exemplo `0.10`
4. mas se o modelo achar que DOWN vale so `0.03`, entao `0.03 - 0.10 = -0.07`

Nesse caso, DOWN nao esta barato. Ele esta barato so no senso comum de "preco pequeno", mas esta caro em relacao a chance real estimada. A estrategia rejeita esse tipo de compra.

## 7. Como ela escolhe o lado

A estrategia avalia UP e DOWN no mesmo tick e monta um score para os candidatos.

Esse score aumenta quando:

1. o edge e maior
2. a convexidade terminal e maior
3. o mercado parece estar atrasado em relacao ao modelo
4. o spread e mais apertado

Em linguagem simples:

1. ela prefere o lado que parece mais barato
2. prefere momentos em que o tempo esta ajudando bastante
3. prefere book menos ruim para executar

Outra forma de dizer a mesma coisa: ela nao procura o lado mais amassado para tentar pegar rebote. Ela procura o lado que ja esta certo no momento e cujo contrato ainda nao subiu o suficiente.

Depois disso, ela ordena os candidatos e pega o melhor que passou em todos os filtros.

## 8. Filtros que precisam passar antes de entrar

Na variante promovida `tc-dist25-55-stop`, a entrada so acontece se o candidato passar por uma bateria de filtros.

### 8.1 Janela de tempo

Ela so considera entrada quando faltam entre 15 e 8 segundos para o fim do evento.

Por que isso existe:

1. cedo demais ainda tem muito tempo para reversao
2. tarde demais pode faltar book ou o movimento ja ter ido embora

### 8.2 Distancia ao PTB

O lado escolhido precisa estar entre `$25` e `$55` a favor do PTB.

Leitura:

1. menos que isso pode ser vantagem fraca demais
2. mais que isso pode significar que o mercado ja precificou quase tudo ou que a relacao risco-retorno piorou

### 8.3 Faixa de preco do contrato

O ask precisa ficar entre `0.04` e `0.45`.

Isso evita dois extremos:

1. contrato barato demais que pode ser iliquido ou enganoso
2. contrato caro demais, que deixa pouco upside adicional

### 8.4 Spread

O spread precisa ser no maximo `0.14`.

Se o spread esta largo demais, o book e ruim para entrar e para sair.

### 8.5 Sanidade da soma dos asks

A soma de ask de UP e DOWN precisa ficar entre `0.82` e `1.20`.

Esse filtro serve como controle de qualidade do mercado observado. Se a soma estiver muito distorcida, o snapshot pode estar ruim para confiar.

### 8.6 Probabilidade minima e edge minimo

O lado tambem precisa cumprir:

1. `modelProbability >= 0.32`
2. `modelEdge >= 0.08`

Ou seja, nao basta estar na frente do PTB. O contrato ainda precisa parecer barato o bastante.

## 9. Como a ordem de compra e simulada

Esta e uma das partes mais importantes do entendimento.

Hoje, o laboratorio nao manda ordem real para a exchange. O que ele faz e simular uma compra agressiva com limite de preco.

### 9.1 Tipo de ordem

Na pratica, isso se parece com uma ordem limite agressiva, tambem chamada de marketable limit order.

O fluxo e este:

1. pega o melhor ask do lado escolhido
2. soma a tolerancia de slippage
3. define um preco maximo aceitavel de fill
4. percorre os asks do book ate esse teto
5. consome quantidade nivel por nivel

No default promovido:

1. `entrySlippageMax = 0.02`
2. `maxAsk = 0.45`
3. o preco maximo de fill vira `min(maxAsk, ask + 0.02)`

Exemplo rapido:

1. ask atual de UP = 0.34
2. slippage maximo = 0.02
3. preco maximo de fill = 0.36

Se o book tiver liquidez em 0.34, 0.35 e 0.36, a estrategia pode comprar nesses niveis. Se a liquidez so existir acima de 0.36, ela nao compra aquele excedente.

### 9.2 Como o tamanho da ordem e escolhido

O tamanho alvo nasce assim:

1. pega o menor valor entre `maxOrderValue` e o equity atual
2. divide esse valor pelo preco maximo de fill
3. arredonda para baixo em shares inteiras

Na variante promovida:

1. `maxOrderValue = 15`
2. `minShares = 5`

Exemplo:

1. valor maximo da ordem = $15
2. preco maximo de fill = 0.36
3. quantidade alvo = `floor(15 / 0.36) = 41` shares

Se essa conta der menos de 5 shares, a entrada e rejeitada.

### 9.3 Filtro de liquidez

Antes de consumir o book, a estrategia verifica se existe liquidez visivel suficiente ate o preco maximo de fill.

Ela usa `minLiquidityRatio = 0.55`.

Isso significa:

1. o book visivel precisa mostrar pelo menos 55% da quantidade alvo dentro do teto de preco
2. se nem isso existir, a entrada e cancelada

Detalhe importante: esse filtro nao exige 100% da quantidade alvo no snapshot. Ele exige um piso minimo de liquidez para evitar entrar em book fantasma. O fill final ainda pode sair parcial, desde que continue acima do minimo de shares.

### 9.4 Como o fill final e calculado

Depois da checagem de liquidez, o backtest consome os asks do book um por um.

Ele calcula:

1. `filledQty`
2. `totalCost`
3. `avgEntryPrice`

Se o custo total ficar dentro do limite e a quantidade final for razoavel, a posicao e aberta.

Em outras palavras: a estrategia nao assume que tudo saiu no melhor ask. Ela usa o book historico visivel para chegar ao preco medio de entrada.

## 10. Como a estrategia gerencia o risco

O gerenciamento de risco aparece em varias camadas ao mesmo tempo.

### 10.1 Risco por selecao de contexto

Ela nao entra em qualquer momento. Ela exige:

1. segundos finais bem especificos
2. vantagem moderada e nao exagerada sobre o PTB
3. ask barato o suficiente
4. spread controlado
5. book minimamente saudavel

Isso reduz operacoes em ambiente confuso.

### 10.2 Risco por tamanho

Ela limita a ordem por valor.

No default:

1. cada evento usa no maximo $15
2. o valor tambem nao pode passar do equity disponivel
3. a compra e feita em shares inteiras

Traduzindo: mesmo quando o modelo gosta do trade, ele nao deixa uma unica aposta ficar grande demais.

### 10.3 Risco por liquidez e slippage

Ela so entra se houver liquidez visivel dentro do preco tolerado e so aceita pagar ate `ask + 0.02`, respeitando o teto geral de `0.45`.

Isso tenta evitar dois erros comuns:

1. achar que vai comprar barato onde nao existe tamanho real
2. perseguir o preco muito acima do ponto planejado

### 10.4 Risco por numero de entradas

Na configuracao usada como referencia, ela entra no maximo uma vez por evento.

Isso e importante porque:

1. evita aumentar exposicao no mesmo mercado varias vezes
2. impede comportamento parecido com martingale
3. torna a perda maxima por evento mais previsivel

### 10.5 Risco por stop de cruzamento

O default promovido usa `stopIfCrossed = true`.

O que isso quer dizer:

1. se a posicao comprada cruzar para o lado errado contra o PTB
2. e essa cruzada chegar a pelo menos `-2` dolares de distancia assinada
3. e ainda existir bid de pelo menos `0.04`
4. a estrategia vende antes do vencimento para reduzir o dano

Em codigo, isso e o `cross_stop`.

Exemplo intuitivo:

1. voce comprou UP porque o BTC estava $32 acima do PTB
2. depois o BTC cai e passa a ficar $2 abaixo do PTB
3. se ainda houver bid suficiente, a estrategia sai no bid corrente

Esse stop nao garante perda pequena, mas tenta evitar virar torcedor ate o settlement quando o lado perdeu a vantagem estrutural.

### 10.6 Perda maxima e assimetria do payoff

Se a estrategia compra um contrato por custo total de $14.31:

1. pior caso carregando ate o fim: perde os $14.31
2. melhor caso no settlement: recebe `qty - cost`

Isso cria uma assimetria simples:

1. a perda maxima e limitada ao custo pago
2. o ganho depende do numero de shares compradas menos esse custo

## 11. Como ela sai da posicao

Existem tres caminhos principais.

### 11.1 Stop por cruzamento

Esse e o principal no default promovido.

Se o lado comprado atravessa para o lado errado do PTB e ainda ha bid minimo, ela vende no bid atual do snapshot.

### 11.2 Profit exit opcional

O codigo tem uma variante com `profitExitBid`, por exemplo `0.85`, mas isso nao e a configuracao default promovida.

Se esse modo estiver ligado, a posicao pode ser encerrada antes quando o bid atinge o alvo.

### 11.3 Settlement no vencimento

Se nao houve saida antecipada, a estrategia segura ate o fim do evento.

No settlement do backtest:

1. se o lado comprado vencer, o PnL vira `qty - cost`
2. se perder, o PnL vira `-cost`

## 12. Exemplo completo e simples

Vamos montar um exemplo didatico com a variante `tc-dist25-55-stop`.

### 12.1 Contexto inicial

Suponha que faltam 10 segundos para o vencimento.

Dados do tick:

1. `price_to_beat = 103000`
2. `btc_price = 103032`
3. logo, UP esta `+32` dolares a frente do PTB
4. ask de UP = `0.34`
5. bid de UP = `0.30`
6. ask de DOWN = `0.67`
7. bid de DOWN = `0.63`

Leitura rapida:

1. faltam entre 15 e 8 segundos, entao esta dentro da janela
2. UP esta `+32`, entao esta dentro da faixa de `$25` a `$55`
3. ask de UP esta entre `0.04` e `0.45`
4. spread de UP e `0.04`, entao passa
5. ask sum e `0.34 + 0.67 = 1.01`, entao passa

Agora imagine que o modelo calculou:

1. `modelProbability = 0.46`
2. `modelEdge = 0.46 - 0.34 = 0.12`

Tambem passa no edge minimo.

### 12.2 Montagem da ordem

Com `entrySlippageMax = 0.02`, o teto de fill vira:

`maxFillPrice = min(0.45, 0.34 + 0.02) = 0.36`

Com `maxOrderValue = 15`, a quantidade alvo vira:

`targetQty = floor(15 / 0.36) = 41`

Agora imagine este book de asks de UP:

1. 20 shares a `0.34`
2. 15 shares a `0.35`
3. 12 shares a `0.36`

Como ha liquidez suficiente dentro do teto de preco, o backtest consome:

1. 20 a `0.34`
2. 15 a `0.35`
3. 6 a `0.36`

Resultado:

1. `filledQty = 41`
2. `totalCost = 20*0.34 + 15*0.35 + 6*0.36 = 14.21`
3. `avgEntryPrice = 14.21 / 41 = 0.3466`

### 12.3 O que pode acontecer depois

Cenario A, UP vence no settlement:

1. payout final = `41`
2. custo = `14.21`
3. PnL = `41 - 14.21 = +26.79`

Cenario B, o mercado cruza contra voce antes do fim:

1. o BTC cai e passa a ficar `-2` ou pior em relacao ao PTB para UP
2. existe bid de `0.06`
3. a estrategia aciona `cross_stop`
4. valor recuperado = `41 * 0.06 = 2.46`
5. PnL = `2.46 - 14.21 = -11.75`

Cenario C, UP perde e nao houve stop executavel:

1. o contrato expira sem valor
2. PnL = `-14.21`

Esse exemplo mostra bem a logica da estrategia:

1. risco limitado ao custo pago
2. tentativa de reduzir dano se a tese quebra antes do vencimento
3. ganho grande quando a leitura terminal estava certa e o contrato foi comprado barato

## 13. O que esta estrategia faz bem

Ela tende a funcionar melhor quando:

1. o mercado ainda demora alguns segundos para ajustar o ask do lado que ja esta na frente
2. o BTC nao reverte violentamente no trecho final
3. o book tem liquidez suficiente para executar perto do plano

## 14. Onde mora o risco real

Mesmo sendo uma ideia elegante, os riscos principais continuam existindo:

1. reversao brusca nos ultimos segundos pode destruir a vantagem
2. snapshot de book nao garante execucao real identica
3. holdout e amostras recentes podem ter menos trades, entao alguns vencedores grandes pesam bastante no resultado
4. se o book estiver atrasado ou com gaps, o backtest pode parecer melhor do que a vida real

## 15. Resumo final em portugues direto

Se eu tivesse que explicar a Terminal Convexity V1 em 5 linhas para alguem do time, eu diria isto:

1. ela espera os ultimos 15 a 8 segundos do evento
2. procura o lado que ja esta entre $25 e $55 a favor do PTB
3. so compra se o ask ainda estiver barato para a probabilidade estimada
4. entra com compra agressiva limitada por preco, valor maximo e liquidez visivel
5. se o lado cruza contra o PTB, tenta sair antes; se nao, leva ate o settlement

Essa e a forma mais simples de enxergar a estrategia: comprar assimetria boa no fim do evento, mas com filtros fortes para nao transformar vantagem estatistica em execucao irresponsavel.