# Dossiê integrado — TFC, Edge Sniper, Hopper 3 e Apex Triad V1

Data de corte: **2026-07-10**  
Mercado principal: **Polymarket BTC Up/Down de 5 minutos**  
Objetivo: consolidar evidências, limitações e critérios para eventual uso em conta real.  
Público: pesquisadores, desenvolvedores, revisores quantitativos e outras IAs.

> Este documento separa fatos medidos, inferências e hipóteses ainda não validadas. Os resultados são de backtest e não constituem garantia de retorno. Informações operacionais da Polymarket devem ser verificadas novamente antes de qualquer implantação, pois taxas, APIs e regras podem mudar.

## 1. Resumo executivo

Quatro componentes foram analisados:

1. **Terminal Favorite Carry — TFC:** referência terminal de menor complexidade relativa.
2. **Edge Sniper V2:** fonte do regime direcional antecipado e dos controles de payoff.
3. **Hopper 3 V1**, também chamada Hopper/Hopper Tree nas conversas: estratégia de equalização e reversão cuja lucratividade depende fortemente da hipótese Maker.
4. **Apex Triad V1:** candidata híbrida criada a partir da TFC, Edge Sniper e uma parcela limitada da disciplina de reversão da Hopper.

Conclusão principal:

- **Nenhuma estratégia está autorizada para produção plena em conta real.**
- A **TFC** deve permanecer como referência e seria a primeira candidata a um futuro micro-canário, depois de construída a infraestrutura real.
- A **Apex Triad V1** é promissora, mas continua `candidate`: aumentou PnL, frequência e profit factor contra uma TFC equivalente, porém piorou drawdown e não confirmou estatisticamente sua superioridade.
- A **Hopper 3 V1 não deve receber capital real no estado atual**. Ela passa de `+US$ 4.863,02` com Maker otimista para `-US$ 4.961,71` com execução taker honesta.
- O repositório atual é de pesquisa/backtest. Ele não possui um executor Polymarket/CLOB pronto para produção.

Classificação de prontidão:

| Estratégia | Estado de pesquisa | Shadow/forward | Micro-canário real | Produção plena |
| --- | --- | --- | --- | --- |
| TFC | Referência | Recomendada | Somente após infraestrutura e gates | Não autorizada |
| Apex Triad V1 | Candidate | Recomendada | Somente após novo forward e infraestrutura | Não autorizada |
| Edge Sniper V2 | Componente independente/histórico | Útil como controle | Não avaliada aqui para promoção isolada | Não autorizada |
| Hopper 3 V1 | Hipótese Maker não validada | Apenas pesquisa de execução | Não autorizada no formato atual | Não autorizada |

## 2. Escopo e definições

### 2.1 O que significa “resultado honesto” neste documento

Um resultado é chamado de honesto quando:

- consome o book histórico disponível;
- respeita profundidade, spread, slippage máximo e liquidez configurada;
- aplica a fórmula de taxa taker utilizada pelo projeto;
- não assume preenchimento Maker imediato sem fila, espera ou risco de não execução;
- mantém o preset congelado no período de validação/holdout.

Mesmo um backtest honesto ainda não modela perfeitamente:

- latência entre decisão, assinatura, envio e confirmação;
- posição real na fila;
- fills parciais assíncronos;
- rejeições e atrasos do matching engine;
- perda de WebSocket;
- clock drift;
- capital temporariamente reservado ou ainda não liquidado;
- seleção adversa de ordens Maker;
- falha entre as duas pernas de uma reversão.

### 2.2 Maker, taker e Post Only

Segundo a documentação oficial consultada em 2026-07-10:

- Makers não pagam a taxa de negociação da plataforma nos mercados com taxas.
- Takers pagam uma taxa que depende da categoria e do preço.
- Em crypto, o parâmetro atual é `0,07` na fórmula:

```text
fee = shares × 0,07 × price × (1 - price)
```

- `0,07` não significa cobrança linear de 7% do notional.
- Em `price = 0,50`, 100 shares pagam `US$ 1,75`, equivalentes a 3,5% dos `US$ 50` de notional.
- Uma ordem Post Only somente descansa no livro. Se fosse executar imediatamente, ela é rejeitada.
- Post Only é compatível com GTC/GTD, não com FOK/FAK.
- FOK executa integralmente ou cancela tudo; FAK aceita preenchimento parcial e cancela o restante.

Fontes oficiais:

- https://docs.polymarket.com/trading/fees
- https://docs.polymarket.com/trading/orders/create
- https://docs.polymarket.com/trading/orders/overview
- https://docs.polymarket.com/market-makers/trading

## 3. Dados e metodologia

### 3.1 Apex versus TFC

Janela contínua:

- ativo: BTC;
- intervalo: 5 minutos;
- book: depth 25;
- período: 2026-05-04 a 2026-07-05;
- eventos: 17.504;
- ticks por variante: aproximadamente 11,29 milhões;
- orçamento-base: US$ 10;
- carteira nominal configurada: US$ 100;
- taxas crypto aplicadas.

Separação temporal:

- treino/seleção: maio;
- validação: junho;
- holdout: 1 a 5 de julho.

Importante: maio foi utilizado para escolher parâmetros. Isso introduz selection bias e impede tratar todo o período como amostra totalmente fora do treinamento.

### 3.2 Hopper Maker versus taker

Janela:

- período: 59 dias, 2026-05-04 a 2026-07-01;
- eventos: 16.399;
- entradas registradas: 14.570;
- mesmo preset de sinais e sizing;
- variável principal do contrafactual: `simulateMaker=true` versus `simulateMaker=false`.

Esse teste mede o quanto o resultado depende do preço de execução assumido. Ele não prova que a execução Maker real produziria o resultado otimista.

## 4. Terminal Favorite Carry — TFC

### 4.1 Papel

A TFC é a referência terminal usada na comparação controlada da Apex. Ela procura o favorito perto do encerramento, com filtros de preço, spread, soma das odds, distância ao price-to-beat, velocidade do spot e order book imbalance.

Na configuração equivalente usada no experimento Apex:

- janela: 30s a 5s antes do encerramento;
- ask: 0,55 a 0,82;
- spread máximo: 0,03;
- orçamento: US$ 10;
- late flip/reversão: 8s a 4s;
- danger exit: piso de 4s;
- no máximo uma reversão no desenho da Apex.

### 4.2 Resultado da referência equivalente

| Métrica | TFC equivalente |
| --- | ---: |
| PnL líquido | US$ 4.192,77 |
| Entradas | 3.852 |
| Win rate | 74,45% |
| Profit factor | 1,545 |
| Drawdown contínuo | US$ 84,52 |
| Taxas | US$ 1.016,81 |
| Sharpe por evento | 0,18034 |
| Sortino por evento | 0,35134 |

### 4.3 Interpretação

A TFC teve PnL ligeiramente inferior ao da Apex, mas:

- drawdown menor;
- win rate maior;
- Sharpe e Sortino ligeiramente melhores;
- menor complexidade;
- menos dependência de um segundo regime de entrada.

Ela continua sendo a referência mais prudente para comparação. Isso não significa que esteja pronta para dinheiro real: a janela terminal é extremamente sensível a latência e falha de reversão.

## 5. Edge Sniper V2

### 5.1 Papel

A Edge Sniper tenta entrar antes da janela terminal quando:

- BTC está suficientemente distante do price-to-beat;
- a probabilidade direcional estimada excede o ask por um edge mínimo;
- spread e liquidez são aceitáveis;
- momentum, volatilidade e estabilidade direcional não invalidam a entrada.

Ela fornece à Apex:

- probabilidade direcional;
- comparação de edge contra o ask;
- momentum rápido e lento;
- lag do book;
- OBI no score;
- stop, trailing e late exit;
- redução de stake quando o ask está caro.

### 5.2 Diferença entre Edge Sniper canônica e módulo Edge da Apex

O módulo da Apex não é uma cópia literal do preset canônico da Edge Sniper. Na candidata final ele usa, entre outros:

- janela: 105s a 31s;
- distância mínima: 40;
- edge mínimo: 0,04;
- probabilidade direcional mínima: 0,54;
- orçamento: 0,75 × orçamento-base;
- ask acima de 0,52: novo corte de 50%;
- no máximo uma reversão.

Esses thresholds são mais permissivos do que alguns defaults documentados da Edge Sniper V2. A redução de stake é parte central da defesa contra essa maior frequência.

### 5.3 Limite da avaliação atual

Este dossiê não promove nem rejeita a Edge Sniper isoladamente. Seu papel principal aqui é explicar a origem do regime antecipado da Apex. A própria documentação da Edge Sniper afirma que ela não envia ordens reais.

## 6. Apex Triad V1

### 6.1 Arquitetura

A Apex combina dois regimes mutuamente exclusivos por evento:

1. **Edge antecipado:** 105s a 31s.
2. **TFC terminal:** 30s a 5s, somente se ainda não existe posição.

O desenho evita empilhar as duas entradas no mesmo evento. Foram mantidos:

- no máximo uma reversão;
- stop e trailing no regime Edge;
- late flip e danger exit no regime terminal;
- sizing reduzido no Edge;
- filtros de spread, liquidez, OBI e movimento do spot.

Foram deliberadamente rejeitados:

- martingale/escada completa da Hopper;
- dependência do `simulateMaker` da Hopper;
- múltiplas reversões;
- profit lock Maker como requisito de lucratividade.

### 6.2 Resultado contínuo

| Métrica | TFC equivalente | Apex 0,75 | Diferença |
| --- | ---: | ---: | ---: |
| PnL líquido | US$ 4.192,77 | **US$ 4.331,80** | +3,3% |
| Entradas | 3.852 | **4.262** | +10,6% |
| Win rate | **74,45%** | 73,42% | -1,04 pp |
| Profit factor | 1,545 | **1,561** | +1,0% |
| Drawdown | **US$ 84,52** | US$ 88,56 | +4,8% |
| Taxas | US$ 1.016,81 | US$ 1.083,23 | +6,5% |
| Sharpe por evento | **0,18034** | 0,17898 | pior |
| Sortino por evento | **0,35134** | 0,28287 | pior |
| Recovery factor | **49,61** | 48,91 | pior |

Métricas adicionais da Apex:

- wins: 3.129;
- losses: 1.133;
- PnL médio por entrada: US$ 1,016;
- ganho médio: US$ 3,852;
- perda média: US$ 6,815;
- maior perda observada por evento: US$ 18,046;
- volume: US$ 47.973,84;
- trades com taxa: 7.384;
- operações Maker gratuitas registradas: 0.

O break-even aproximado da taxa de acerto, usando ganho e perda médios, é:

```text
6,815 / (6,815 + 3,852) ≈ 63,89%
```

O win rate observado de 73,42% oferece uma margem de aproximadamente 9,53 pontos percentuais, mas essa margem pode ser reduzida por deterioração de execução e mudança de regime.

### 6.3 Separação temporal

| Split | TFC PnL | Apex PnL | Entradas TFC | Entradas Apex | DD TFC | DD Apex |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Treino — maio | 1.755,85 | **1.889,75** | 1.642 | **1.847** | **67,01** | 70,34 |
| Validação — junho | 2.198,47 | **2.215,45** | 1.862 | **2.052** | 76,39 | **69,58** |
| Holdout — 1–5 julho | **238,45** | 226,60 | 348 | **363** | **52,30** | 64,69 |

No holdout:

- a Apex teve 5/5 dias positivos;
- a referência teve 4/5;
- a Apex perdeu para a TFC em PnL, profit factor e drawdown;
- cinco dias são insuficientes para avaliar mudança de regime.

### 6.4 Evidência estatística

Comparação pareada por dia nos 63 dias:

- delta médio: +US$ 2,21/dia;
- delta mediano: +US$ 0,47/dia;
- 33 dias melhores, 28 piores e 2 empates;
- teste exato de sinais bilateral: `p = 0,609`;
- t estatístico pareado: `1,05`;
- moving-block bootstrap, blocos de 5 dias, 10.000 amostras;
- IC 95% do delta total: `[-US$ 139,24; +US$ 415,94]`;
- probabilidade bootstrap de delta médio positivo: `83,16%`.

Interpretação correta:

- a Apex apresentou uma vantagem observada;
- o intervalo inclui zero;
- o teste de sinais não rejeita igualdade;
- a superioridade contra a TFC **não está estatisticamente confirmada**;
- as 4.262 entradas não são 4.262 observações independentes, pois estão agrupadas em apenas 63 dias e poucos regimes;
- houve busca de parâmetros, portanto deve-se considerar múltipla experimentação/selection bias.

### 6.5 Maker profit lock

Foi testada uma tentativa conservadora de comprar o lado oposto via Maker para travar custo combinado inferior a 1. O experimento:

- elevou o win rate para aproximadamente 86%;
- cortou excessivamente os vencedores;
- levou PnL e profit factor para níveis ruins, incluindo PF abaixo de 1 em configurações relevantes.

O recurso permanece no código, mas está desativado no preset final. O resultado promovido da Apex não reivindica economia Maker.

### 6.6 Problema de sizing e interpretação da carteira

O preset declara:

```text
walletSize = 100
baseBudget = 10
```

Porém, a estratégia usa `baseBudget` diretamente nas entradas e não limita o orçamento à equity corrente. Consequências:

- o motor pode continuar simulando entradas sem uma verificação explícita de solvência da Apex;
- `walletSize` não funciona como uma carteira real com capital reservado;
- PnL acumulado de US$ 4.331,80 não deve ser interpretado como retorno realizável de 4.331,8% sobre US$ 100;
- o campo `finalWallet` do relatório também merece auditoria: no resultado final ele coincide com o PnL em vez de representar claramente `wallet inicial + PnL`.

Com carteira nominal de US$ 100:

- perda máxima observada de US$ 18,05 equivaleria a 18,05% da banca;
- drawdown de US$ 88,56 equivaleria a 88,56% da banca;
- esse sizing é incompatível com uma implantação prudente.

## 7. Hopper 3 V1

### 7.1 Arquitetura resumida

A Hopper procura equalizar o resultado por meio de entradas nos dois lados e reversões dimensionadas dinamicamente. O preset analisado contém:

- `walletSize = 100`;
- `pctWallet = 0,06`;
- `minShares = 10`;
- sizing dinâmico;
- `simulateMaker = true`;
- `maxFlipsAllowed = 1` no preset promovido;
- multiplicador-base de reversão `3`;
- multiplicadores maiores disponíveis na escada histórica;
- stop de 15 centavos em relação à média.

### 7.2 Comparação Maker otimista versus taker honesto

| Métrica | Maker otimista | Taker honesto |
| --- | ---: | ---: |
| Eventos | 16.399 | 16.399 |
| Entradas | 14.570 | 14.570 |
| Wins | 6.801 | 6.378 |
| Losses | 7.769 | 8.192 |
| Win rate | 46,68% | 43,77% |
| PnL | **+US$ 4.863,02** | **-US$ 4.961,71** |
| Profit factor | 1,294 | 0,717 |
| Drawdown | US$ 144,24 | US$ 223,34 |
| Taxas registradas | US$ 1.744,17 | US$ 3.629,69 |
| Dias positivos | 52/59 | 1/59 |
| Pior dia | -US$ 71,05 | -US$ 210,04 |

Conclusão: o sinal de PnL depende integralmente da hipótese de execução. Sem o preço Maker otimista, a estratégia é fortemente perdedora.

### 7.3 Falha do `simulateMaker`

No runner legado:

- compra Maker usa imediatamente `bid` como preço de execução;
- venda Maker usa imediatamente `ask`;
- a quantidade é registrada como preenchida no mesmo tick;
- não há posição na fila;
- não há espera;
- não há probabilidade de não preenchimento;
- não há fill parcial Maker;
- não há seleção adversa;
- não há cancelamento/repricing real.

Esse comportamento concede à estratégia, simultaneamente, o melhor lado do spread e certeza de execução. Isso não é alcançável de forma sistemática em um CLOB real.

### 7.4 Maker não é lucro gratuito

Uma ordem Maker pode economizar taxa, mas paga custos econômicos não explícitos:

- oportunidade perdida quando não executa;
- fill parcial;
- tempo na fila;
- necessidade de cancelar e reenviar;
- mudança de tick size;
- seleção adversa: maior chance de executar quando o preço justo se moveu contra a ordem;
- risco de execução de uma perna e falha da proteção.

Uma interpolação linear simplista entre os dois backtests sugeriria necessidade de aproximadamente 50,5% de execução “equivalente ao Maker ideal” apenas para cruzar o zero. Essa conta não é um critério válido de promoção, porque fills reais não são aleatórios: os fills recebidos podem ser os piores sinais e os não preenchidos podem ser os melhores.

### 7.5 Risco de reversão

O cálculo dinâmico contém um limite de:

```text
maxSharesLimit = equity × pctWallet × 20 / preço
```

Com `pctWallet = 6%`, o notional da reversão pode chegar aproximadamente a:

```text
equity × 0,06 × 20 = 1,20 × equity
```

Isso ocorre antes de considerar a posição já aberta. Em conta real, pode causar:

- ordem rejeitada por saldo;
- exposição combinada superior a 100% da banca;
- posição órfã;
- quebra do objetivo de equalização;
- perda de cauda muito maior que a sugerida pela média.

O preset limita a uma virada, mas uma única reversão ainda pode ser grande demais.

### 7.6 Erro/inconsistência na taxa usada pelo sizing

O cálculo de reversão do runner utiliza:

```js
const takerFeeRate = 0.0007; // descrito como 0,07%
```

A regra atual para crypto utiliza o parâmetro `0,07` dentro da fórmula não linear oficial. Portanto:

- o sizing interno não representa corretamente a taxa atual;
- o número de shares calculado para “recuperar” a posição pode estar incorreto;
- a divergência precisa ser corrigida e testada novamente antes de qualquer conclusão.

### 7.7 Anomalias de relatório da Hopper

O relatório legado também apresenta campos inconsistentes:

- `eventsWithEntries = 0` apesar de `totalEntries = 14.570`;
- `avgPnl = 0` apesar de PnL total não zero;
- cenário marcado como Maker registra US$ 1.744,17 em taxas.

Esses campos não invalidam automaticamente PnL e drawdown, mas indicam que a camada de métricas/fees do runner legado deve ser auditada antes de novos estudos.

### 7.8 Veredito da Hopper

A Hopper atual deve ser tratada como **hipótese de microestrutura**, não como estratégia vencedora pronta.

Ela só pode voltar a ser candidata após:

1. substituição do `simulateMaker` por modelo de fila/tempo/fill;
2. eliminação da reversão capaz de consumir mais de 100% da equity;
3. sizing baseado na fórmula real de taxas;
4. reconciliação de fills parciais;
5. forward test com book ao vivo;
6. experimento real mínimo de Post Only, com capital dispensável, exclusivamente para medir execução — não para buscar lucro.

## 8. Lacuna entre backtest e conta real

### 8.1 Estado atual do repositório

A inspeção encontrou uma infraestrutura de pesquisa/backtest, não um executor CLOB real.

Evidências:

- o runtime GLS importa e usa `createOrderSimulator`;
- `enter`, `exit`, `reverse`, `placeLimitBuy` e `cancelLimit` operam em objetos locais;
- ordens e fills são derivados do book histórico;
- não há SDK CLOB, signer Ethereum ou cliente WebSocket de negociação nas dependências principais;
- os heartbeats encontrados pertencem à aplicação/worker, não ao heartbeat de segurança da Polymarket;
- não há `cancelAll()` real da exchange;
- não há canal WebSocket de usuário para fills;
- não há reconciliação periódica de posição local versus exchange;
- documentação do projeto lista live trading, fila real e partial fill complexo fora do MVP.

Arquivos relevantes:

```text
src/backtestStudio/gls/runtime.js
src/backtestStudio/gls/orderSimulator.js
src/config.js
package.json
docs/implementacao/implementacao-editor-backtest.md
```

### 8.2 Componentes obrigatórios antes de ordem real

Uma camada de execução mínima precisa conter:

1. autenticação L2 e assinatura de ordens;
2. funder address, allowances e leitura de saldo;
3. market WebSocket;
4. user WebSocket para ordens e fills;
5. heartbeat de segurança;
6. suporte real a GTC, GTD, Post Only, FOK e FAK;
7. máquina de estados persistente da ordem;
8. tratamento de fill parcial;
9. idempotência e prevenção de duplicidade;
10. reconciliação periódica por REST;
11. cancelamento por ordem, mercado e `cancelAll`;
12. price guards e worst-price limits;
13. medição de latência p50/p95/p99;
14. detecção de feed stale e clock drift;
15. kill switch;
16. journal imutável de decisão, ordem, ack, fill e posição;
17. recuperação segura após reinício do processo.

### 8.3 Risco adicional do feed

Um estudo interno existente indica que a Binance pode liderar o preço Chainlink retransmitido usado no projeto em aproximadamente 3 segundos. Esse resultado não foi revalidado neste dossiê, mas é relevante porque:

- TFC e Apex tomam decisões entre 4s e 8s em reversões terminais;
- atraso de alguns segundos pode inverter o valor de uma decisão;
- live e backtest precisam usar feeds semanticamente equivalentes;
- o timestamp deve representar o momento da observação, não apenas o recebimento local.

Referência interna:

```text
docs/analise-quantitativa/estudo-correlacao-binance-polymarket.md
```

## 9. Dimensionamento conservador para a Apex

Esta seção apresenta uma política prudencial, não uma garantia.

Defina:

- `B`: banca dedicada à estratégia;
- `b`: `baseBudget`;
- pior perda observada por evento: `1,8046 × b`;
- fator de estresse inicial: `2×`;
- risco máximo desejado por evento: `0,25% × B`.

Então:

```text
2 × 1,8046 × b ≤ 0,0025 × B
b ≤ 0,000693 × B
```

| Banca dedicada | BaseBudget máximo inicial |
| ---: | ---: |
| US$ 1.000 | US$ 0,69 |
| US$ 5.000 | US$ 3,46 |
| US$ 10.000 | US$ 6,93 |
| US$ 15.000 | US$ 10,39 |

Manter `baseBudget = US$ 10` exigiria aproximadamente US$ 14,4 mil de banca dedicada para respeitar esse limite estressado.

Se o mínimo de ordem tornar o sizing inviável, a decisão correta é não operar. Não se deve arredondar o risco para cima para satisfazer o mínimo da exchange.

Essa fórmula usa a maior perda observada, não a maior perda possível. Falhas operacionais podem superar o histórico.

## 10. Plano de promoção recomendado

### Fase 0 — Correções de pesquisa

- congelar presets;
- auditar campos de carteira, PnL, fees e métricas;
- corrigir taxa da Hopper;
- retirar sizing acima da equity;
- impedir qualquer estratégia de operar quando saldo disponível for insuficiente;
- criar testes de propriedade para conservação de caixa, shares e PnL.

### Fase 1 — Shadow/forward

Duração mínima:

- pelo menos 30 dias e 2.000 sinais;
- idealmente oito semanas;
- sem retunar parâmetros durante a janela.

Rodar em paralelo:

- TFC como referência;
- Apex como candidata;
- Hopper somente como experimento de execução, sem considerar fill imediato.

Registrar:

- sinal teórico;
- book no momento da decisão;
- latência até o ack hipotético/real;
- preço limite;
- quantidade disponível;
- fill teórico conservador;
- taxa correta por mercado;
- slippage;
- posição na fila, quando observável;
- estado final da ordem.

### Fase 2 — Micro-canário

Somente após infraestrutura e forward aprovados:

- capital totalmente dispensável;
- banca dedicada e segregada;
- sem composição automática;
- risco estressado por evento ≤ 0,25% da banca;
- stop diário inicial entre 0,35% e 0,50%;
- hard stop do canário em 1% da banca ou `1,5 × DD histórico escalado`, o menor;
- apenas uma posição/evento;
- apenas uma reversão;
- nenhum aumento de tamanho durante a janela.

Duração mínima antes de escala:

- 1.000 fills reais;
- 30 dias corridos;
- nenhum incidente crítico de reconciliação.

### Fase 3 — Gates de escala

Exigir simultaneamente:

- profit factor líquido real ≥ 1,20–1,25;
- expectativa normalizada ≥ 50% do backtest;
- custos não modelados ≤ 50% da expectativa esperada;
- drawdown ≤ 1,25 × drawdown escalado;
- fill rate e slippage estáveis por regime;
- nenhuma posição órfã;
- nenhuma divergência persistente entre posição local e exchange;
- parâmetros ainda congelados;
- resultado da Apex superior à TFC no novo forward para promovê-la como nova referência.

Aumentos de tamanho, se aprovados, devem ser de no máximo 25% por etapa, seguidos por nova observação de ao menos 500 fills ou duas semanas.

## 11. Kill switches obrigatórios

Cancelar ordens, achatar exposição quando possível e pausar imediatamente diante de:

- posição órfã;
- reversão parcial não reconciliada;
- divergência entre saldo/posição local e exchange;
- perda do user WebSocket;
- market feed stale;
- clock drift acima do limite definido;
- heartbeat inválido ou expirado;
- ordem duplicada;
- erro de allowance ou saldo;
- tick size inesperado;
- taxa retornada diferente da esperada;
- latência acima do limite seguro para a janela restante;
- preço fora do guard contra midpoint/book;
- drawdown diário ou total atingido;
- falha ao cancelar uma ordem terminal obsoleta.

Para reversões urgentes:

- FOK evita posição parcial, mas pode não executar;
- FAK aceita parcial e exige máquina de estados para residual;
- qualquer ordem agressiva deve usar worst-price limit;
- não se deve assumir que fechar a primeira perna e abrir a segunda seja uma operação atômica.

## 12. Protocolo específico para validar Maker na Hopper

Antes de avaliar PnL, medir a qualidade de execução.

### 12.1 Métricas mínimas

- fill rate por preço e distância do midpoint;
- fill rate por tempo restante;
- tempo até primeiro fill e fill completo;
- percentual de fills parciais;
- cancel-to-fill ratio;
- ordens rejeitadas como Post Only;
- slippage efetivo contra o preço teórico;
- adverse selection após 250ms, 1s, 5s e até o encerramento;
- PnL de ordens preenchidas versus sinais não preenchidos;
- missed opportunity cost;
- diferença entre preço Maker ideal e preço realizável;
- inventário residual após cancelamento;
- taxa de falha da perna de proteção.

### 12.2 Critério de rejeição

Rejeitar novamente a Hopper se qualquer um ocorrer:

- lucratividade depender de fills impossíveis ou não observados;
- taker fallback continuar com PF < 1;
- seleção adversa consumir o spread capturado;
- sizing exigir exposição acima da equity;
- ordem de proteção falhar com frequência material;
- PnL desaparecer após capital bloqueado, filas e fills parciais.

### 12.3 Ordem recomendada de reconstrução

1. Remover toda a escada além de uma reversão.
2. Tornar a estratégia lucrativa ou próxima do zero sem recuperação agressiva.
3. Implementar Post Only real com timeout curto e cancelamento.
4. Medir fills com quantidade mínima.
5. Só então reintroduzir equalização limitada, se houver evidência.

## 13. Riscos de interpretação

Não cometer os seguintes erros:

1. **Tratar entrada como observação independente.** O tamanho efetivo da amostra é muito menor devido à correlação por dia/regime.
2. **Interpretar PnL fixo como retorno percentual de carteira.** O motor não representa integralmente capital reservado, solvência e liquidação.
3. **Confundir Maker sem taxa com execução garantida.** A taxa zero não elimina fila e seleção adversa.
4. **Promover por win rate.** A Apex ganha menos por acerto do que perde por erro; a Hopper Maker tem win rate abaixo de 50% e depende de payoff/execução.
5. **Usar holdout curto como confirmação.** Cinco dias não cobrem regimes suficientes.
6. **Retunar depois de ver o forward.** Isso transforma o forward em treino.
7. **Ignorar múltiplas tentativas.** Muitos sweeps elevam a chance de selecionar sorte.
8. **Assumir reversão atômica.** Em produção são duas ou mais ações independentes.
9. **Usar taxa fixa global.** Taxas são determinadas por mercado e devem ser consultadas.
10. **Somar estratégias sem testar correlação e capital simultâneo.** PnLs isolados não formam automaticamente um portfólio seguro.

## 14. Evidências e artefatos reproduzíveis

### 14.1 Apex

```text
labs/strategies/portfolio/apex-triad-v1/strategy.gls
labs/strategies/portfolio/apex-triad-v1/defaults.json
labs/strategies/portfolio/apex-triad-v1/presets/btc-candidate-v1.json
labs/strategies/portfolio/apex-triad-v1/experiments/final-full-single-pass.json
labs/strategies/portfolio/apex-triad-v1/experiments/phase1-train.json
labs/strategies/portfolio/apex-triad-v1/experiments/phase2-validate-june.json
labs/strategies/portfolio/apex-triad-v1/experiments/phase3-holdout-july.json
scripts/analyze-apex-triad.js
docs/estrategias/implementadas/apex-triad-v1.md
reports/labs/apex-triad-v1/2026-07-10T02-44-24-381Z-apex-triad-final-full-single-pass/top-results.json
```

Comandos:

```bash
npm run lab:run -- --experiment labs/strategies/portfolio/apex-triad-v1/experiments/final-full-single-pass.json --quiet
npm run lab:run -- --experiment labs/strategies/portfolio/apex-triad-v1/experiments/phase3-holdout-july.json --quiet
node scripts/analyze-apex-triad.js
```

### 14.2 Hopper

```text
labs/strategies/carry/hopper-3/strategy.json
labs/strategies/carry/hopper-3/presets/btc-champion.json
labs/legacy/strategy-runners/portable/hopper-3-runner.js
reports/labs/hopper-3/2026-07-09T06-36-00-661Z-preset-btc-champion/top-results.json
reports/labs/hopper-3/2026-07-09T06-46-47-396Z-hopper-taker-honest-59d/top-results.json
```

### 14.3 TFC e Edge Sniper

```text
src/backtestStudio/gls/strategies/TerminalFavoriteCarry.gls
src/backtestStudio/gls/strategies/edgeSniperV2.gls
src/strategies/edgeSniperV2.js
docs/estrategias/implementadas/edge-sniper-v2.md
```

## 15. Achados classificados por nível de certeza

### Confirmados diretamente por código/relatório

- Apex: +3,3% de PnL e +10,6% de entradas contra TFC equivalente.
- Apex: drawdown 4,8% maior.
- Apex: superioridade estatística não confirmada.
- Apex: Maker desativado e zero trades Maker gratuitos no resultado final.
- Hopper: `simulateMaker` usa bid para compra e ask para venda com fill imediato.
- Hopper: +US$ 4.863 Maker otimista versus -US$ 4.962 taker honesto.
- Hopper: sizing permite limite de reversão equivalente a aproximadamente 120% da equity.
- Hopper: cálculo interno usa `0.0007` para taxa taker.
- Repositório: execução é simulada; não existe camada CLOB live completa.

### Inferências fortes

- A vantagem atual da Hopper vem principalmente da hipótese de execução, não de um edge comprovado independente dela.
- O sizing de US$ 10 para carteira nominal de US$ 100 é excessivo para conta real.
- A TFC é a primeira candidata prudencial por simplicidade e drawdown relativo, não por comprovação live.
- A Apex pode agregar valor, mas ainda não justificou substituir a TFC.

### Ainda não testado/confirmado

- fill rate Maker real da Hopper;
- posição real na fila;
- impacto de adverse selection;
- PnL com latência real;
- confiabilidade das reversões em fills parciais;
- risco intratrade máximo;
- capital bloqueado e tempo de liquidação;
- comportamento em novos regimes fora de maio–julho;
- robustez em outros ativos/intervalos;
- resultado após infraestrutura live completa;
- correlação live entre estratégias em portfólio.

## 16. Perguntas que uma próxima IA deve responder

1. O motor impede de fato uma nova entrada quando a equity disponível fica abaixo do orçamento?
2. Como o fee postprocessor trata `liquidity: maker` no runner legado?
3. Por que o cenário Maker da Hopper ainda registra taxas?
4. Por que `eventsWithEntries` e `avgPnl` estão inconsistentes na Hopper?
5. Qual é o máximo drawdown intratrade, não apenas entre eventos fechados?
6. Qual é a distribuição de perdas por reversão e por regime?
7. Qual fração do PnL Apex vem do módulo Edge em base contrafactual pareada?
8. A Apex sobrevive a walk-forward com parâmetros totalmente congelados por 60–90 dias?
9. Qual é o PnL após inserir latência empírica p95/p99?
10. Qual é a expectativa da Hopper usando um modelo de fila conservador?
11. O uso de Binance como sinal líder melhora resultado fora da amostra sem introduzir lookahead?
12. Quais mínimos de ordem tornam o sizing conservador operacionalmente possível?

## 17. Prompt de handoff para outra IA

O texto abaixo pode ser copiado junto com este documento:

```text
Você está auditando estratégias de BTC Up/Down 5m da Polymarket no repositório data-backtest.

Leia primeiro:
- docs/estrategias/avaliacao-integrada-conta-real-2026-07-10.md
- docs/estrategias/implementadas/apex-triad-v1.md
- labs/strategies/portfolio/apex-triad-v1/strategy.gls
- labs/legacy/strategy-runners/portable/hopper-3-runner.js
- reports/labs/apex-triad-v1/2026-07-10T02-44-24-381Z-apex-triad-final-full-single-pass/top-results.json
- reports/labs/hopper-3/2026-07-09T06-46-47-396Z-hopper-taker-honest-59d/top-results.json

Regras da auditoria:
1. Não trate simulateMaker como fill real.
2. Não interprete PnL fixo como retorno percentual sem auditar solvência/capital reservado.
3. Separe fatos, inferências e hipóteses.
4. Recalcule taxas com a regra oficial atual por mercado.
5. Considere correlação temporal e selection bias.
6. Não promova estratégia sem forward congelado e execução live realista.
7. Priorize encontrar falsos positivos de backtest antes de otimizar PnL.

Objetivo imediato:
- auditar o modelo de carteira e fees;
- construir um modelo conservador de fila Maker;
- medir drawdown intratrade;
- executar walk-forward congelado;
- propor gates objetivos de shadow e micro-canário.
```

## 18. Decisão final vigente

### TFC

- manter como referência;
- autorizar shadow/forward;
- considerar primeiro micro-canário somente após infraestrutura real e controles;
- não autorizar produção plena.

### Apex Triad V1

- manter status `candidate`;
- congelar preset;
- coletar pelo menos mais 30 dias fora da amostra, idealmente 60–90;
- exigir PnL/PF superiores à TFC e drawdown não superior;
- não ativar Maker profit lock;
- não autorizar capital relevante.

### Hopper 3 V1

- retirar qualquer interpretação de “champion” para conta real;
- tratar como pesquisa Maker;
- corrigir sizing e taxas;
- substituir fill imediato por modelo de fila;
- não autorizar micro-canário da estratégia completa;
- permitir futuramente apenas experimento mínimo de execução Post Only, depois de infraestrutura segura, para medir fills.

### Ordem de prudência para eventual implantação futura

1. TFC.
2. Apex Triad V1.
3. Edge Sniper isolada, após avaliação própria atualizada.
4. Hopper reconstruída; a versão atual permanece fora de produção.

