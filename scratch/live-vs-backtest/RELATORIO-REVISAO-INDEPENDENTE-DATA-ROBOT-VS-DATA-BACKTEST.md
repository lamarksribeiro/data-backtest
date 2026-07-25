# Relatório de revisão independente — divergências entre Data Robot e Data Backtest

**Data da revisão:** 2026-07-25  
**Escopo:** MIDAS Carry V1 · BTC Up/Down 5m · preset `btc-micro-aggressive-v1`  
**Repositórios analisados:** `data-backtest` e `data-robot`  
**Natureza da revisão:** análise read-only; nenhum deploy, ordem live ou alteração operacional foi executado

---

## 1. Objetivo

Este relatório revisa criticamente tudo que foi documentado e coletado até o momento sobre as divergências entre:

- os trades executados pelo `data-robot` em produção;
- o resultado reproduzido pelo `data-backtest`;
- o comportamento teórico esperado da estratégia MIDAS;
- o comportamento real do OMS e do CLOB da Polymarket.

O trabalho não se limita a resumir os relatórios existentes. Cada conclusão relevante foi confrontada com:

- artefatos de trades e auditoria;
- código dos dois repositórios;
- comportamento do simulador;
- fluxo real de ordens no OMS;
- regras oficiais de FAK, FOK e GTC;
- outcome canônico de um mercado com settlement divergente.

O objetivo final é distinguir:

1. divergências reais;
2. comparações metodologicamente inválidas;
3. causas confirmadas;
4. hipóteses ainda não demonstradas;
5. correções que podem ser feitas com segurança;
6. mudanças que não deveriam ir para produção no estado atual.

---

## 2. Materiais revisados

### 2.1 Relatórios existentes

- `RELATORIO-MIDAS-LIVE-VS-BT.md`
- `RELATORIO-COMPLEMENTAR-CORRECAO-FAK-EXIT.md`
- `LAB-FAK-EXIT-GTC.md`
- `bt-summary-2026-07-24-25.md`
- documentação da estratégia em `docs/estrategias/implementadas/midas-carry-v1.md`

### 2.2 Artefatos live

- `prod-trades.json`
- `prod-status.json`
- `prod-audit-summary.json`
- `prod-audit-2026-07-24.jsonl`
- `prod-audit-2026-07-25.jsonl`
- `prod-reverse-diagnosis.json`
- `prod-loss-lateflip.json`

### 2.3 Artefatos de backtest/paridade

- `bt-results-2026-07-24-25.json`
- `bt-top-2026-07-24-25.json`
- `full-parity-report.json`
- `full-parity-slim.json`
- `live-vs-backtest-parity.json`
- experimentos `fak-exit-gtc-live-window.json` e `fak-exit-gtc-holdout.json`

### 2.4 Código analisado

No `data-backtest`:

- `src/backtestStudio/gls/orderSimulator.js`
- `src/backtest/engine.js`
- `src/backtest/fees.js`
- scripts de comparação e diagnóstico em `scratch/live-vs-backtest`

No `data-robot`:

- `src/strategy/midasV1.js`
- `src/tfc/evaluate.js`
- `src/tfc/preset-midas.js`
- `src/oms/reverseSaga.js`
- `src/oms/omsSink.js`
- `src/oms/createOms.js`
- `src/oms/states.js`
- `src/oms/tradeJournal.js`
- `src/control/engineApp.js`
- testes do OMS e do canário MIDAS

### 2.5 Referências externas

- Polymarket — Place Orders: <https://docs.polymarket.com/trading/place-orders>
- Polymarket — Manage Orders: <https://docs.polymarket.com/trading/manage-orders>
- Gamma, mercado divergente: <https://gamma-api.polymarket.com/events?slug=btc-updown-5m-1784963700>

---

## 3. Resumo executivo

As divergências observadas são reais, mas o diagnóstico registrado nos relatórios existentes está apenas parcialmente correto.

Os principais resultados desta revisão são:

1. **A comparação 40 entradas live versus 125 entradas no backtest não é válida como medida de cobertura.** As janelas efetivas não coincidem, o lake termina antes do live e o robot passou por vários starts, estados DISARMED e commits diferentes.

2. **A afirmação de que FAK é “tudo ou nada” está incorreta.** FAK pode preencher parcialmente e cancelar apenas o restante. O comportamento “preenche tudo ou nada” pertence ao FOK.

3. **O lab chamado FAK versus GTC não testa tipos de ordem.** Ele liga e desliga mecanismos completos de proteção. Demonstra o valor potencial de reverse/exit funcionando, mas não demonstra que GTC é a solução correta.

4. **O patch atual FAK→GTC não está seguro para deploy.** O mesmo `exitOrderType` é reutilizado nas duas pernas da saga REVERSE. Assim, a compra do lado oposto também pode virar GTC e preencher atrasada.

5. **Existe um erro confirmado no settlement do backtest.** O backtest usa o último spot/RTDS contra o PTB, enquanto a Polymarket resolve esse mercado pela Chainlink. Também usa `>` onde a regra oficial é `>=`.

6. **Um único winner incorreto explica aproximadamente dois terços do gap bruto observado nos mercados capturados.**

7. **A causa do `REVERSE_EXIT_INCOMPLETE` não está demonstrada.** O audit registra apenas a ordem-mãe e não as pernas filhas. O primeiro reverse falhou; em seguida, os retries foram bloqueados por risco e circuit breaker.

8. **As ferramentas de auditoria ocultaram 200 recusas.** Os scripts procuram `rejected`, mas o engine grava `denied`.

9. **Os preços de entrada do trade journal não são confiáveis para medir slippage.** O journal prioriza o preço limite solicitado sobre o preço médio efetivamente preenchido.

10. **A paridade direcional não foi refutada.** Nos 22 mercados capturados em que ambos entraram, live e backtest escolheram o mesmo lado. Isso é evidência favorável, mas ainda insuficiente para confirmar o edge ou a equivalência operacional.

### Recomendação central

Não realizar o deploy do patch GTC no formato atual. A sequência correta é:

1. corrigir settlement e labels;
2. corrigir auditoria e journal;
3. reconstruir uma comparação com janela e build idênticos;
4. instrumentar as duas pernas do REVERSE;
5. implementar saída parcial com retry residual controlado;
6. somente depois comparar FAK e GTC em replay realista e canário aprovado.

---

## 4. Baseline observado

### 4.1 Resultado live

Período efetivamente observado:

- primeiro trade: `2026-07-24T22:19:30.781Z`;
- último settlement: `2026-07-25T17:00:01.602Z`.

Resultado registrado:

| Métrica | Live |
|---|---:|
| Trades fechados | 40 |
| Wins | 32 |
| Losses | 8 |
| Win rate | 80,0% |
| PnL registrado | +$2,6656 |

Observação importante: esse PnL não está em uma base de fees comprovadamente equivalente à utilizada pelo backtest.

### 4.2 Resultado do backtest amplo

Janela solicitada:

- `2026-07-24T00:00:00Z` até `2026-07-26T00:00:00Z`.

Resultado:

| Métrica | Backtest |
|---|---:|
| Eventos | 331 |
| Entradas | 125 |
| Wins | 99 |
| Losses | 26 |
| Win rate | 79,2% |
| PnL após fees simuladas | +$24,2191 |
| Fees simuladas | $5,3532 |
| Profit factor | 1,6815 |
| Max drawdown | $4,1050 |

Distribuição diária:

| Dia | Eventos | Entradas | PnL |
|---|---:|---:|---:|
| 24/07 | 237 | 93 | +$14,5285 |
| 25/07 | 94 | 32 | +$9,6906 |

### 4.3 Paridade sobre os mercados live

Classificação produzida:

| Classe | Quantidade |
|---|---:|
| `near_parity` | 13 |
| `pnl_gap` | 7 |
| `exit_path_diff` | 2 |
| `bt_no_entry` | 1 |
| `bt_missing` | 17 |
| Total | 40 |

Somente 23 dos 40 mercados possuíam informação utilizável no replay.

Nesses 23:

| Métrica | Valor |
|---|---:|
| PnL live | +$1,0256 |
| PnL BT bruto capturado | +$4,0102 |
| Gap bruto | $2,9846 |
| Mercados em que ambos entraram | 22 |
| Mesmo lado quando ambos entraram | 22/22 |

---

## 5. Problema metodológico: 40 live versus 125 BT

### 5.1 As janelas não são equivalentes

O backtest começa à meia-noite de 24/07. O primeiro trade live só aparece às 22:19 UTC.

Portanto, grande parte das 93 entradas do BT em 24/07 ocorreu antes de existir observação live comparável.

Isso significa que:

```text
125 entradas BT - 40 entradas live
```

não pode ser interpretado diretamente como:

```text
85 entradas perdidas por FAK, restart ou falha do robot
```

### 5.2 O lake não cobre toda a janela live

Entre os 17 mercados classificados como `bt_missing`:

- dois são do trecho inicial, incluindo bordas de disponibilidade/normalização;
- 15 ocorrem a partir de `2026-07-25T07:55:00Z`;
- o último mercado capturado no relatório ocorre às 07:40 UTC;
- o live continua até 17:00 UTC.

A classificação `missing_from_lake_or_no_callback` foi resumida no relatório como “evento fora do lake”, mas esse rótulo reúne mais de uma possibilidade.

Na prática, a maior parte dos 17 casos está fora da cobertura temporal efetivamente disponível, e não representa uma decisão divergente da estratégia.

### 5.3 O live não representa um único build estável

Nos arquivos de audit foram encontrados:

- 35 eventos `engine_started` no total exportado;
- 19 `engine_started` dentro da janela efetiva dos trades;
- 13 `sourceCommit` distintos dentro da janela dos trades;
- nove starts em `DISARMED`;
- dez starts em `ARMED`.

Consequências:

- o live agrega múltiplos deploys/builds;
- períodos DISARMED não podem ser comparados com entradas que o BT executaria;
- alterações no engine, feeds, risco ou OMS podem mudar a execução mesmo com o mesmo preset nominal;
- “restart” não é necessariamente uma interrupção aleatória: vários registros correspondem a deployments com commits diferentes.

### 5.4 Correção necessária

Uma comparação válida deve usar a interseção:

```text
mercados presentes no lake
∩ mercados observados pelo robot
∩ engine ARMED
∩ feeds válidos
∩ mesmo sourceCommit
∩ mesmo preset e parâmetros
```

Sem essa interseção, cobertura, taxa de entrada e PnL agregado não possuem interpretação causal.

---

## 6. Paridade direcional: o que os dados realmente mostram

O resultado `sameSide = 22/22` é um dos sinais mais relevantes da investigação.

Ele indica que, condicionado a:

- o mercado estar presente no lake;
- o backtest produzir callback;
- live e BT entrarem;

ambos escolheram o mesmo lado.

Isso sugere que a implementação live e a estratégia de backtest compartilham o núcleo direcional esperado.

Entretanto, não prova:

- que a cobertura de entradas seja equivalente;
- que o timing seja equivalente;
- que os fills sejam equivalentes;
- que os exits/reverses sejam equivalentes;
- que o edge esteja estatisticamente confirmado;
- que o PnL live deva convergir ao PnL do BT.

### 6.1 Win rate

Win rates observados:

- live: `32/40 = 80,0%`;
- BT amplo: `99/125 = 79,2%`.

Intervalos de Wilson aproximados de 95%:

- live: 65,2% a 89,5%;
- BT: 71,3% a 85,4%.

Os intervalos se sobrepõem amplamente.

Conclusão adequada:

> Os dados atuais não contradizem a paridade direcional, mas também não confirmam estatisticamente um edge live de aproximadamente 80%.

Conclusão inadequada:

> O edge está confirmado porque os win rates são praticamente iguais.

---

## 7. Erro de settlement e winner canônico

### 7.1 Caso confirmado

Mercado:

`btc-updown-5m-1784963700`

Resultado live/Polymarket:

- winner: `UP`;
- Gamma: outcomes `["Up", "Down"]`;
- outcome prices: `["1", "0"]`;
- mercado fechado e automaticamente resolvido.

Resultado do backtest:

- winner derivado: `DOWN`.

### 7.2 Regra oficial do mercado

O mercado resolve:

- `UP` se o preço BTC/USD Chainlink ao final for maior ou igual ao preço inicial;
- `DOWN` caso contrário.

O próprio texto do mercado informa que:

- a fonte é o stream BTC/USD da Chainlink;
- outros spot markets ou fontes não devem ser usados para settlement.

### 7.3 Implementação atual do backtest

Em `src/backtestStudio/gls/orderSimulator.js`, `settleEventPnl` usa:

```js
const underlying = Number(tick?.btc_price ?? tick?.underlyingPrice);
const ptb = Number(event?.priceToBeat ?? tick?.price_to_beat);
const winnerSide = underlying > ptb ? 'UP' : 'DOWN';
```

Há dois problemas independentes:

1. **Fonte incorreta:** o último underlying do lake não é necessariamente o valor Chainlink usado pela Polymarket.
2. **Operador incorreto em empate:** a regra é `>=`, enquanto o código usa `>`.

### 7.4 Impacto financeiro

No relatório de paridade desse mercado:

- live entrou `DOWN` e perdeu aproximadamente `$1,35`;
- BT entrou `DOWN` e ganhou aproximadamente `$0,66`;
- delta observado: `$2,01`.

O gap bruto total nos 23 mercados capturados é:

```text
$4,0102 BT - $1,0256 live = $2,9846
```

Corrigir somente o winner desse mercado reduziria o BT em aproximadamente `$2,00`.

Isso explica cerca de:

```text
$2,00 / $2,9846 ≈ 67%
```

do gap bruto capturado.

Após essa correção, o gap residual seria de aproximadamente `$0,985`, antes das correções de fill, preço e fee.

### 7.5 Solução recomendada

O lake/event store deve persistir:

- `resolvedOutcome`;
- `resolutionSource`;
- `resolutionObservedAt`;
- `chainlinkOpen`;
- `chainlinkClose`;
- `labelStatus`: `provisional` ou `canonical`;
- versão/proveniência do normalizador.

Uso:

- para settlement de backtest histórico, utilizar o outcome canônico resolvido;
- para pesquisa intramercado, usar somente dados disponíveis naquele instante;
- nunca vazar o outcome futuro para features de decisão;
- usar derivação spot apenas como fallback explicitamente marcado como provisório;
- corrigir o empate para `>=`.

---

## 8. Semântica de FAK, FOK e GTC

### 8.1 FAK não é all-or-none

A documentação oficial da Polymarket define:

| Tipo | Comportamento |
|---|---|
| FAK | Preenche imediatamente contra a liquidez disponível e cancela o restante |
| FOK | Preenche a ordem inteira imediatamente ou não preenche nada |
| GTC | Permanece ativa até ser preenchida ou cancelada |

Portanto, a afirmação do relatório complementar:

> “FAK é atômico: ou enche tudo instantaneamente, ou morre”

está incorreta.

### 8.2 O próprio OMS reconhece FAK parcial

O fluxo do OMS contém comportamento e teste para:

- ordem solicitada maior que a quantidade efetivamente preenchida;
- parcial FAK que produz fill;
- ausência de remainder resting;
- posição atualizada pela quantidade preenchida.

Isso confirma que o sistema não deveria tratar toda FAK incompleta como zero fill.

### 8.3 Consequência para a hipótese principal

Trocar FAK por GTC não corrige “FAK rejeita qualquer parcial”.

O que realmente muda é:

- FAK: executa o disponível agora e cancela o residual;
- GTC: executa o disponível agora e pode deixar o residual resting.

Assim, o problema correto a resolver é:

> Como reconciliar e liquidar rapidamente a quantidade residual sem criar uma ordem stale?

Não:

> Como impedir que FAK rejeite um fill parcial?

---

## 9. O que `ignoreConsumed:true` realmente faz

O relatório complementar afirma que `ignoreConsumed:true` faz o executor do lab sempre preencher.

O código não confirma essa interpretação.

### 9.1 Comportamento real

Em `planEntry`:

- o simulador lê os níveis de ask;
- respeita `maxPrice`;
- respeita budget/quantidade;
- avalia liquidez mínima;
- pode produzir fill parcial ou nenhum fill.

`ignoreConsumed:true` apenas substitui o mapa compartilhado de liquidez consumida por um mapa novo naquela operação.

Isso é usado para permitir operações do tipo:

1. planejar;
2. validar;
3. executar/commit;

sem descontar duas vezes a mesma liquidez durante o processo interno.

### 9.2 Onde o backtest continua otimista

O backtest ainda é otimista porque não reproduz adequadamente:

- latência entre decisão e submissão;
- mudança do book durante essa latência;
- rejeição de API/CLOB;
- websocket atrasado;
- fill chegando depois de um timeout;
- parcial real e reconciliação assíncrona;
- circuit breaker;
- risco bloqueando novo intent;
- duas pernas não atômicas do REVERSE;
- deploy/restart/DISARMED;
- ordem residual resting;
- eventual fallback de book quando níveis não estão presentes.

Conclusão:

> O diagnóstico de otimismo do simulador está correto, mas a explicação baseada em `ignoreConsumed:true` está errada.

---

## 10. Avaliação do lab denominado FAK-exit versus GTC

### 10.1 Variantes utilizadas

O lab usa variantes que representam:

| Variante | Mecanismos |
|---|---|
| `gtc-full-protect` | reverse + exit + danger ligados |
| `fak-miss-exit-only` | reverse desligado; exit + danger ligados |
| `fak-miss-hold` | reverse, exit e danger desligados |
| `gtc-reverse-no-danger` | reverse/exit ligados; danger desligado |

### 10.2 O que o lab mede

O lab mede o valor contrafactual dos mecanismos de proteção:

- hold até expiry;
- exit simples;
- reverse;
- danger.

No holdout:

| Variante | PnL |
|---|---:|
| `gtc-full-protect` | +$417,86 |
| `fak-miss-exit-only` | +$298,59 |
| `fak-miss-hold` | +$246,89 |
| `gtc-reverse-no-danger` | aproximadamente +$431,43 |

Esses resultados indicam que:

- proteção perfeita pode agregar valor;
- reverse é uma parte importante do resultado histórico;
- danger não é necessariamente o principal driver;
- manter posição até expiry pode ser pior no holdout.

### 10.3 O que o lab não mede

Ele não simula:

- ordem FAK real;
- ordem GTC real;
- remainder resting;
- cancelamento;
- fill parcial assíncrono;
- stale fill;
- latência real;
- falha de perna;
- risco/circuit breaker;
- book mudando entre as duas pernas.

Portanto:

> O lab apoia o valor de restaurar uma proteção executável.

Mas não:

> O lab prova que trocar FAK por GTC é seguro e causará o ganho observado.

---

## 11. Análise do patch FAK→GTC

### 11.1 Alteração local encontrada

No `data-robot`, há alteração local não commitada:

```js
entryOrderType: 'FAK',
exitOrderType: 'GTC',
```

para `MICRO_AGGRESSIVE` e `MICRO_ROBUST`.

O comentário afirma que GTC fornece “fill garantido” e que a entrada continua FAK.

### 11.2 GTC não garante fill

GTC pode:

- preencher imediatamente;
- preencher parcialmente;
- ficar resting;
- preencher mais tarde;
- nunca preencher;
- exigir cancelamento explícito.

Uma ordem GTC com expiration zero não expira por timer segundo a documentação da Polymarket.

### 11.3 O mesmo tipo é reutilizado nas duas pernas do REVERSE

Em `midasV1.js`, o intent REVERSE recebe:

```js
orderType: params.exitOrderType ?? params.entryOrderType ?? 'GTC'
```

Em `reverseSaga.js`, esse mesmo `orderType` é aplicado a:

1. `REVERSE:exit`, que vende a posição atual;
2. `REVERSE:enter`, que compra o lado oposto.

Logo:

- a entrada normal continua FAK;
- a entrada produzida pela reversão passa a ser GTC.

Isso contradiz a premissa do comentário e do relatório de que somente a saída protetora mudaria.

### 11.4 Risco de entrada oposta tardia

Cenário possível:

1. o late flip emite REVERSE;
2. a perna de saída completa;
3. a compra oposta GTC não encontra liquidez suficiente;
4. a ordem fica resting;
5. o sinal deixa de ser válido ou o mercado entra nos segundos finais;
6. a compra preenche atrasada.

O resultado pode ser uma nova posição:

- sem o gate original ainda válido;
- depois do deadline do intent;
- próxima do expiry;
- sem tempo para nova proteção.

### 11.5 Incompatibilidade entre deadline e espera

No fluxo atual:

- intent REVERSE recebe deadline de aproximadamente três segundos;
- cada perna da saga pode esperar até oito segundos.

Possibilidade:

- exit completa após o deadline, mas antes do timeout da saga;
- enter é emitida com deadline herdado já expirado;
- o parent termina incompleto ou desconhecido;
- uma ordem GTC pode continuar conhecida remotamente mesmo após timeout local.

### 11.6 Timeout não mata GTC

`omsSink.waitForFinal` executa kill-on-timeout somente para ordens imediatas:

- FAK;
- FOK.

Para GTC:

- timeout pode produzir estado `UNKNOWN`;
- não há cancelamento automático equivalente;
- `UNKNOWN` não é terminal.

### 11.7 `orphanOrders` não é proteção suficiente

Na reconciliação:

- uma ordem GTC conhecida e `LIVE` não é necessariamente classificada como unresolved;
- `orphanOrders` representa principalmente ordens remotas desconhecidas localmente;
- uma ordem conhecida, mas indevidamente resting, pode não elevar esse contador.

Portanto:

```text
orphanOrders == 0
```

não significa:

```text
não existem ordens GTC stale ou residuais
```

### 11.8 Cancelamento em rotação não cobre todos os estados

O engine procura ordens stale de `ENTER`, `EXIT` ou `REVERSE` na rotação, mas o cancelamento está condicionado ao estado da posição.

Se ainda existir posição aberta/residual, a GTC pode sobreviver além do momento esperado.

### 11.9 Veredito

O patch atual não deve ser deployado no formato encontrado.

Problemas mínimos a resolver antes de reconsiderá-lo:

- tipos separados por perna;
- cancelamento explícito;
- deadline coerente;
- reconciliação por quantidade;
- teste de late fill;
- teste de rotação/settlement;
- inventário remoto de open orders;
- telemetria das ordens filhas.

---

## 12. Caso `REVERSE_EXIT_INCOMPLETE`

Mercado:

`btc-updown-5m-1784953500`

### 12.1 Entrada

- lado: `UP`;
- quantidade: 2;
- fill reportado: aproximadamente 0,68;
- posição aberta normalmente.

### 12.2 Sinal de reverse

No momento da submissão:

- segundos restantes: 6,56;
- exit bid do token UP: 0,93;
- ask do lado DOWN: 0,07;
- max price da compra DOWN: aproximadamente 0,09;
- order type: FAK.

O parent REVERSE terminou:

- `REVERSE_EXIT_INCOMPLETE`;
- latência: aproximadamente 398 ms;
- quantidade parent reportada como zero.

### 12.3 O que não está registrado

O audit não mostra adequadamente:

- ID da ordem filha de exit;
- quantidade exata enviada na filha;
- fill parcial da filha;
- resposta bruta normalizada;
- quantidade residual após a filha;
- cancelamento do remainder;
- estado remoto final;
- motivo CLOB detalhado.

Assim, não é possível concluir se ocorreu:

- zero liquidez;
- parcial não reconciliado;
- rejeição;
- timeout;
- evento websocket ausente;
- erro de posição;
- deadline;
- transição inválida no OMS.

### 12.4 Recusas após a primeira falha

Nos registros raw do mesmo mercado foram encontradas:

| Recusa | Quantidade |
|---|---:|
| `REVERSE:MAX_NOTIONAL_EVENT` | 4 |
| `REVERSE:CIRCUIT_OPEN` | 196 |

Isso mostra que, após a primeira tentativa:

- o fluxo de recuperação não permaneceu livre para tentar novamente;
- risco e circuit breaker se tornaram parte causal do resultado operacional;
- atribuir toda a falha apenas ao FAK/book fino é inadequado.

### 12.5 Efeito financeiro desse caso

O winner final foi `UP`, o mesmo lado da posição original.

Portanto:

- manter a posição resultou em ganho;
- completar a reversão para `DOWN` teria produzido resultado pior naquele mercado.

Isso não torna a falha aceitável. O robot emitiu uma proteção e não conseguiu executá-la como especificado.

Mas demonstra que:

> `REVERSE_EXIT_INCOMPLETE` é evidência de falha operacional, não evidência automática de PnL perdido.

---

## 13. Problemas nas ferramentas de auditoria

### 13.1 Campo `rejected` versus `denied`

Os scripts:

- `analyze-prod-audit.mjs`;
- `diagnose-reverse.mjs`;

procuram:

```js
o.rejected
```

O engine grava:

```js
denied
```

Consequência:

- `rejectReasonTop` apareceu vazio;
- reverse rejected apareceu como zero;
- 200 recusas reais ficaram invisíveis na análise agregada.

### 13.2 Settlements duplicados

Nos dois arquivos raw atuais:

- eventos `position_settled`: 69;
- mercados únicos: 40;
- mercados com repetição: 9;
- um mercado aparece 13 vezes;
- outros aparecem duas, três ou quatro vezes.

Essas linhas possuem timestamps distintos e são eventos repetidos, não simples duplicatas textuais.

Qualquer agregação de PnL baseada em contar todos os `position_settled` sem chave idempotente pode superestimar:

- número de trades;
- PnL;
- settlements;
- frequência de resolução.

### 13.3 Diagnóstico stale

`prod-reverse-diagnosis.json` foi gerado em um snapshot anterior:

- 39 trades;
- aproximadamente +$1,33.

O `prod-trades.json` final contém:

- 40 trades;
- aproximadamente +$2,6656.

Relatórios devem registrar:

- timestamp de geração;
- hash dos inputs;
- número de linhas;
- último evento;
- versão do script.

### 13.4 Ausência de decisões quietas

`engineApp.js` grava uma decisão quando há, entre outros gatilhos:

- intent aceito;
- mudança de estado;
- denial relevante.

Se a estratégia apenas observa:

- sem intent;
- sem denial;
- sem mudança de estado;

o audit não registra o tick decisório.

Assim, análises do tipo:

> “não houve cross, late flip ou condição de saída”

não podem ser comprovadas somente pela ausência de uma linha de audit.

### 13.5 Breadcrumb proposto é insuficiente

Registrar somente:

```js
diagnostics.lateFlip.active === true
```

não resolve.

No avaliador, `active` já significa que:

- está na janela;
- houve cross;
- bid está válido;
- uma ação REVERSE/EXIT deve ser produzida.

Essa ação tende a ser auditada como accepted ou denied.

O que falta é um heartbeat terminal enquanto existir posição, contendo:

- `secsLeft`;
- `inWindow`;
- `signedDistance`;
- `crossed`;
- `bidOk`;
- bids/asks dos dois lados;
- feed health;
- loop heartbeat;
- posição;
- risco/circuit state.

Sugestão de throttle:

- uma amostra a cada 250–500 ms nos segundos terminais.

---

## 14. Problema no trade journal e na análise de slippage

Em `src/oms/tradeJournal.js`, no processamento de ENTER:

```js
trade.entryPrice = order?.price ?? row.position?.avgPrice ?? trade.entryPrice;
```

`order.price` representa o preço limite/worst permitido, não necessariamente o preço médio preenchido.

Como o valor deixa de ser `null`, o settlement posterior não o substitui pelo `avgPrice` real.

Exemplos observados:

| Mercado | Journal | Fill/PnL compatível com |
|---|---:|---:|
| `1784931300` | 0,66 | aproximadamente 0,51 |
| `1784933100` | 0,60 | aproximadamente 0,53 |
| `1784965200` | 0,89 | aproximadamente 0,88 |
| `1784963700` | 0,69 | aproximadamente 0,68 |

Consequências:

- o PnL de settlement pode continuar correto;
- o campo `entryPrice` fica incorreto/mal nomeado;
- exemplos de “fill drift” baseados nele não são numericamente confiáveis;
- comparação live versus BT por entry price fica contaminada.

### Correção recomendada

Separar:

- `requestedLimitPrice`;
- `submittedPrice`;
- `avgFillPrice`;
- `worstFillPrice`;
- `filledQty`;
- `requestedQty`.

O `entryPrice` usado em performance deve ser:

```text
Σ(fillPrice × fillQty) / Σ(fillQty)
```

e nunca o preço limite do request.

---

## 15. Comparação de fees

O BT amplo aplica fees depois de `runner.finish()` e recalcula os eventos e o summary.

Resultado:

- PnL BT de `$24,2191` está após `$5,3532` em fees simuladas.

Entretanto, o script `compare-all-live.js` captura `event.finalPnl` no callback de finalização antes da etapa posterior de aplicação de fees.

Consequência:

- os `$4,0102` da paridade capturada são essencialmente PnL bruto;
- os `$24,2191` do resumo amplo são PnL após fees;
- os `$2,6656` live não têm fee basis reconciliada de forma equivalente.

O relatório principal mistura esses números em algumas comparações agregadas.

### Regra recomendada

Todo relatório deve exibir quatro colunas separadas:

| Base | Live | BT |
|---|---:|---:|
| Gross realized PnL | valor | valor |
| Entry fees | valor | valor |
| Exit fees | valor | valor |
| Net realized PnL | valor | valor |

Além disso:

- fee deve vir dos fills reais quando live;
- o mesmo modelo de fee deve ser aplicado ao BT;
- não estimar fee usando `entryPrice` atual do journal enquanto ele estiver incorreto.

---

## 16. Classificação revisada das causas

### 16.1 Confirmadas

| Causa | Status | Evidência |
|---|---|---|
| Janelas live/BT incompatíveis | Confirmada | timestamps dos trades e BT |
| Lake incompleto após ~07:50 UTC | Confirmada | 15 `bt_missing` após 07:55 |
| Múltiplos builds/starts no live | Confirmada | audit `engine_started` |
| Winner derivado incorretamente | Confirmada | Gamma UP versus BT DOWN |
| Fonte de settlement diferente da fonte canônica | Confirmada | spot/RTDS no código versus Chainlink na regra |
| Operador de empate incorreto | Confirmada | `>` no código versus `>=` na regra |
| Simulador não modela execução live completa | Confirmada | leitura do código |
| Audit agregado lê campo errado | Confirmada | `rejected` versus `denied` |
| Settlements repetidos | Confirmada | 69 rows para 40 mercados |
| Journal usa limite como entry price | Confirmada | ordem de prioridade no código |
| REVERSE parent falhou uma vez | Confirmada | `REVERSE_EXIT_INCOMPLETE` |
| Retries posteriores bloqueados por risco/circuit | Confirmada | 4 + 196 denials |

### 16.2 Prováveis, mas ainda não quantificadas

| Causa | Status |
|---|---|
| Latência contribui para diferença de fill | Provável |
| FAK zero-fill contribui para perda de entradas | Provável |
| Fill parcial/residual contribui para divergência | Provável |
| Mudança do book entre decisão e ordem contribui | Provável |
| Deploys/DISARMED reduzem cobertura live | Provável e parcialmente observável |
| Risco/circuit impede recuperação em outros casos | Possível; confirmado em um mercado |

### 16.3 Não demonstradas ou incorretas

| Hipótese | Veredito |
|---|---|
| FAK é all-or-none | Incorreta |
| `ignoreConsumed:true` garante fill | Incorreta |
| Os 17 `bt_missing` são todos eventos faltando no lake por falha | Não demonstrada |
| 40 versus 125 mede cobertura de execução | Incorreta metodologicamente |
| GTC garante fill | Incorreta |
| GTC é estritamente aditivo | Incorreta |
| O lab prova o benefício causal de GTC | Não demonstrada |
| `REVERSE_EXIT_INCOMPLETE` foi causado por book fino | Não demonstrada |
| O caso de reverse incompleto causou perda financeira | Falso nesse mercado específico |
| WR semelhante confirma edge | Evidência insuficiente |

---

## 17. Arquitetura de solução proposta

### 17.1 Labels e dados

Implementar uma camada de settlement canônico:

```text
Gamma/CLOB market_resolved/Chainlink
                ↓
resolvedOutcome + provenance
                ↓
event lakehouse
                ↓
backtest settlement
```

Requisitos:

- idempotência por market/condition;
- atualização de label provisório para canônico;
- auditoria de fonte;
- teste de empates;
- relatório de divergência entre RTDS e Chainlink;
- bloqueio de publicação de métricas finais quando label ainda for provisório.

### 17.2 Parity harness

Criar um dataset de comparação por mercado:

```text
marketId
sourceCommit
presetHash
parameterHash
operatorState
feedHealth
eligibleAt
intentAt
submittedAt
ackAt
filledAt
resolvedOutcome
grossPnl
fees
netPnl
```

Cada mercado deve terminar em uma categoria exclusiva:

- não observado pelo robot;
- robot DISARMED;
- feeds inválidos;
- não elegível por gate;
- intent emitido;
- intent bloqueado por risco;
- submit rejeitado;
- zero fill;
- fill parcial;
- fill completo;
- exit/reverse;
- settlement.

### 17.3 Execução de saída

Separar configuração:

```js
entryOrderType
exitOrderType
reverseExitOrderType
reverseEntryOrderType
```

Proposta inicial:

- entrada normal: FAK;
- reverse exit: FAK com suporte explícito a parcial;
- retry somente sobre quantidade residual;
- reprice a partir de book atualizado;
- número e tempo de retries limitados;
- reverse enter: FAK;
- emitir enter apenas depois de confirmar posição anterior zerada;
- se não zerar, abortar a entrada oposta e registrar residual.

### 17.4 Se GTC for experimentado

Exigir:

- TTL local curto;
- cancelamento explícito;
- cancelamento confirmado remotamente;
- reconciliação de fills ocorridos durante cancelamento;
- proibição de emitir a perna seguinte enquanto houver residual/open order;
- cancel-on-rotation;
- cancel-on-expiry-window;
- teste de restart;
- teste de websocket atrasado;
- inventário remoto de open orders.

### 17.5 Telemetria de ordens filhas

Para cada child leg:

- parent intent ID;
- child intent ID;
- exchange order ID protegido/abreviado;
- kind/side/type;
- preço limite;
- quantidade solicitada;
- quantidade preenchida;
- quantidade residual;
- fill médio e pior fill;
- book no submit;
- ACK/reject;
- latência;
- cancel request;
- cancel confirmation;
- estado reconciliado.

---

## 18. Plano de execução recomendado

### P0 — Corrigir a base de verdade

1. Não deployar o patch GTC atual.
2. Adicionar outcome canônico ao lake.
3. Corrigir `>` para `>=`.
4. Reprocessar os mercados do relatório.
5. Recalcular o gap com labels corretos.

### P0 — Corrigir observabilidade

1. Trocar `rejected` por `denied` nos scripts.
2. Deduplicar settlement por chave idempotente.
3. Corrigir `entryPrice`.
4. Adicionar child-leg audit.
5. Adicionar heartbeat terminal de posição.
6. Versionar inputs/outputs dos relatórios.

### P1 — Construir comparação apples-to-apples

1. Selecionar um único `sourceCommit`.
2. Selecionar mercados presentes no lake.
3. Recortar somente intervalos ARMED e feeds válidos.
4. Usar os mesmos parâmetros e wallet state.
5. Separar decisão de execução.
6. Comparar gross/gross e net/net.

### P1 — Corrigir execução de REVERSE

1. Separar order type por perna.
2. Reconciliar parcial.
3. Retry residual com book atualizado.
4. Impedir entrada oposta stale.
5. Cancelar qualquer remainder.
6. Testar deadlines e timeouts.

### P2 — Calibrar o simulador

Estimar empiricamente, por bucket:

- segundos restantes;
- side;
- bid/ask;
- spread;
- profundidade;
- quantidade;
- latência;
- probabilidade de zero/partial/full fill;
- slippage;
- risco/circuit denial.

Usar essas distribuições no backtest de execução.

### P3 — Reavaliar parâmetros da estratégia

Somente após P0–P2:

- reavaliar `minSecondsLeft`;
- danger;
- early warn;
- book collapse;
- reverse;
- budgets;
- número de retries.

Os labs atuais não justificam tuning como solução primária da divergência.

---

## 19. Testes necessários

### 19.1 Settlement

- Chainlink UP e spot DOWN → usar outcome canônico UP.
- Chainlink DOWN e spot UP → usar outcome canônico DOWN.
- close igual ao open → UP.
- label provisório não pode virar resultado final silenciosamente.
- atualização canônica deve ser idempotente.

### 19.2 FAK parcial

- requested 3, fill 2,11 → posição 2,11 e residual cancelado.
- retry recebe apenas 0,89.
- zero fill → posição inalterada.
- websocket e REST discordantes → reconciliar antes de repetir.

### 19.3 REVERSE

- exit completo → emitir enter.
- exit parcial → não emitir enter.
- exit zero → não emitir enter.
- retry residual completa → emitir enter somente depois da confirmação.
- deadline expira entre pernas → não emitir enter.
- circuit open → registrar bloqueio causal.
- risco MAX_NOTIONAL → registrar bloqueio causal.

### 19.4 GTC, caso mantida como experimento

- parcial + remainder resting.
- cancel confirmado.
- fill durante cancel.
- timeout local com ordem ainda LIVE.
- restart com ordem remota.
- rotação de mercado.
- settlement próximo.
- nenhuma ordem sobrevive ao TTL definido.

### 19.5 Audit/journal

- `denied` aparece no agregado.
- settlement repetido não duplica trade/PnL.
- preço médio ponderado de múltiplos fills.
- limite solicitado permanece separado do fill real.
- relatório rejeita inputs de snapshots inconsistentes.

---

## 20. Critérios de aceite

Antes de declarar paridade:

- 100% dos mercados classificados em categoria exclusiva;
- zero uso silencioso de label spot como canônico;
- zero winner divergente após canonicalização;
- mesmo build/preset nos dois lados;
- períodos DISARMED excluídos do denominador;
- gross e net reconciliados separadamente;
- fills reais registrados por quantidade/preço;
- todas as pernas de reverse auditadas;
- denials de risco presentes nos relatórios;
- nenhum settlement duplicado no PnL.

Antes de um canário de execução:

- testes unitários e de integração passando;
- replay dos casos conhecidos;
- nenhuma GTC residual em simulação;
- cancelamento/reconciliação testados;
- engine explicitamente DISARMED durante validação técnica;
- plano live específico apresentado para aprovação;
- budget e limites não ampliados implicitamente;
- observação pós-deploy definida por métricas, não somente health.

Métricas mínimas do canário:

- taxa de intents;
- taxa de zero fill;
- taxa de partial fill;
- quantidade residual;
- retries por ordem;
- reverse exit completion;
- reverse total completion;
- denials por risco;
- latência submit→ACK;
- latência ACK→fill;
- stale/open orders;
- PnL bruto;
- fees;
- PnL líquido.

---

## 21. Decisões recomendadas

| Decisão | Recomendação |
|---|---|
| Deploy imediato do patch GTC | **Não aprovar** |
| Manter entrada normal FAK | **Sim, por enquanto** |
| Usar FAK parcial + retry residual na saída | **Implementar e testar primeiro** |
| Separar order type das pernas REVERSE | **Obrigatório** |
| Usar outcome canônico no BT | **Obrigatório/P0** |
| Tratar 40 vs 125 como coverage gap | **Descontinuar** |
| Usar o lab atual como prova de GTC | **Não** |
| Usar o lab como evidência de valor potencial da proteção | **Sim, com ressalvas** |
| Fazer tuning da estratégia agora | **Adiar** |
| Construir parity harness por mercado/build | **Prioridade alta** |

---

## 22. Conclusão final

O núcleo da estratégia apresenta um sinal encorajador: quando live e backtest entram nos mesmos mercados capturados, ambos escolhem o mesmo lado.

Porém, o gap de PnL e cobertura apresentado inicialmente não pode ser atribuído principalmente ao FAK porque:

- as janelas não coincidem;
- o live passou por múltiplos commits e estados operacionais;
- o lake termina antes da janela live;
- existe winner incorreto no backtest;
- fees não estão na mesma base;
- o journal não registra corretamente o preço médio;
- a auditoria omite denials nos scripts;
- o simulador não modela execução real;
- o caso principal de reverse não possui telemetria das pernas filhas.

O erro de settlement sozinho explica aproximadamente dois terços do gap bruto dos mercados capturados. Isso muda a prioridade da investigação: antes de alterar o tipo de ordem, é necessário corrigir a base de verdade.

A alteração GTC atual cria riscos novos e não controlados:

- GTC não garante fill;
- a entrada da reversão também vira GTC;
- deadlines e timeouts são incompatíveis;
- ordens conhecidas podem permanecer resting sem aparecer como orphan;
- cancelamento e reconciliação não estão demonstrados.

A solução mais segura é tratar execução como uma máquina de estados por quantidade:

```text
solicitar saída
→ reconciliar fill
→ calcular residual
→ retry residual limitado
→ confirmar posição zerada
→ somente então abrir lado oposto
```

Essa solução deve ser acompanhada por settlement canônico, telemetria completa e uma nova comparação feita sobre a interseção exata de mercados, dados, build e estado ARMED.

Somente depois disso será possível medir com credibilidade:

- quanto do gap é seleção;
- quanto é execução;
- quanto é infraestrutura;
- quanto é fee/slippage;
- e se GTC, FAK com retry ou outra política produz o melhor resultado ajustado ao risco.

---

## 23. Estado dos repositórios durante a revisão

Snapshot observado:

- `data-backtest` HEAD: `2b8422e3ab26b897761a4b0cfbd2eaf3ff2baf37`;
- `data-robot` HEAD: `f0713ea16ed54c14de2336cd6226026f62659f00`;
- patch FAK→GTC presente apenas como modificação local não commitada no `data-robot`;
- relatórios e artefatos em `scratch/live-vs-backtest` estavam untracked;
- nenhuma modificação operacional, deploy ou ordem live foi executada nesta revisão.
