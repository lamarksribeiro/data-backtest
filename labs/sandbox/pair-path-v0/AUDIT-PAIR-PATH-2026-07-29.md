# Auditoria Pair-Path / Clip-Path — 2026-07-29

## Decisão

**HOLD / PARITY GAP.**

Esta decisão precisa ser dividida em duas:

| Afirmação | Estado |
|---|---|
| O path consegue formar complete-set lucrativo em conta real | **CONFIRMADO**: 4 pares, gross +US$ 3,05, net estimado +US$ 1,36 |
| A política ampla codificada no replay é lucrativa continuamente | **REJEITADA COMO CODIFICADA** |
| O filtro que selecionou os trades reais foi reproduzido no replay | **NÃO** |
| Pode avançar para nova operação live | **HOLD** até fechar paridade e obter nova aprovação |

O replay principal termina em **2026-07-26**; os quatro complete-sets reais são
de **2026-07-28 e 2026-07-29**. Portanto, ele não reexecutou nem invalidou esses
eventos. Ele aplicou uma generalização ampla — open automático em 64%–68% dos
24.502 eventos — que não representa necessariamente a seleção usada na conta
real.

Nessa generalização, todas as 12 combinações perderam; o melhor resultado
realizado guardado foi **−US$ 7.777,14** em size 10 e o melhor profit factor foi
**0,618**. A conclusão correta é: **o preset de automação contínua está
rejeitado, mas o path real permanece validado e sua política de seleção ainda
não foi identificada com paridade suficiente**.

## O que a estratégia realmente é

Se o book simultâneo respeita aproximadamente:

```text
ask_UP(t) + ask_DOWN(t) ≈ 1,01
```

e a estratégia abre o favorito a `p0` e compra o oposto depois a `q1`, então:

```text
avgSum ≈ p0 + q1
       ≈ 1,01 − [movimento favorável da perna aberta]
```

Portanto, `avgSum < 1` não existia no momento da entrada. Ele aparece somente
se o favorito subir depois do open. Nos 14 journals originais:

- soma mediana dos asks simultâneos: **1,01**;
- ticks com soma abaixo de 1: **0,03%**;
- `avgSum 0,92` significa aproximadamente 9¢ de movimento favorável antes do
  hedge.

Isso caracteriza **momentum direcional com seguro condicional**, não arbitragem
atômica de complete-set. O hedge realiza um lucro que o movimento já criou; ele
não cria o edge.

## Fee: bruto não é líquido

A fórmula oficial vigente para crypto é:

```text
fee = shares × 0,07 × price × (1 − price)
```

Makers não pagam essa taker fee; takers pagam. A referência é a documentação
oficial de [fees da Polymarket](https://docs.polymarket.com/trading/fees).

Para um open próximo de 0,56, o break-even líquido all-taker exige hedge perto
de 0,406, ou `avgSum` aproximadamente **0,966**. Assim:

- `avgSum = 0,95`: pode travar lucro líquido;
- `avgSum = 0,98`: trava perda líquida, apesar do bruto positivo;
- `avgSum = 1,00`: trava perda igual às fees.

Por isso o contrato foi alterado para considerar `lockedPnlPerShare` após fees.
`avgSum ≤ 1` sozinho não é um limite de risco econômico.

## Como conciliar as evidências

### Janela de 14 eventos

Os A/Bs e o sweep de 148 variantes reutilizaram os mesmos 14 eventos de uma
janela de aproximadamente 90 minutos. Dez entradas negociadas equalizaram e o
regime teve movimentos favoráveis muito grandes. Isso serve para depurar
mecânica, mas não é holdout e não pode selecionar promoção.

Cinco dos dez eventos de `clip-2-tight` também dependiam do proxy legado de fill
maker cheio por cruzamento posterior do top-of-book. O live posta uma ordem por
vez e a deixa descansar por poucos segundos; o offline legado inferia fill
cheio por até 30 segundos, sem queue nem depth.

### Quatro complete-sets CLOB

Os quatro pares são a evidência primária desta análise: ordens reais, matched,
inventário equalizado e payout estrutural. Não são exemplos hipotéticos.
Somaram investimento de US$ 46,95, gross **+US$ 3,05** e net estimado
**+US$ 1,36**. Dois relatórios locais ainda preservam orders totalmente matched
com order IDs (`pp-5900.json` e `pp-9500.json`), além do clip detalhado
reconciliado pelo CLOB no briefing.

O que eles confirmam é a execução e a economia desses quatro paths. O que ainda
não estimam, por falta de um denominador completo, é a expectativa da política:

- todos os eventos ignorados;
- opens que não chegaram ao hedge;
- ordens canceladas ou parcialmente executadas;
- posição na fila;
- maker/taker confirmado por order ID;
- fee e VWAP reais de cada fill.

Isso não diminui o resultado real. Apenas impede extrapolar quatro resultados
para operação automática contínua sem reconstruir o filtro que os selecionou.

O harness antigo registrava preço limite submetido, não necessariamente o VWAP
executado, e o relatório não persistia `orderId` em todos os mapas. Filtrar
somente `maker_address = funder` também pode censurar o lado taker. A API expõe
`order_id` e `size_matched`; ver [gerenciamento de ordens](https://docs.polymarket.com/trading/manage-orders).

### Outras diferenças de paridade

- top-book nos journals versus walk de 25 níveis no lake;
- fill integral versus parcial/miss;
- vários clips no mesmo tick versus submissão sequencial;
- `EQ ≤ 5¢` offline sem equivalente no micro-live;
- winner proxy nos journals versus resultado resolvido;
- seleção de parâmetros e avaliação na mesma amostra.

A própria documentação recomenda conferir depth antes de ordens grandes e
reconhece partial fill em limit orders:
[prices e order book](https://docs.polymarket.com/concepts/prices-orderbook).

## Replay principal

Runner: [`lake-replay.mjs`](./lake-replay.mjs)

Artefato bruto regenerável:
`.tmp/pair-path-lake-replay/report.json`.

### Escopo

| Item | Valor |
|---|---|
| Dataset | `lake/backtest_ticks`, BTC 5m, depth 25 |
| Janela | 2026-04-23 a 2026-07-26 |
| Dias | 95 |
| Eventos elegíveis | 24.502 |
| Eventos pulados por cobertura | 271 |
| Size | 10 shares |
| Políticas | V0, tight2, deep3, deep4 |
| Execuções | latência 1 tick, 3 ticks, confirmação 2 + latência 1 |
| Fee | all-taker por nível |
| Buffer operacional | 0,2¢ por par balanceado |

Linhas duplicadas com o mesmo `(event_start, ts)` são deduplicadas antes do
replay. Cada ordem caminha o ask depth-25, aceita parcial, só executa em tick
futuro e bloqueia nova submissão enquanto existe ordem pendente. Não há fill
maker inferido nem EQ exclusivo do offline. O PnL realizado é aceito somente
quando spot/PTB e o último book concordam com o vencedor.

### Resultado

| Configuração | Opens | Equalizou | Residual | PnL realizado guardado | PF |
|---|---:|---:|---:|---:|---:|
| V0 · latency3 | 15.733 | 75,73% | 3.819 | −7.926,77 | 0,550 |
| tight2 · confirm2/latency1 | 15.673 | 79,95% | 3.142 | −7.927,80 | 0,493 |
| deep3 · confirm2/latency1 | 15.673 | 75,67% | 3.814 | −7.832,40 | 0,544 |
| deep4 · confirm2/latency1 | 15.673 | 73,00% | 4.231 | **−7.777,14** | 0,563 |
| deep4 · latency3 | 15.733 | 67,46% | 5.120 | −7.801,27 | **0,618** |

Nenhuma das 12 variantes teve mês positivo em abril, maio, junho ou julho.
Na melhor por PnL:

| Mês | Opens | Equalizou | PnL | PF |
|---|---:|---:|---:|---:|
| 2026-04 | 707 | 74,82% | −198,53 | 0,697 |
| 2026-05 | 5.422 | 71,76% | −2.940,52 | 0,536 |
| 2026-06 | 5.211 | 74,15% | −2.442,43 | 0,568 |
| 2026-07 | 4.333 | 72,88% | −2.195,66 | 0,557 |

### Decomposição que decide

Na configuração de melhor PnL:

```text
paths equalizados    +US$  9.683,91
paths com residual   −US$ 17.461,05
total                −US$  7.777,14
```

Cada equalização ganhou em média cerca de US$ 0,85. Cada residual resolvido
perdeu em média cerca de US$ 4,22. A escada mais profunda aumenta o prêmio
condicional ao sucesso, mas reduz a chance de completar e amplia o denominador
de caudas.

O total de fees da melhor variante foi US$ 4.492,17. Mesmo somando todas elas
de volta — teto irrealisticamente favorável que trata tudo como maker e ainda
inclui fees de eventos não usados no PnL resolvido — o resultado permaneceria
aproximadamente **−US$ 3.285**. Fee maker não salva a tese.

## Tentativa de melhoria: momentum + loss cut

Uma bateria separada testou quatro políticas tight2 em latência 1 e 3:

1. controle;
2. loss cut após queda de 3¢ no ask do favorito, comprando o oposto com perda
   líquida limitada;
3. open somente após o favorito subir 2¢ em 10 segundos;
4. momentum + loss cut.

Artefato: `.tmp/pair-path-lake-replay-risk/report.json`.

| Política · execução | Opens | Equalizou | `netPairCost` p50 | PnL | PF |
|---|---:|---:|---:|---:|---:|
| tight2 controle · latency3 | 15.733 | 75,60% | 0,9230 | −8.049,42 | 0,562 |
| momentum · latency3 | 9.485 | 75,53% | 0,9275 | −4.985,59 | 0,553 |
| loss cut · latency3 | 15.733 | 92,60% | 1,0549 | −8.028,60 | 0,366 |
| momentum + loss cut · latency3 | 9.485 | 93,57% | 1,0550 | **−4.494,56** | 0,377 |

Momentum reduziu o número de entradas, não a perda média por open de forma
material. O loss cut reduziu residual e cauda, mas converteu a maioria dos
flattens em perdas conhecidas: o custo mediano do par passou de 1. O melhor
resultado continuou negativo nos quatro meses e teve PF abaixo de 0,41 em cada
mês. O stop melhora controle de dano; não cria edge.

## Melhorias consolidadas no laboratório

### Engine

[`engine.mjs`](./engine.mjs) agora contém:

- `restingFillModel: "none"` para impedir maker fill fantasma;
- `confirmationTicks`;
- `maxClipsPerTick` para submissão sequencial;
- escape em dois estágios também abaixo de `tauHedgeMin`;
- piso `escapeMinLockedPnlPerShare` após fees;
- `balancedShares`, `netPairCost` e `lockedPnlPerShare`;
- tolerância numérica no teto de `avgSum`;
- winner proxy corrigido e explicitamente marcado como proxy.

### Validação

[`engine.test.mjs`](./engine.test.mjs) cobre cinco invariantes:

- escape 2 abaixo de `tauHedgeMin`;
- recusa por piso de PnL líquido;
- ausência de maker fill inferido;
- um clip por tick;
- confirmação consecutiva.

[`mechanics-sweep.mjs`](./mechanics-sweep.mjs) não produz mais recomendação
operacional: seu resultado é marcado como calibração in-sample.

[`presets/clip-path-v1.json`](./presets/clip-path-v1.json) foi rebaixado para
`research`, com o escopo de rejeição limitado à automação ampla testada, size
10, notional 16 e execução conservadora. O briefing e a especificação receberam
uma correção de paridade explícita.

## O que ainda vale preservar

- Os quatro trades CLOB são **ground truth real** de paths lucrativos,
  posteriores à janela do lake.
- `avgSum`, `netPairCost` e PnL travado por share são métricas corretas para
  complete-sets já formados.
- Depth walk, latência, parcial e ledger por order ID são infraestrutura
  reutilizável.
- O conceito de aceitar perda pequena para cortar residual é correto como
  contrato de risco, embora esta regra não tenha edge nesta política.

## O que não fazer

- Não escolher deep3/deep4 pelo sweep de 14 eventos.
- Não chamar `avgSum < 1` de arbitragem quando as pernas são temporais.
- Não avaliar somente eventos equalizados.
- Não inferir maker fill por cruzamento posterior.
- Não liberar nova operação live enquanto o filtro real não estiver em paridade
  e sem nova aprovação do operador.
- Não aumentar size para compensar PF abaixo de 1.
- Não descartar os quatro complete-sets reais por causa de um replay que não
  contém as datas nem o filtro de seleção deles.

## Próxima pesquisa: recuperar a política real

A prioridade não é inventar outra escada. É reconstruir por que a operação real
selecionou esses quatro paths e não milhares de entradas. O protocolo mínimo é:

1. consolidar os quatro trades por order ID, VWAP, maker/taker e fee efetiva;
2. reconstruir todas as sessões live, incluindo eventos sem open, miss e cancel;
3. comparar o contexto pré-open real — tau, spot/PTB, velocidade, spread, depth,
   direção e regime — contra os eventos negativos do lake;
4. congelar o filtro encontrado antes de avaliar outro período;
5. caminhar depth, fee, latência, parcial e miss;
6. manter ledger de exposição e loss cut;
7. usar período temporal realmente não tocado;
8. somente então rodar forward shadow read-only.

Até que isso exista, **o preset amplo permanece bloqueado; o path real continua
uma hipótese ativa, com execução lucrativa confirmada e seleção ainda não
explicada**.
