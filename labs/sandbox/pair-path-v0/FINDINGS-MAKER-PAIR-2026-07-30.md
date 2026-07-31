# Estudo exaustivo Pair-Path / Clip-Path / Shotandgo — 2026-07-30

**Escopo:** exploração no dia 29 (2026-07-29), validação em 99 dias
(2026-04-23 … 2026-07-30), BTC 5m, depth 25.

## Decisão

**A família "complete-set por perna temporal" está REJEITADA no lake e no
harness atuais.** O grid de descoberta avaliou 645 políticas no dia 29 sob
duas hipóteses de fee; 13 políticas representativas, também sob as duas
hipóteses, foram levadas às 99 partições e todas perderam. Isso não equivale a
645 políticas validadas fora da amostra nem prova impossibilidade universal.

O que muda em relação à auditoria de 2026-07-29: aquela rejeitou o *preset*
amplo. Este estudo identifica **por que nenhum preset dessa família pode
funcionar**, e mede o teto.

## O limite estrutural observado

> Para uma ordem em repouso, **o desconto em relação ao touch no momento da
> postagem é exatamente igual ao movimento adverso necessário para preenchê-la.**

Uma ordem 5¢ abaixo do mercado só executa quando o mercado cai 5¢ — e nesse
instante você paga valor justo, não desconto. O colchão é cancelado pela seleção
adversa que concede o fill. Consequências:

1. Aprofundar a cotação **não escala** o edge, só reduz a taxa de fill.
2. A proteção passiva é impossível: o hedge que você quer é justamente o que
   encarece quando você precisa dele.
3. Isso explica de uma vez todos os fracassos maker históricos do repo (phantom
   fill da Escada Dupla, colapso do resting da Hopper-3, maker negativo em todas
   as bandas da MIDAS, WR da TFC caindo 91,8% → 63,6% com fill).

## Estrutura medida do book

157.869 ticks no dia 29:

| Métrica | Valor |
|---|---|
| `ask_UP + ask_DOWN` | 1,010 (95% dos ticks); mínimo 1,001 |
| `bid_UP + bid_DOWN` | 0,990 (95% dos ticks) |
| Spread por perna | 0,010 |
| Tick | 0,001 |
| Depth mediana no touch | ~300 shares |

**Arbitragem instantânea de complete-set: 0 de 157.869 ticks** com tamanho
lucrativo após fee taker, caminhando as 25 pontas. O piso líquido é 1,0011. Não
existe almoço grátis no topo do book.

## O muro aritmético

| Item | Valor |
|---|---|
| Prêmio de um par passivo | `1 − bidSum` = **1¢** |
| Custo de corrigir uma perna nua | `drift + fee taker` ≥ **1,75¢** no meio do book |
| Taxa de perna nua (cotação estática no touch) | **13%** |

Decomposição do `lockS-nocut-sets1` em 99 dias (25.269 eventos):

```text
21.901 pares formados        +1¢ cada
13,27% de eventos com nua    −47¢ em média
PnL/evento                   −0,0496  IC95 [−0,0518; −0,0474]
```

**A correção custa mais do que o acerto rende.** Cortar mais cedo não resolve:
o gatilho de 3¢ dispara 200 vezes para resolver 34 problemas reais, gastando
$3,25 de fee contra $2,30 de receita total.

## Calibração — onde o edge realmente está

99 dias, 25.269 eventos, 227.396 snapshots. IC95 por bootstrap **clusterizado
por dia** (ticks dentro de um evento são quase perfeitamente autocorrelacionados;
intervalo por tick seria ficção).

EV de comprar o favorito no ask e segurar:

| tau | win% | EV/share | IC95 |
|---|---|---|---|
| 240 | 65,6 | −0,0145 | [−0,0204; −0,0093] |
| 120 | 78,6 | −0,0067 | [−0,0116; −0,0022] |
| 60 | 85,2 | −0,0053 | [−0,0093; −0,0014] |
| 20 | 92,2 | +0,0007 | [−0,0028; +0,0042] |

O mercado é calibrado em `P(win) ≈ ask + fee` — o preço já embute a fee, deixando
o taker em EV zero. Por faixa de preço em tau=120:

| ask | win% | break-even | edge |
|---|---|---|---|
| 0,500–0,525 | 48,4 | 53,3 | **−4,85pp** |
| 0,600–0,625 | 60,0 | 63,2 | **−3,16pp** |
| 0,750–0,775 | 77,5 | 77,2 | +0,24pp |
| 0,925–0,950 | 95,3 | 94,5 | **+0,83pp** |

**A janela de open legada da Pair-Path (0,52–0,62) é o pior ponto do book:** fee
máxima (`0,07·p·(1−p)` é máxima em 0,50) *e* edge negativo. A zona 0,90–0,97 tem
edge positivo com fee 5× menor. Isso corrobora, por medição independente, onde a
TFC/MIDAS já opera.

## Hipóteses testadas e rejeitadas

| Hipótese | Amostra | Resultado | Veredito |
|---|---|---|---|
| Arb instantânea de complete-set | 157.869 ticks | 0 ticks lucrativos | impossível |
| Par maker estático no touch | 645 var / 25.269 ev | −0,0496 [−0,0518; −0,0474] | rejeitada |
| Par com desconto profundo (10–50 ticks) | 96 var | −0,128/evento (pior de todos) | rejeitada |
| Gate de book largo (bidSum ≤ 0,95) | 40 var | −0,0396 | rejeitada |
| Azarão profundo passivo ≤5¢ | 108 var, train/test | 0/108 positivas nos dois; edge −0,29 a −0,71pp | rejeitada |
| Proteção passiva na perna oposta | — | nunca preenche no flip | impossível |
| Rebate maker de 20% | — | cobre 12,2% da perda; restam −5,02¢/par | insuficiente |

## Dois bugs corrigidos no próprio harness

Ambos são da mesma classe que gerou os edges fantasma históricos do repo, e por
isso ficam registrados:

1. **Referência de fill.** O lake não contém a nossa própria ordem, então
   comparar o bid observado com o *nosso preço* faz uma ordem postada acima do
   touch preencher no tick seguinte. Comparar sempre com o *touch* faz uma ordem
   5¢ funda preencher com 1 tick de queda. A referência honesta é
   `min(preço, touch_na_postagem)`: acima do touch estávamos na frente da fila,
   no touch estávamos atrás dela, abaixo o fluxo tem de varrer até nós.
   Antes da correção, `improve3` aparecia como quase break-even — era fantasma.

2. **Gate de zona.** Aplicado por perna, uma zona de 0,88–0,98 só qualificava a
   perna favorita (o azarão cota 0,01–0,11), deixando o motor cotando um lado só
   e **nu por construção**. O gate tem de qualificar o *evento* pelo preço do
   favorito.

## Limite metodológico: erro de rótulo

O vencedor é inferido por `spot vs price_to_beat` no último tick disponível
(tau ≤ 15s). Medido:

- **11,12%** dos eventos mudam de vencedor entre tau≈30s e o último tick;
- **7,08%** entre tau≈10s e o último tick.

**Qualquer edge menor que alguns pontos percentuais é inmensurável com este
proxy.** Foi exatamente isso que produziu o falso positivo do azarão de 4¢ no dia
29 (+0,0043 no dia 29 → −0,0084 [−0,0110; −0,0055] em 99 dias). Estratégias cujo
edge vive na cauda tardia exigem resolução real, não proxy de último tick.

## Artefatos regeneráveis

| Script | Saída |
|---|---|
| [`day29-structure-probe.mjs`](./day29-structure-probe.mjs) | `.tmp/day29-structure-probe/` |
| [`calibration-probe.mjs`](./calibration-probe.mjs) | `.tmp/calibration-probe-all/` |
| [`mm-engine.mjs`](./mm-engine.mjs) + [`mm-grid.mjs`](./mm-grid.mjs) | `.tmp/mm-grid-*/` |
| [`deep-dog-probe.mjs`](./deep-dog-probe.mjs) | `.tmp/deep-dog-probe/` |

Todo grid roda sob as duas hipóteses de fee (`mf0` = isenção maker documentada,
`mf7` = piso pessimista em que o passivo paga taker). Nenhuma conclusão deste
documento depende de qual delas é verdadeira.

## Adendo: a isenção maker é REAL (e não salva a tese)

Auditoria de execução em 2026-07-30 resolveu a contradição de fee com evidência
de fill real da **nossa** carteira (`0x6dd3DA3e...`), em
`data-robot/runs/fee-taker-1783565559389.json`: uma GTC a 0,36 × 5 shares
descansou e foi atingida, `trader_side: "MAKER"`, `balanceDelta = −1,8` =
exatamente `0,36 × 5` → **fee implícita $0,00** (a taker teria sido $0,08064).
O taker foi confirmado à parte com rate **0,07** (diferença 1e-5 da fórmula).

O estudo que concluía "99,96% dos fills pagaram taker" rodou sobre a carteira de
**terceiro** `0x0484e6...` (Doggy), em `doggy-below-bid-paradox.mjs:13` — não é a
nossa. **A isenção nunca foi refutada; nunca foi exercida**, porque todo o motor
é marketable por construção (`micro-live.js:618` `limitPx = Math.min(ask, …)`;
`preset-midas.js:159` entry `FAK`). `postOnly` está plumbado em
`liveTransport.js:103→212`, mas **nenhum caller passa `true`**.

Isso **não altera a rejeição**: a coluna `mf0` já assume fee zero, e o par
passivo continua em −0,0496/evento [IC95 −0,0518; −0,0474]. A perda vem da perna
nua, não da fee.

## Adendo: causa-raiz do latch do circuit breaker

`CIRCUIT_OPEN` **não está** em `EXPECTED_POLICY_DENIALS` (`runtime.js:22-33`),
então `runtime.js:264-273` faz uma negação por CIRCUIT_OPEN chamar
`recordFailure()` novamente — a cada 5 negações o breaker reabre com janela nova.
**Latch auto-sustentado**, o que explica as 196 negações `CIRCUIT_OPEN` do
incidente. São dois breakers com threshold 5: `src/risk/circuitBreaker.js`
(cooldown 60s) e `liveTransport.js:56-79` (30s), ambos avaliados antes de
qualquer discriminação por tipo de intent e antes de `postOnly` ser lido — logo
bloqueiam ordem maker passiva exatamente como bloquearam os `EXIT`.

## O que não fazer

- Não procurar outra escada, outro avgSum, outro nível de clip nesta família: o
  limite é o prêmio de 1¢ contra correção de 1,75¢, não a parametrização.
- Não abrir em 0,52–0,62: é o pior ponto do book em fee e em calibração.
- Não contar com proteção passiva: ela falha exatamente quando é necessária.
- Não usar rótulo de último tick para validar edge de cauda tardia.
- Não tratar desconto de ordem funda como colchão: ele é o movimento adverso.
