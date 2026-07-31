# Paired Liquidity Reconstitution V1

**Status:** `REJECTED_NO_DUAL_SIDE_EDGE`  
**Escopo:** pesquisa e backtest; não é estratégia implementada, não é autorização de live  
**Mercado:** BTC Up/Down 5 minutos da Polymarket  
**Range obrigatório:** `2026-05-04T15:00:00.000Z` até o maior timestamp local  
**Resultado da seleção:** `maker-pair-medium`, rejeitada no holdout  
**Artefato reproduzível:** `scripts/lab-paired-liquidity-reconstitution.js`

## Veredito

A nova teoria investigada foi **Paired Liquidity Reconstitution (PLR)**: publicar simultaneamente bids passivos em UP e DOWN, em níveis cuja soma seja inferior a 1, e só contabilizar fill após o book atravessar a ordem por tempo suficiente. Se as duas pernas forem preenchidas, o par forma um complete set com payout igual em qualquer settlement. Se apenas uma perna preencher, o excesso é zerado como posição órfã.

A tese é matematicamente não direcional, mas **não sobreviveu à execução observável**. A seleção foi feita somente em treino e validação, sem usar o holdout. A variante escolhida perdeu:

- treino: **-US$ 1.941,51**;
- validação: **-US$ 622,49**;
- holdout: **-US$ 589,12**, PF **0,093**, expectativa **-US$ 0,4390/estrutura**;
- range completo: **-US$ 3.153,11**, PF **0,097**, expectativa **-US$ 0,4622/estrutura**.

Nenhuma das quatro famílias testadas produziu edge líquido. Nenhuma variante de lock temporal teve frequência material de lock ou free-roll; nenhuma oportunidade imediata permaneceu como arbitragem depois da execução sequencial. O resultado é um **NO-GO**.

## Por que esta teoria é nova

PLR não usa BTC/PTB para escolher direção, não compra o provável vencedor e não ajusta thresholds do Terminal Convexity. Sua variável latente é a **probabilidade conjunta de visitação das duas filas passivas dentro do mesmo evento**, suficiente para adquirir:

\[
q_{UP} = q_{DOWN} = q
\]

com custo líquido:

\[
C = q(l_{UP}+l_{DOWN}) + F_{maker} + C_{órfã}
\]

e payoff em qualquer settlement:

\[
\Pi_{UP} = q-C,\qquad \Pi_{DOWN}=q-C
\]

O edge ideal seria:

\[
M = q[1-(l_{UP}+l_{DOWN})]-F_{maker}-C_{órfã}
\]

O ponto novo não é a identidade do complete set; é testar se a microestrutura histórica permite **reconstituí-lo passivamente**, sem pressupor um fill atômico entre outcomes. O experimento anterior Terminal Convexity foi usado apenas como disciplina de separação entre hipótese, seleção e holdout.

## Dados e auditoria SQL

O laboratório usa `pool/getTicksForBacktestBatches` de `src/database.js`, transação `READ ONLY`, paginação por `(ts,id)` e primeiro nível executável dos JSONB de book. O book tem precedência sobre campos escalares potencialmente defasados.

| Medida | Resultado |
|---|---:|
| Ticks no range | 5.267.246 |
| Eventos | 8.801 |
| Primeiro tick | `2026-05-04T15:00:00.548Z` |
| Último tick | `2026-06-08T01:22:35.993Z` |
| Ticks com ask UP válido | 5.026.605 |
| Ticks com ask DOWN válido | 5.017.358 |
| Ticks com bid UP válido | 5.017.350 |
| Ticks com bid DOWN válido | 5.026.614 |
| Ticks com quatro tops válidos | 4.779.010 |
| Frequência com quatro tops válidos | 90,73% |
| Mediana de ticks por evento | 599 |
| Eventos com menos de 240 ticks | 4 |
| Eventos com menos de 500 ticks | 16 |

### Cobertura diária

| Dia UTC | Ticks | Eventos | Quatro tops válidos |
|---|---:|---:|---:|
| 2026-05-04 | 64.692 | 108 | 91,03% |
| 2026-05-05 | 172.495 | 288 | 92,16% |
| 2026-05-06 | 172.487 | 288 | 91,18% |
| 2026-05-07 | 172.494 | 288 | 90,45% |
| 2026-05-08 | 172.489 | 288 | 92,32% |
| 2026-05-09 | 172.480 | 288 | 94,49% |
| 2026-05-10 | 172.523 | 288 | 91,81% |
| 2026-05-11 | 172.492 | 288 | 89,15% |
| 2026-05-12 | 172.513 | 288 | 90,60% |
| 2026-05-13 | 172.269 | 288 | 90,56% |
| 2026-05-14 | 172.508 | 288 | 88,21% |
| 2026-05-15 | 172.490 | 288 | 90,17% |
| 2026-05-16 | 172.543 | 288 | 95,07% |
| 2026-05-17 | 172.521 | 288 | 94,36% |
| 2026-05-18 | 172.463 | 288 | 90,01% |
| 2026-05-19 | 172.486 | 288 | 91,19% |
| 2026-05-20 | 172.520 | 288 | 92,20% |
| 2026-05-21 | 172.511 | 288 | 89,13% |
| 2026-05-22 | 172.364 | 288 | 90,53% |
| 2026-05-23 | 172.536 | 288 | 92,48% |
| 2026-05-24 | 172.422 | 288 | 91,60% |
| 2026-05-25 | 172.474 | 288 | 92,83% |
| 2026-05-26 | 171.778 | 287 | 89,58% |
| 2026-05-27 | 171.467 | 287 | 88,81% |
| 2026-05-28 | 172.529 | 288 | 87,11% |
| 2026-05-29 | 172.516 | 288 | 88,21% |
| 2026-05-30 | 172.517 | 288 | 94,72% |
| 2026-05-31 | 172.528 | 288 | 92,13% |
| 2026-06-01 | 172.535 | 288 | 88,60% |
| 2026-06-02 | 172.521 | 288 | 86,35% |
| 2026-06-03 | 172.516 | 288 | 87,17% |
| 2026-06-04 | 29.405 | 53 | 82,37% |
| 2026-06-08 | 162 | 2 | 99,38% |

### Distribuição do custo e do valor de saída

| Quantil | `ask_UP + ask_DOWN` | `bid_UP + bid_DOWN` |
|---:|---:|---:|
| mínimo | 0,86 | 0,07 |
| 0,1% | 1,001 | 0,83 |
| 1% | 1,01 | 0,93 |
| 5% | 1,01 | 0,97 |
| 50% | 1,01 | 0,99 |
| 95% | 1,03 | 0,99 |
| 99% | 1,07 | 0,99 |
| máximo | 1,93 | 1,14 |

O top do book mostrou:

- `ask_UP + ask_DOWN < 1`: 100 ticks em 94 eventos;
- ainda positivo após a fee projetada: 25 ticks em 25 eventos;
- `bid_UP + bid_DOWN > 1`: 98 ticks em 88 eventos;
- ainda positivo após a fee projetada: 19 ticks em 19 eventos.

Essas contagens são **oportunidades teóricas no mesmo snapshot**, não fills. No cenário-base, a compra sequencial do par encontrou apenas duas entradas executáveis e ambas perderam; o mint-and-sell encontrou uma, também perdedora. A diferença entre 25/19 sinais e 2/1 estruturas executadas é a evidência de que snapshot cruzado não equivale a arbitragem operacional.

### Cobertura e gaps

Os dias completos normalmente têm 288 eventos. Foram detectados:

- `2026-05-26 17:15Z` → `17:25Z`: 600 s;
- `2026-05-27 09:50Z` → `10:00Z`: 600 s;
- `2026-06-04 04:00Z` → `14:15Z`: 36.900 s;
- `2026-06-04 14:30Z` → `2026-06-08 01:15Z`: 297.900 s.

Por isso, as “últimas 72h” e “últimas 24h” locais contêm apenas **uma estrutura**. O resultado positivo dessa única estrutura não satisfaz validação recente.

## Fees e execução

A fee de cada fill é modelada pela fórmula oficial para crypto:

\[
F(q,p,r)=round_{5}\{q\cdot r\cdot p(1-p)\}
\]

O laboratório permite `--maker-fee`, `--taker-fee`, `--fee-override` e `--rebate-rate`. Maker rebates futuros não são lançados como crédito fixo por fill.

| Cenário | Maker | Taker | Rebate taker | Slippage | Haircut de profundidade | Haircut de fila | Latência inicial | Confirmação maker |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| otimista | 0 | 0,07 | 44% | 0 tick | 100% | 75% | 500 ms | 500 ms / touch |
| base | 0 | 0,07 | 0 | 1 tick | 50% | 35% | 750 ms | 1.000 ms / 1 tick through |
| pessimista | 0 | 0,0875 | 0 | 2 ticks | 25% | 15% | 1.250 ms | 1.500 ms / 2 ticks through |

Uma ordem maker tocada não é tratada como fill no caso-base: o ask precisa atravessar o bid cotado pelo número de ticks configurado e permanecer confirmado. Uma ordem taker caminha somente o top salvo, aplica haircut de tamanho e nunca recebe preço médio ou mid ideal.

O modelo ainda é conservadoramente limitado: não conhece a posição real na fila nem mensagens order-by-order. O trade-through é uma aproximação auditável, não prova de fill individual.

## Contabilidade antes da entrada

Para cada estrutura, o ledger registra:

\[
C_{UP}=\sum q_i p_i,\quad
C_{DOWN}=\sum q_jp_j
\]

\[
C_{total}=C_{UP}+C_{DOWN}+C_{mint}+F-R
\]

\[
Cash_0=Vendas-C_{UP}-C_{DOWN}-C_{mint}-F+R
\]

\[
\Pi_{UP}=Cash_0+q^{restante}_{UP}
\]

\[
\Pi_{DOWN}=Cash_0+q^{restante}_{DOWN}
\]

\[
Worst=\min(\Pi_{UP},\Pi_{DOWN}),\qquad
Best=\max(\Pi_{UP},\Pi_{DOWN})
\]

Também são calculados break-even médio de cada lado, margem de segurança, risco máximo pré-entrada, spread, slippage, partial fill, miss, turnover, drawdown, PF, frequência de empate/quase empate, lock e free-roll.

Por padrão há no máximo uma estrutura por evento, quantidade solicitada de 5 shares e risco pré-calculado limitado a US$ 5. Não existe segunda entrada para recuperar prejuízo.

## As quatro hipóteses

### H1 — Net Complete-Set

**Intuição.** Comprar UP e DOWN quando o par executável custa menos que o payout garantido.

**Variável latente mal precificada.** Persistência do cruzamento dos dois asks durante a execução sequencial.

**Fórmula.**

\[
G=q[1-(a_U+s+a_D+s)]-F_U-F_D+R
\]

**Entrada UP/DOWN.** As duas pernas precisam ter top ask, profundidade ajustada para 5 shares e margem mínima de 0,2 cent por par. A ordem da primeira perna é determinística e independente da direção.

**Entrada combinada.** Só sinaliza se `projected locked PnL > 0`, incluindo duas fees, slippage e profundidade.

**Saída.** Se uma perna falhar ou preencher parcialmente, o excesso é zerado no bid após a latência de saída. Se ambas preencherem igualmente, não há necessidade de saída.

**Settlement.**

\[
\Pi_{UP}=\Pi_{DOWN}=q-C_{total}
\]

**Pior caso UP/DOWN.** Iguais quando o par está completo; no fill órfão, o unwind materializa a perda antes do settlement.

**Risco principal.** O segundo ask desaparecer antes da segunda FAK.

**Expectativa bruta/líquida.** O snapshot mostrava margem, mas as duas entradas base somaram PnL líquido de **-US$ 1,3278**; fees **US$ 0,3278**, slippage **US$ 0,20**, partial fill **50%**.

**Vulnerabilidade.** Extrema a latência e partial fill; fee drag elimina margens de poucos milésimos.

**Robustez operacional.** Baixa sem ordem combinada/atômica cross-outcome.

**Por que não é direcional.** O payout do par completo é o mesmo se UP ou DOWN vencer.

### H2 — Paired Expansion Lock

**Intuição.** Comprar as duas pernas em compressão de odds e fechar o par quando a soma dos bids superar todo o custo; alternativamente, vender uma perna que sozinha recupere o custo e manter a outra como free-roll.

**Variável latente mal precificada.** Expansão futura do valor de revenda conjunto, não a direção da expansão.

**Fórmula de lock.**

\[
L_t=V^{net}_{UP,t}+V^{net}_{DOWN,t}-C^{all-in}_0
\]

**Fórmula de free-roll.**

\[
FR_{k,t}=V^{net}_{k,t}-C^{all-in}_0,\quad k\in\{UP,DOWN\}
\]

**Entrada UP/DOWN.** Compra sequencial taker das duas pernas aos asks efetivos. Variantes low/medium/high controlam tempo restante, soma dos asks, spread, profundidade e faixa de preço.

**Entrada combinada.** Exige ambos os books válidos e risco órfão abaixo do teto; não escolhe o lado que se moveu.

**Saída.** Lock se os dois bids líquidos cobrem custo mais alvo. Free-roll se o bid líquido de uma perna cobre todo o custo. Excesso órfão é zerado.

**Settlement.** Se não houver saída, cada share restante paga 1 apenas no outcome correspondente.

**Pior caso UP/DOWN.** O menor entre o caixa mais as shares UP restantes e o caixa mais as shares DOWN restantes.

**Risco principal.** Pagar duas vezes spread/fee para adquirir convexidade que não pode ser revendida acima do custo.

**Expectativa bruta/líquida.** Todas as frequências foram negativas. No base, medium perdeu **US$ 2.048,99**, com apenas **0,149%** de lock e **0,075%** de free-roll.

**Vulnerabilidade.** Muito alta a fee drag, spread, slippage e execução da segunda perna.

**Robustez operacional.** Baixa: o ganho exige duas entradas e até duas saídas, multiplicando o custo.

**Por que não é direcional.** O gatilho avalia o valor combinado ou a recuperação integral do custo por qualquer perna, sem prever qual.

### H3 — Paired Liquidity Reconstitution

**Intuição.** Capturar passivamente os dois lados abaixo de 1 e formar um payout floor sem cruzar o spread de entrada.

**Variável latente mal precificada.** Probabilidade conjunta de o fluxo negociar através das duas filas antes do TTL.

**Fórmula.**

\[
M=q[1-(l_U+l_D)]-F_{maker}-C_{órfã}
\]

**Entrada UP.** Bid passivo no melhor bid UP observado.

**Entrada DOWN.** Bid passivo simultâneo no melhor bid DOWN observado.

**Entrada combinada.** Soma dos bids, spread combinado, profundidade, faixa de preço, TTL e teto de risco precisam passar juntos. A ordem só é ativada depois da latência configurada.

**Saída.** Par completo vai ao settlement. Fill unilateral ou desbalanceado é zerado no bid com fee/slippage taker.

**Settlement.**

\[
\Pi_{UP}=Cash_0+q_{UP},\qquad
\Pi_{DOWN}=Cash_0+q_{DOWN}
\]

**Pior caso UP/DOWN.** Iguais no complete set balanceado; divergentes após fill unilateral. A diferença é explicitamente contabilizada.

**Risco principal.** Seleção adversa/queue asymmetry: a perna preenchida primeiro tende a ser a que o mercado está vendendo, enquanto a outra fila não visita o preço.

**Expectativa bruta/líquida.** A variante medium no range completo teve PnL bruto **-US$ 2.914,66**, fees **US$ 113,31**, slippage **US$ 125,19** e PnL líquido **-US$ 3.153,11**.

**Vulnerabilidade a fee drag.** A entrada maker pode ser grátis, mas o unwind órfão é taker e concentra fee no estado adverso.

**Vulnerabilidade a slippage/partial.** Slippage direto foi US$ 125,19; partial-fill deterioration acumulada foi US$ 3.664,41. A taxa de partial foi 1,98% e a de miss de perna 20,75%.

**Robustez operacional.** Melhor que H1/H2 no número de oportunidades, mas insuficiente sem dados order-by-order e controle de fila.

**Por que não é direcional.** O mesmo bid é publicado nos dois outcomes; a matemática só considera o piso combinado. O que quebra a neutralidade é a execução unilateral, não a tese.

### H4 — Split-and-Sell Inversion

**Intuição.** Criar/mintar um complete set por US$ 1 e vender UP e DOWN quando a soma líquida dos bids exceder 1.

**Variável latente mal precificada.** Persistência do cruzamento dos bids durante duas vendas.

**Fórmula.**

\[
S=q[(b_U-s)+(b_D-s)-1]-F_U-F_D+R
\]

**Entrada UP/DOWN.** O mint cria 5 shares de cada lado; ambas as vendas precisam mostrar profundidade e margem mínima.

**Entrada combinada.** Só sinaliza se proceeds líquidos projetados superam o mint.

**Saída.** Venda sequencial das duas pernas; eventual saldo continua no settlement.

**Settlement.** Shares não vendidas pagam conforme o outcome vencedor.

**Pior caso UP/DOWN.** Calculado após cada venda; um saldo unilateral cria risco direcional até o settlement.

**Risco principal.** O segundo bid cai antes da segunda venda.

**Expectativa bruta/líquida.** Uma entrada no base, **-US$ 0,32483**, sendo fees US$ 0,17483 e slippage US$ 0,10.

**Vulnerabilidade.** Extrema à latência; mesma fragilidade atômica de H1 no lado da venda.

**Robustez operacional.** Baixa.

**Por que não é direcional.** A posição nasce como complete set e pretende vender ambos os lados; nenhuma previsão de settlement entra no sinal.

## Seleção sem contaminação do holdout

O range foi separado por ordem de evento em 60/20/20. As seis variantes de frequência foram ranqueadas usando somente treino e validação, combinando expectativa, pior caso, PF e número de entradas. O holdout não participou.

| Variante | Treino PnL | Validação PnL | Score congelado |
|---|---:|---:|---:|
| maker-pair-medium | -1.941,51 | -622,49 | -0,2763 |
| maker-pair-high | -2.173,56 | -746,69 | -0,2833 |
| expansion-high | -1.610,61 | -532,01 | -0,2971 |
| expansion-medium | -1.212,97 | -426,54 | -0,3460 |
| expansion-low | -389,50 | -162,72 | -0,3835 |
| maker-pair-low | -118,34 | -36,14 | -0,5822 |

`maker-pair-medium` foi a menos ruim segundo o critério congelado, não uma candidata lucrativa.

## Resultado principal

### PLR medium — cenário-base

| Métrica | Range completo | Holdout 20% |
|---|---:|---:|
| Entradas | 6.822 | 1.342 |
| PnL bruto | -2.914,66 | -547,46 |
| Fees | 113,31 | 19,44 |
| Slippage | 125,19 | 22,21 |
| PnL líquido | **-3.153,11** | **-589,12** |
| Expectativa/trade | -0,4622 | -0,4390 |
| Expectativa/US$ arriscado | -13,46% | -12,74% |
| PF | 0,097 | 0,093 |
| Drawdown máximo | 3.153,16 | 589,31 |
| Max loss | -4,2535 | -3,9315 |
| Max win | 2,6987 | 1,9736 |
| Custo combinado médio | 3,6537 | 3,7207 |
| Pior caso médio | -0,4747 | -0,4482 |
| Melhor caso médio | -0,3035 | -0,2463 |
| Risco máximo pré-entrada | 4,45 | 4,45 |
| Turnover | 27.827,44 | 5.485,06 |
| Ganho | 55,76% | 58,72% |
| Empate | 0,12% | 0,15% |
| Perda | 44,12% | 41,13% |
| Quase empate | 33,98% | 35,92% |
| Ambos settlements não negativos | 55,48% | 58,57% |
| Payoff outcome-neutral | 95,35% | 95,08% |
| Lock | 0% | 0% |
| Free-roll | 0% | 0% |
| Partial fill | 1,98% | 1,12% |
| Miss de perna | 20,75% | 19,52% |

A taxa aparente de “ganho” não compensa a cauda dos unilaterais. O pior caso médio é negativo e o melhor caso médio também é negativo. Em outras palavras: neutralidade nominal não criou expectativa positiva.

### Frequência baixa, média e alta — base

| Família/variante | Entradas | PnL líquido | Expectativa | PF | Lock | Free-roll |
|---|---:|---:|---:|---:|---:|---:|
| Expansion low | 2.139 | -692,11 | -0,3236 | 0,008 | 0,327% | 0,140% |
| Expansion medium | 6.705 | -2.048,99 | -0,3056 | 0,003 | 0,149% | 0,075% |
| Expansion high | 8.348 | -2.670,81 | -0,3199 | 0,003 | 0,132% | 0,120% |
| Maker low | 352 | -192,76 | -0,5476 | 0,133 | 0% | 0% |
| Maker medium | 6.822 | -3.153,11 | -0,4622 | 0,097 | 0% | 0% |
| Maker high | 8.341 | -3.573,67 | -0,4284 | 0,092 | 0% | 0% |

Reduzir frequência não criou edge; aumentar frequência apenas ampliou a perda acumulada.

### Sensibilidade a fees e execução

| Variante | Otimista full | Base full | Pessimista full | Otimista holdout | Base holdout | Pessimista holdout |
|---|---:|---:|---:|---:|---:|---:|
| Net Complete-Set | -6,25 | -1,33 | -1,03 | -0,89 | 0 entradas | 0 entradas |
| Expansion low | -317,84 | -692,11 | -980,02 | -63,90 | -139,89 | -194,59 |
| Expansion medium | -947,04 | -2.048,99 | -2.967,50 | -189,45 | -409,48 | -598,90 |
| Expansion high | -1.261,32 | -2.670,81 | -3.816,92 | -248,62 | -528,19 | -773,94 |
| Maker low | -158,19 | -192,76 | -221,77 | -29,87 | -38,29 | -47,17 |
| Maker medium | -2.377,54 | -3.153,11 | -3.701,53 | -434,28 | -589,12 | -703,39 |
| Maker high | -2.552,39 | -3.573,67 | -4.300,20 | -455,57 | -653,43 | -820,67 |

Mesmo o cenário otimista com zero slippage, 100% da profundidade e rebate taker hipotético de 44% permaneceu negativo. Portanto, não é apenas uma rejeição por stress conservador.

### Últimas 72h e 24h

Ambos os recortes contêm a mesma única estrutura, com **+US$ 0,0449**. Ela representa 100% do PnL recente e ocorre depois de um gap de 82h45. Não é amostra suficiente e não altera o veredito.

### Regimes

PLR medium perdeu em todos os regimes agregados:

| Segmento | Entradas | Expectativa |
|---|---:|---:|
| Volatilidade alta | 2.274 | -0,4262 |
| Volatilidade média | 2.274 | -0,4391 |
| Volatilidade baixa | 2.274 | -0,5213 |
| Liquidez alta | 2.274 | -0,4787 |
| Liquidez média | 2.274 | -0,4510 |
| Liquidez baixa | 2.274 | -0,4569 |
| 121–180 s restantes | 3.464 | -0,4606 |
| 181–300 s restantes | 3.358 | -0,4639 |

BTC/PTB, volatilidade e liquidez foram usados apenas para segmentar os resultados; nenhum deles escolhe UP ou DOWN.

## Baselines no mesmo horário/book

| Baseline | Entradas | PnL líquido | Expectativa | PF | Fees | Slippage |
|---|---:|---:|---:|---:|---:|---:|
| Apenas UP | 8.690 | -930,82 | -0,1071 | 0,862 | 443,03 | 415,43 |
| Apenas DOWN | 8.680 | -1.287,49 | -0,1483 | 0,814 | 441,59 | 414,44 |
| Lado aleatório | 8.681 | -964,95 | -0,1112 | 0,857 | 441,90 | 413,93 |
| UP+DOWN aleatório | 8.797 | -2.376,17 | -0,2701 | 0,008 | 906,03 | 847,63 |

Comprar o par aleatoriamente foi muito pior que uma perna, confirmando que “ser neutro” por si só apenas duplica spread e fee.

## Comparação com estratégias existentes

Os runners portáveis foram executados sobre o mesmo stream de top-of-book e receberam a fee taker oficial depois do runner. Eles servem como referência relativa; não provam execução live equivalente e são direcionais ou têm lógica própria.

| Referência | Entradas | PnL após fee | PF | Max loss | Drawdown | Fee |
|---|---:|---:|---:|---:|---:|---:|
| Edge Sniper V2 | 93 | +507,45 | 4,31 | -15,93 | 24,75 | 61,74 |
| Terminal Convexity V1 | 99 | +788,91 | 2,36 | -15,42 | 72,24 | 71,26 |
| Gamma Ladder V1 | 909 | +3.556,35 | 3,71 | -36,24 | 140,44 | 679,27 |
| Impulse Elasticity V1 | 256 | +366,58 | 1,76 | -13,22 | 73,49 | 191,95 |

PLR tem curva e matemática diferentes, mas falha nos critérios mínimos. Um drawdown nominal menor por trade não compensa expectativa, PF e pior caso inadequados.

As estratégias adicionadas durante esta pesquisa também foram revisadas, sem serem incorporadas à tese:

- `market-neutral-dual-v1.md` usa uma aproximação de fee incompatível com a curva oficial usada aqui e apresenta sinais positivos sem a mesma auditoria de execução; não valida PLR;
- `pair-floor-invariant-v1.md` depende de lake com range diferente e assume o par no mesmo snapshot, embora a execução cross-outcome não seja atômica; os 25 sinais fee-positive deste estudo se reduziram a duas compras reais no cenário-base, ambas negativas.

## Por que as hipóteses falharam

1. **Margem de snapshot não é margem executável.** A segunda perna muda antes do fill.
2. **O custo combinado típico já nasce acima do payout.** A mediana dos asks é 1,01 antes de fee.
3. **O valor de saída típico nasce abaixo do custo.** A mediana dos bids é 0,99.
4. **Comprar e vender duas pernas multiplica fee, spread e latência.**
5. **Fill maker é adversamente selecionado.** Uma fila visita o preço sem garantia de visitação da outra.
6. **O unwind do órfão converte risco de fila em perda taker.**
7. **A convexidade temporal não se monetiza.** Locks e free-rolls ficaram próximos de zero.
8. **Nenhum regime salva o edge.**

## Critérios mínimos

| Critério | Resultado |
|---|---|
| Holdout líquido positivo | Falhou |
| PF > 2 no holdout | Falhou: 0,093 |
| Pior caso médio próximo de zero | Falhou: -0,448 |
| Não depender de uma única trade | Passou |
| Independência do winner | Passou em 95,08%, mas fills órfãos quebram 4,92% |
| Ambos settlements não negativos | Falhou: 58,57% |
| Lock/free-roll material | Falhou: 0%/0% no selecionado |
| Últimas 72h/24h | Inconclusivo: uma única estrutura |
| Sobrevive ao cenário otimista | Falhou |
| Sobrevive a fee/slippage/partial | Falhou |

## Limitações

- O banco termina em 8 de junho e possui um gap final de 82h45.
- Não há posição real na fila nem mensagens order-by-order.
- O primeiro nível do book limita book walk profundo; por isso o haircut reduz tamanho, em vez de inventar níveis.
- O winner das baselines direcionais é aproximado pelo último BTC local contra o PTB. Os resultados contrafactuais UP/DOWN das estruturas duais não dependem desse proxy.
- Rebate taker otimista é overlay de sensibilidade, não receita garantida.
- Os runners de referência não têm o mesmo simulador de cada perna.

## Quando não operar

Não operar PLR nas condições atuais. Em particular:

- nunca tratar `ask_UP + ask_DOWN < 1` ou `bid_UP + bid_DOWN > 1` no mesmo snapshot como fill garantido;
- nunca manter uma perna órfã esperando que ela seja a vencedora;
- nunca promover um maker touch a fill sem evidência de fila;
- nunca usar o único resultado das últimas 24h/72h como validação;
- nunca compensar fee drag aumentando frequência;
- nunca habilitar live a partir deste relatório.

## Plano de uso

O único uso recomendado é como **teste de rejeição reproduzível**. A teoria só deve ser reaberta se houver uma mudança material de evidência:

1. dados order-by-order com posição/consumo de fila;
2. mecanismo realmente atômico para as duas pernas, ou prova operacional equivalente;
3. tape posterior contínuo sem o gap final;
4. forward shadow que registre `SIGNAL`, `SKIP`, `FILL`, `PARTIAL`, `UNWIND` e settlement;
5. novo holdout intocado com expectativa líquida positiva, PF acima de 2 e pior caso controlado.

Até lá: `RESEARCH / REJECTED / DISARMED`.

## Reprodução

```powershell
npm run lab:paired-liquidity -- --mode full --batch-size 50000
```

Argumentos principais:

```text
--from
--to
--mode quick|research|full
--batch-size
--qty
--risk-cap-usd
--fee-scenario optimistic|base|pessimistic
--maker-fee
--taker-fee
--fee-override
--rebate-rate
--compare-references
--output
```

Relatório integral:

`reports/paired-liquidity-reconstitution-v1/full-2026-05-04-to-local-max.json`

Hashes SHA-256 desta execução:

```text
script  97CC5E3AEA21A6A473D95DD315A0AB4836548745162DE201B049E96EB57A90CE
report  4E23AE473E231C5114AFDA544CFDA6AF96640E8B7C574072429BD445C0445088
```

Testes focados:

```powershell
node --test tests/pairedLiquidityReconstitution.test.js
node --test tests/fees.test.js tests/legacyAdapter.test.js
```
