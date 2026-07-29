# MIDAS — o envelope não é o problema; a proteção que não preenche é

**Data:** 2026-07-28
**Escopo:** MIDAS Carry V1, BTC/ETH/SOL/XRP/DOGE 5m, lakehouse local (parquet depth 25) + motor GLS oficial
**Estado:** pesquisa. Nenhuma configuração live, deploy ou ordem foi alterada.

---

## Veredito executivo

A queixa operacional — *"muitos acertos, ganha pouco neles e um erro leva quase
tudo"* — não é uma propriedade do envelope da MIDAS. É a assinatura exata da
MIDAS **rodando sem a camada de proteção**. E é isso que a conta real está
rodando hoje.

A prova é o perfil de payoff. Duas amostras live independentes e as duas
configurações do lab, na mesma métrica:

| Fonte | ganho médio | perda média | razão G/P | wins por perda |
|---|--:|--:|--:|--:|
| LIVE 24–25/07 (`prod-trades`, micro $2/$4) | 0,530 | 1,800 | **0,294** | 3,40 |
| LIVE BTC deduplicado (137 mercados) | 0,595 | 1,830 | **0,325** | 3,08 |
| LAB `base-hold` ($10/$30) | 3,075 | 10,099 | **0,304** | 3,28 |
| LAB `base-protect` ($10/$30) | 3,160 | 7,403 | **0,427** | 2,34 |

O live cai exatamente em cima do `hold` (0,294 e 0,325 contra 0,304) e longe do
`protect` (0,427). Isso confirma por medida independente o que o audit já dizia
em texto: **os 8 losses live foram todos `exitKind: SETTLEMENT`** — nenhuma
ordem protetora preencheu.

O custo dessa diferença, no motor oficial, janela julho 01–25, execução honesta
(settle 0,995), sizing $10/$30:

| Configuração | PnL | PF | MaxDD | Pior dia | razão G/P |
|---|--:|--:|--:|--:|--:|
| `base-protect` (o que foi validado) | 1.933,6 | 1,577 | 55,3 | **−2,04** | 0,427 |
| `base-hold` (o que a conta real executa) | 1.201,0 | 1,325 | 65,8 | **−27,45** | 0,304 |

**A camada de proteção vale 38% do PnL e 13× o pior dia.** Não existe ajuste de
preset que compense isso, e este relatório mostra quatro tentativas de
substituí-la que falharam.

---

## 1. Quatro mecanismos novos — testados e reprovados

Foram construídos e medidos quatro candidatos a "nova MIDAS" que atacariam a
assimetria de payoff diretamente. **Os quatro foram reprovados com evidência.**
Registrados aqui para que não sejam reabertos sem hipótese nova.

### 1.1 Complete-set lock — comprar o lado oposto para travar lucro

**Ideia:** depois de entrar comprado no favorito, comprar o lado oposto trava um
resultado garantido: `lockPnl/share = 0,995 − askEntrada − askOposto − fees`.
Se positivo, o evento vira lucro certo e o pior caso do evento vai a zero.

**Resultado (9.700 entradas BTC, política causal — travar no primeiro tick que
cruza o limiar):**

| Limiar | eventos que cruzam | % | lucro travado médio/share | vs segurar |
|---|--:|--:|--:|--:|
| ≥ 0,00 | 8.565 | 88,3 | +0,0220 | +0,0711 |
| ≥ 0,02 | 8.148 | 84,0 | +0,0421 | +0,0876 |
| ≥ 0,05 | 6.160 | 63,5 | +0,0739 | +0,1225 |

**Reprovado.** O lock existe e é abundante (84% dos eventos atingem +0,02/share),
mas custa **~52% do EV**. Vender o próprio no bid dá quase exatamente o mesmo
(+0,0415 contra +0,0830). O book é eficiente: fechar cedo sempre paga o spread
mais a fee. É ferramenta de redução de variância, não de lucro.

### 1.2 Entrada maker — postar passivo em vez de pagar o ask

**Ideia:** a fee taker é `0,07·p·(1−p)` por share e come 20–40% do edge bruto nas
bandas média e barata. Fill maker é isento de fee na Polymarket (o lab já modela
isso: `src/backtest/fees.js:329-334`). Postar no bid economiza fee + spread.

**Resultado** (regra de fill do simulador, deliberadamente pessimista: só
preenche quando o ask CAI através do preço postado — seleção adversa integral):

| Banda | fill % | preço maker | WR maker | edge maker | EV/$ maker |
|---|--:|--:|--:|--:|--:|
| [0,30–0,55) | 87,6 | 0,415 | 40,8% | −0,83pp | −0,0199 |
| [0,55–0,70) | 72,7 | 0,613 | 55,5% | −6,10pp | −0,0989 |
| [0,70–0,82) | 67,3 | 0,750 | 70,6% | −4,78pp | −0,0634 |
| [0,82–0,94] | 57,5 | 0,883 | 84,5% | −4,29pp | −0,0483 |

**Reprovado em todas as bandas.** A seleção adversa é total: a WR desaba 6–12pp
(ex.: 91,0% → 84,5%) enquanto o preço melhora só ~1,3c. Confirma a intuição do
repositório de nunca usar GTC na entrada.

### 1.3 Realocação de banda — cortar o favorito caro

**Ideia (vinda da medição em parquet):** o complexo `ask ≥ 0,82` é ~50% dos
trades, tem razão ganho/perda 0,10 e **edge ~zero replicado em 5 ativos × 3
janelas**. Cortá-lo deveria remover a cauda sem custar EV.

**Resultado no motor oficial (julho 01–25):**

| Variante | PnL | PF | MaxDD | Pior dia | razão G/P |
|---|--:|--:|--:|--:|--:|
| `gold-baseline` | 1.933,6 | 1,577 | 55,3 | **−2,04** | 0,427 |
| `notier-94` (tier 1,5 → 1,0) | 1.826,1 | **1,588** | **52,7** | −3,06 | 0,429 |
| `nohigh-82` (corta ask ≥ 0,82) | 1.686,4 | 1,592 | 56,4 | −6,87 | 0,577 |
| `nohigh-82-wide` (+ banda barata) | 1.428,9 | 1,319 | 96,6 | **−60,45** | 0,699 |
| `cheap-30-70` (só banda barata) | 972,1 | 1,246 | 106,0 | **−54,79** | 0,929 |

**Reprovado.** Cortar a banda cara custa 13% do PnL **e piora o pior dia**
(−2,04 → −6,87). Descer para a banda barata é catastrófico (pior dia −60, DD 97)
apesar de ter a melhor razão G/P (0,93) — prova de que razão de payoff sozinha
não é objetivo.

**A reconciliação é o achado importante:** o valor da banda cara não vem do carry
bruto, vem **da camada de proteção**. Em `hold`, os mesmos 540 trades caros valem
pouco; em `protect`, valem +$247. Ou seja, quando a proteção não preenche — o
caso do live — metade do livro vira downside puro.

### 1.4 Hedge stop — proteção pré-posicionada que não precisa vender

**Ideia (a mais promissora):** o problema do live é vender numa perna que está
colapsando. Um stop-buy no lado **oposto** inverte isso: é armado aos 20s (book
grosso), dispara sozinho quando o ask do oposto sobe através do gatilho, e compra
numa perna cuja liquidez está **crescendo**. Não exige achatar antes, então é
compatível com o ledger `R_event`.

Implementado no GLS (`hedgeStop*`, 8 params novos), portado de
`TerminalFavoriteCarry.gls`.

O smoke de 4 dias foi animador (204,7 contra 179,5 do baseline completo). **Em 25
dias, desmoronou:**

| Variante | PnL | PF | MaxDD | Pior dia |
|---|--:|--:|--:|--:|
| `base-hold` (referência) | 1.136,8 | 1,275 | 76,9 | −35,39 |
| `hedge25-hold` | 629,6 | 1,153 | 89,6 | −64,48 |
| `hedge20-hold` | 407,4 | 1,094 | 112,3 | −87,19 |
| `hedge15-hold` | −2,4 | 0,999 | 95,8 | −82,74 |

**Reprovado.** Todas as variantes perdem para o `base-hold`, e o pior dia
degrada de −35 para −87. A causa é whipsaw: o ask do oposto dispara, o hedge
compra, e o favorito original vence assim mesmo. É exatamente o modo de falha já
documentado para `earlyWarn`, `bookCollapse` e o exit puro de odds-shock
(whipsaw 74–80%). O código fica no GLS desligado por default (`hedgeStopEnabled:
false`) para reuso, não para promoção.

---

## 2. A medição de banda: o que ela mostrou e o que ela não autoriza

A medição em parquet (uma entrada por evento, settlement 0,995, fee honesta) deu
um resultado forte e um resultado frágil. Vale separar.

### Forte e replicado: a banda cara não tem edge

| Ativo | [0,30–0,55) | [0,55–0,70) | [0,70–0,82) | [0,82–0,94] |
|---|--:|--:|--:|--:|
| BTC | +2,73pp | +2,66pp | +2,29pp | **+0,25pp** |
| ETH | +1,94pp | +0,40pp | +0,81pp | **−0,17pp** |
| SOL | −1,41pp | +0,31pp | +2,74pp | **+0,51pp** |
| XRP | +1,56pp | +0,62pp | +1,39pp | **−0,01pp** |
| DOGE | −0,21pp | −5,29pp | +0,20pp | **+0,12pp** |

Somando os cinco ativos, `ask ≥ 0,82` dá −0,40 / +0,05 / +0,50 pp em
treino/junho/julho — todos com IC95% cruzando zero. É ~50% dos trades e razão
ganho/perda 0,10. **Esse achado é sólido.** Só não implica "cortar" (§1.3): a
banda paga o seu lugar através da proteção, não do carry.

### Frágil e não replicado: a banda barata

O BTC sozinho sugeria +2,73pp na banda [0,30–0,55) sobrevivendo a 3s de latência
— tentador. Mas **não replica**: SOL inverte (−1,41pp) e DOGE destrói (−5,29pp em
[0,55–0,70)). Agregado, a banda barata dá +2,15 / +0,01 / +0,96 pp nas três
janelas, com IC cruzando zero. É fenômeno de BTC/ETH, não estrutura de mercado.

O motor confirmou o veredito de forma brutal: `cheap-30-70` pior dia −54,79.
**A antiga rejeição do `scoop` continua de pé** — por motivo diferente do
original (não é só alfa de latência; é que o whipsaw da banda marginal destrói o
resultado quando o reverse entra em cena).

---

## 3. O que funciona: otimizar para o mundo `hold`

Toda a calibração anterior da MIDAS foi feita no mundo `protect`, que assume que
a venda protetora preenche. O live prova que ela não preenche. Ninguém tinha
otimizado a estratégia **para o mundo em que ela realmente roda**.

Restrição de projeto: só valem alavancas que **não dependem de vender numa perna
que está colapsando** — gates de prevenção na entrada, teto de perda, e saídas
que agem cedo, enquanto ainda existe bid de verdade.

### Julho 01–25, sizing $10/$30, execução honesta

| Variante | PnL | PF | razão G/P | MaxDD | Pior dia | Dias+ |
|---|--:|--:|--:|--:|--:|--:|
| `ceiling-protect` (teto teórico) | 1.933,6 | 1,577 | 0,427 | 55,3 | −2,04 | 24/25 |
| **`hold-os-cushion`** | **1.370,1** | **1,418** | **0,428** | **56,5** | **−17,17** | 23/25 |
| `hold-os-oddsvel` | 1.281,1 | 1,371 | 0,354 | 56,6 | **−14,01** | 23/25 |
| `hold-os-distgate12` | 1.201,2 | 1,340 | 0,371 | 63,2 | −29,17 | 22/25 |
| `hold-os` (referência = o live) | 1.201,0 | 1,325 | 0,358 | 65,8 | −27,45 | 22/25 |
| `hold-os-osfull` | 1.182,6 | 1,338 | **0,457** | 62,7 | −27,52 | 22/25 |
| `hold-os-notier` | 1.079,3 | 1,311 | 0,353 | 56,8 | −28,39 | 23/25 |
| `hold-os-maxloss10` | 1.079,3 | 1,311 | 0,353 | 56,8 | −28,39 | 23/25 |
| `hold-os-late20` | 802,9 | 1,340 | 0,353 | 54,0 | −50,66 | 20/25 |

### Junho 01–09 (stress) — replicação

| Variante | PnL | PF | razão G/P | MaxDD | Pior dia | Dias+ |
|---|--:|--:|--:|--:|--:|--:|
| `ceiling-protect` | 687,5 | 1,666 | 0,488 | 57,7 | −25,53 | 8/9 |
| **`hold-cushion55`** | **360,4** | **1,316** | **0,534** | **102,8** | **−46,92** | 7/9 |
| `hold-cushion45` | 358,1 | 1,315 | 0,541 | 104,8 | −50,13 | 7/9 |
| `hold-cushion65` | 334,5 | 1,287 | 0,511 | 106,6 | −58,19 | 7/9 |
| `hold-os` (referência) | 304,1 | 1,231 | 0,385 | 125,9 | −86,42 | 6/9 |

**O `cushionDecay` replicou nas duas janelas, em todas as métricas que importam:**

| Métrica | Julho | Junho |
|---|---|---|
| PnL | +14,1% | +18,5% |
| PF | 1,325 → 1,418 | 1,231 → 1,316 |
| **razão ganho/perda** | **0,358 → 0,428** | **0,385 → 0,534** |
| MaxDD | −14% | −18% |
| Pior dia | −27,45 → −17,17 | −86,42 → −46,92 |

A vizinhança do parâmetro é plana (`minBidRatio` 0,45/0,55/0,65 → 358/360/334 em
junho): não é otimização em fio de navalha.

### Combinações (julho 01–25)

| Variante | PnL | PF | razão G/P | MaxDD | Pior dia | Dias+ |
|---|--:|--:|--:|--:|--:|--:|
| `ceiling-protect` | 1.933,6 | 1,577 | 0,427 | 55,3 | −2,04 | 24/25 |
| `protect-cushion` | 1.425,8 | 1,448 | 0,451 | 58,4 | −4,05 | 23/25 |
| **`hold-cushion-oddsvel`** | **1.406,5** | **1,456** | 0,424 | 58,2 | **−13,91** | 23/25 |
| `hold-cushion45` | 1.398,0 | 1,431 | 0,433 | **54,0** | −14,47 | 23/25 |
| `hold-cushion55` | 1.370,1 | 1,418 | 0,428 | 56,5 | −17,17 | 23/25 |
| `hold-cushion65` | 1.355,9 | 1,411 | 0,423 | 61,0 | −24,38 | 23/25 |
| `hold-cushion-wide26` | 1.337,6 | 1,410 | 0,436 | 57,7 | −20,95 | 24/25 |
| `hold-os` | 1.201,0 | 1,325 | 0,358 | 65,8 | −27,45 | 22/25 |

Somar o `oddsVelGate` (gate de entrada, bloqueia quando o book já está
reprecificando rápido) é o melhor conjunto no mundo hold, e replica: melhor em
julho (1.406,5) e em junho (373,1). Esse gate **já tinha sido avaliado
positivamente** neste repositório em 2026-07-26 (`midas-odds-vel-gate-report.md`:
+4,9% de PnL no holdout de julho, com WR/PF/DD melhores) e simplesmente nunca foi
promovido ao preset Gold. O ótimo daquele lab foi `oddsVelMaxDelta 0,10`; aqui
usei 0,12 — ambos positivos.

### Nuance importante: cushion é substituto, não complemento

`protect-cushion` (1.425,8) fica **abaixo** de `ceiling-protect` (1.933,6). Ou
seja: se a venda protetora tardia realmente preencher, adicionar o cushion custa
PnL — ele dispara antes e sai de posições que o late-flip teria tratado melhor,
ou que se recuperariam.

Isso dá a regra de decisão correta:

- **Hoje, com a proteção não preenchendo:** ligar o cushion. Vale +14–18% de PnL
  e corta o pior dia pela metade.
- **Depois do fix GTC per-leg, com fill de venda comprovado:** reavaliar em A/B.

Na prática o live ficará entre os dois cenários, e a favor do cushion: as vendas
dele têm probabilidade de fill muito maior que as do late-flip, porque acontecem
12s antes e só quando existe bid a ≥55% da entrada.

### Por que este mecanismo funciona quando os outros falharam

O `cushionDecay` é a mesma condição de cruzamento do late-flip
(`signedDistance <= 0`), com duas diferenças:

1. **Janela 20→4s em vez de 8→4s** — 12 segundos a mais de reação, num book
   ainda negociável;
2. **Piso de qualidade do bid: só age se `bid >= 0,55 × preço de entrada`.**

O item 2 é o ponto. O lab anti-flip já tinha testado a condição **oposta**
(`bid < 0,40`, agir só depois do colapso) e ela foi rejeitada. Alargar a janela
*sem* o piso também tinha sido rejeitado. A combinação certa é:

> **Sair cedo, e somente enquanto o mercado ainda paga. Nunca vender no fundo do
> colapso — nesse ponto, segurar é melhor.**

O mesmo princípio explica por que o `odds-shock partial50` (que também usa
`minBidRatio 0,55`) é a única proteção que já funcionava no live, e por que
`earlyWarn`, `bookCollapse`, exit puro de odds-shock e o `hedgeStop` deste
relatório falharam: todos agem tarde, ou agem sem exigir que exista bid.

É também o motivo pelo qual o mecanismo é **executável em produção**: ele dispara
com 12s a mais de folga e, por construção, só quando há um bid a ≥55% do preço de
entrada — ou seja, só quando existe liquidez para vender.

---

## 4. Recomendação

### 4.1 O que realmente aumenta o lucro na conta real

Em ordem de tamanho do efeito medido:

| # | Ação | Efeito medido | Estado |
|---|---|---|---|
| 1 | **Destravar a protection lane** (circuito nega saída) | **196 de 200** negações protetivas | ver relatório dedicado |
| 2 | **Uptime 24/7 do engine** | live capturou 49% das entradas do lab no dia 25 | operacional |
| 3 | **Ligar `cushionDecay`** | +14–18% PnL, razão 0,36→0,43/0,53, pior dia −37%/−46% | **novo, validado 2 janelas** |
| 4 | Deploy do fix GTC per-leg | inócuo até o item 1: hoje nenhuma ordem de saída é criada | código pronto, não deployado |
| 5 | `R_event`/`R_slot` do relatório de cauda | teto duro de perda | P0 de engenharia |

> **Correção de ordem (2026-07-28, após auditoria do ciclo de vida das ordens):**
> o fix GTC era o item 2 numa versão anterior desta tabela. A auditoria mostrou
> que em dois dias **nenhuma ordem `EXIT` foi submetida** — 200 intents
> protetivas foram negadas pelo risk engine (196 `CIRCUIT_OPEN`, 4
> `MAX_NOTIONAL_EVENT`) antes de virarem ordem. Trocar o tipo de ordem não muda
> nada enquanto a intent é negada. Detalhe e fix em
> `reports/research/midas-por-que-a-protecao-nao-executa-2026-07-28.md`.

Nenhum ajuste de envelope chegou perto disso. A melhor mudança de envelope que
encontrei (`notier-94`) vale +0,7% de PF e −4,7% de DD ao custo de 5,6% do PnL.

**O ganho está em executar a estratégia que já existe, não em trocá-la.**

### 4.2 Preset proposto

`btc-gold-cushion-v1` = `btc-gold-v1` + `cushionDecay` + `oddsVelGate`. Diff:

```js
cushionDecayEnabled: true,
cushionDecayStartSec: 20,
cushionDecayEndSec: 4,
cushionDecayMinDist: 0.0,
cushionDecayMinBidRatio: 0.55,   // vizinhança plana: 0.45 também vale
oddsVelGateEnabled: true,        // já validado em 2026-07-26, nunca promovido
oddsVelLookbackSec: 2,
oddsVelMaxDelta: 0.12,           // 0.10 foi o ótimo do lab original
oddsVelBlockOnHit: true,
// todo o resto idêntico ao btc-gold-v1
```

Se preferir a mudança mínima de uma peça só, `cushionDecay` sozinho entrega a
maior parte do ganho (1.370,1 contra 1.406,5 do conjunto).

Porte no `data-robot` (`midasV1.js`): na janela 20→4s, se
`signedDistance <= 0` **e** `bid >= 0.55 * avgEntryPrice`, emitir EXIT
(GTC marketable, mesma via da proteção atual). É a mesma ação que já existe —
muda só **quando** ela é disparada e a **pré-condição de bid**.

O mecanismo é uma redução de risco pura (só vende), então é compatível com o
ledger `R_event`: `deltaRisk <= 0`, passa pela protection lane sem exceção.

### 4.3 O que NÃO fazer

| Mudança | Evidência contra |
|---|---|
| Cortar a banda `ask ≥ 0,82` | −13% PnL e pior dia de −2,04 para −6,87 (§1.3) |
| Descer para `ask < 0,55` (scoop) | pior dia −54 a −60, DD ~100 (§1.3) |
| Entrada maker / GTC na entrada | seleção adversa, negativo em todas as bandas (§1.2) |
| Complete-set lock como alfa | custa ~52% do EV (§1.1) |
| `hedgeStop` no lado oposto | whipsaw, pior dia −35 → −87 (§1.4) |
| Alargar late-flip sem piso de bid | já rejeitado no lab anti-flip; §3 explica por quê |

---

## 5. Reprodução

```powershell
# Medições em parquet (DuckDB direto no lake)
node --max-old-space-size=12288 labs/sandbox/midas-band-edge-economics.mjs --underlying BTC
node --max-old-space-size=12288 labs/sandbox/midas-band-z-and-lock.mjs --underlying BTC
node --max-old-space-size=12288 labs/sandbox/midas-cheap-band-profile.mjs --underlying BTC
node --max-old-space-size=12288 labs/sandbox/midas-latency-decay.mjs --underlying BTC
node --max-old-space-size=12288 labs/sandbox/midas-multiasset-band-validation.mjs
node --max-old-space-size=12288 labs/sandbox/midas-maker-feasibility.mjs --underlying BTC

# Experimentos no motor oficial
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/band-reallocation-july.json
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/hedge-stop-july.json
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/holdworld-july.json

# Comparação com foco na razão ganho/perda
node labs/sandbox/midas-compare-variants.mjs <dir-do-report>
```

Validade do harness: `gold-baseline` reproduz o campeão documentado casa a casa
(PnL 1933,5576 · 2126 entradas · WR 78,69% · PF 1,5766 · DD 55,28 · pior dia
−2,04), idêntico ao `labSummary` de `presets/btc-gold-v1.json`.

## 6. Limitações

- O lab não simula latência intra-tick nem falha de API. O teste de latência do
  §2 é aplicado à decisão de entrada, não às pernas de proteção.
- O `hedgeStop` no lab preenche no primeiro tick (500 ms) em que o cruzamento é
  visto; no live haveria atraso adicional durante uma virada rápida. Como o
  mecanismo foi reprovado com folga, esse otimismo não muda o veredito.
- O winner do lake é o último tick de spot/RTDS; a fonte canônica da Polymarket é
  a Chainlink. Divergência é risco de dado conhecido, não coberto aqui.
- As medições em parquet usam uma entrada por evento no primeiro tick que passa o
  envelope, sem os gates de OBI e velocidade do motor. Servem como gerador de
  hipótese; o veredito é sempre do motor oficial.
