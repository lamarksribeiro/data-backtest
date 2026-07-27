# BTC 5m — investigação canônica de flips terminais

**Data:** 2026-07-27  
**Status:** pesquisa reproduzível; nenhuma promoção, deploy ou autorização live  
**Fonte primária:** parquets `backtest_ticks`, book depth 25  
**Settlement:** resultado resolvido publicado pela Gamma/Polymarket

## Veredito

Há duas respostas diferentes para o problema:

1. **Antecipação:** não apareceu uma variável científica “secreta” que antecipe o mercado.
   O preço do próprio contrato é o melhor preditor geral. Em 30 s, `1 - favMid` obteve AUC
   0,899 no holdout; o modelo completo obteve 0,898.
2. **Mitigação:** há um pequeno gate pré-entrada útil no extremo da distribuição e uma saída
   reativa que reduz perdas, mas a saída é extremamente sensível à latência.

Resultado indicado para nova validação:

- **não entrar** quando o modelo congelado em 30 s estimar `pFlip >= 0,40`;
- testar como aproximação interpretável o alerta:
  `dMid15 <= -0,05 AND z <= 0,50 AND favAsk <= 0,68`;
- se já estiver posicionado, sinalizar saída apenas quando:
  `spot/PTB perdeu a liderança AND bid do lado comprado < 0,40`;
- não promover a saída enquanto o ganho não sobreviver à latência observada ao vivo.

O gate pré-entrada é a descoberta mais operacionalmente segura. A saída no tick do sinal é
forte, mas o benefício deixa de ser estatisticamente seguro já no primeiro bucket observável
de atraso, 0,5 s.

### Atualização após auditoria do `HANDOFF-completo.md`

O handoff acrescentou uma hipótese útil — reverter para o novo líder quando seu ask ainda está
baixo —, mas seus números econômicos não sobrevivem ao envelope oficial da MIDAS nem corrigem
o filtro retrospectivo de winner. A auditoria também encontrou um erro de leitura: o documento
atribui ΔPnL −US$ 173 ao gate pré-entrada em geral; esse número é apenas o corte amplo de 20%.
O corte combinado `pFlip >= 0,40` é positivo nos três splits.

A investigação do handoff levou a uma descoberta pré-entrada diferente: não tentar maximizar
AUC, mas comparar o risco calibrado com o preço que está sendo pago. Essa fronteira econômica
e uma aproximação simples por queda do mid + proximidade física do PTB são detalhadas no §8.

## 1. Dataset e método

- Lake bruto: 26.088 eventos em 95 diretórios diários, de 2026-04-23 a 2026-07-26.
- Outcomes canônicos coletados: 26.060.
- Cubo sem filtro retrospectivo de book: 24.780 eventos e 172.489 linhas em sete checkpoints.
- Análise principal: 24.716 eventos e 98.318 linhas nos checkpoints 60/30/20/10 s.
- Simulação de saída: 8.602 entradas elegíveis, `ask ∈ (0,50; 0,94]`, US$ 10 por entrada.

Split temporal:

| split | janela |
|---|---|
| treino | até 2026-06-14 |
| validação | 2026-06-15 a 2026-06-30 |
| holdout | 2026-07-01 a 2026-07-26 |

Em cada checkpoint, todas as features usam somente ticks anteriores ou iguais ao instante.
O winner vem do outcome resolvido; o book dos últimos segundos não é usado para aceitar ou
rejeitar eventos.

### Correção científica decisiva

O primeiro dataset usava o último spot local e exigia concordância com o book final. Isso
parecia uma validação de qualidade, mas é um filtro com informação futura e seleciona casos
fáceis.

- 236/23.829 winners filtrados (0,99%) ainda divergiam do outcome oficial.
- Nas 8.252 entradas filtradas, 164 (1,99%) divergiam.
- O PnL `hold` filtrado/canônico era +US$ 399.
- Sem o filtro futuro, o mesmo envelope de entrada ficou em **−US$ 683**.

Portanto, qualquer número econômico baseado no filtro de consenso final deve ser considerado
preliminar e otimista. Os resultados principais abaixo são os sem filtro.

## 2. Matemática do flip

Foi testado o escore de difusão:

```text
z = |spot - PTB| / (sigma_1s * sqrt(tau))
pFlip_browniano = Phi(-z)
```

O modelo browniano falha nas caudas. Saltos, volatilidade agrupada e microestrutura terminal
fazem o flip real permanecer material mesmo quando a difusão gaussiana o trata como quase
impossível.

Taxa canônica de flip:

| antecedência | eventos | flip |
|---:|---:|---:|
| 60 s | 24.709 | 16,6% |
| 30 s | 24.598 | 12,4% |
| 20 s | 24.541 | 10,5% |
| 10 s | 24.470 | 8,5% |

No holdout:

| antecedência | AUC preço do mercado | AUC browniano | AUC modelo completo |
|---:|---:|---:|---:|
| 60 s | 0,842 | 0,735 | 0,839 |
| 30 s | **0,899** | 0,737 | 0,898 |
| 20 s | **0,920** | 0,721 | 0,918 |
| 10 s | **0,948** | 0,715 | 0,946 |

Em 30 s, a taxa de flip por `favMid` foi:

| `favMid` | flip canônico |
|---|---:|
| 0,50–0,60 | 43,0% |
| 0,60–0,70 | 33,2% |
| 0,70–0,80 | 21,5% |
| 0,80–0,90 | 13,7% |
| 0,90–0,92 | 9,3% |
| 0,92–0,94 | 5,9% |
| 0,94–0,95 | 4,7% |
| 0,95–0,97 | 3,5% |
| ≥ 0,97 | 0,78% |

No holdout, `favMid >= 0,97` teve 31 flips em 3.161 eventos: 0,98%, com intervalo de
Wilson de 95% entre 0,69% e 1,39%. É alta confiança, não certeza.

### Interpretação financeira

Para ask `a`, payout conservador 0,995 e taker fee `0,07*a*(1-a)` por share, o flip máximo
para break-even é aproximadamente:

```text
q_break_even = 1 - a * (1 + 0,07 * (1 - a)) / 0,995
```

Exemplos:

- ask 0,90: `q_break_even ≈ 8,9%`;
- ask 0,94: `q_break_even ≈ 5,1%`.

Isso explica por que bloquear todos os eventos “incertos” destrói expectativa: vários deles
ainda pagam acima do risco. O gate deve atuar somente na cauda claramente negativa.

## 3. O que foi testado

Features:

- distância do PTB normalizada por volatilidade;
- momentum de 10 s e 30 s;
- número e idade de cruzamentos do PTB;
- range e volatilidade realizada;
- queda do mid em 15 s;
- spread, soma das asks e staleness do spot;
- modelo logístico regularizado, com treino apenas no primeiro split.

Resultado:

- momentum, cruzamentos, range, repricing e staleness não melhoraram a AUC geral depois do
  preço;
- o maior coeficiente do modelo é o risco implícito pelo book;
- o modelo completo ainda ajuda a separar uma cauda pequena de risco extremo, embora não
  melhore o ranking global.

Hipóteses rejeitadas:

- saída só porque o bid caiu;
- saída por choque de odds em 2 s;
- Browniano puro;
- bloquear amplamente `favMid < 0,90`;
- interpretar consenso do book final como validação de settlement.

As saídas só por book vendem whipsaws e foram economicamente destrutivas.

## 4. Gate pré-entrada

O detector de maior precisão com antecedência foi:

- em 30 s, `pFlip >= 0,50`: 333 sinais (4,9%), precisão 73,6% e recall 27,9%;
- em 10 s, `pFlip >= 0,50`: 245 sinais (3,6%), precisão 78,4% e recall 31,3%.

É a resposta mais próxima de “alta probabilidade antes do flip”, mas cobre menos de um terço
dos flips e sua informação principal já está no preço do mercado.

O modelo completo congelado no treino, em 30 s, com corte `pFlip >= 0,40`, marcou no holdout:

- 593/6.770 eventos (8,8%);
- precisão 65,9%, IC95% 62,0%–69,6%;
- recall 44,6%;
- flip residual nos não sinalizados 7,9%.

Dentro do proxy MIDAS (`ask 0,55–0,94`, `|dist| < 40`, spread ≤ 0,03,
odds sum 0,98–1,06), o corte foi pequeno e consistente:

| split | base n | bloqueadas | perdas evitadas | precisão | ΔPnL | PnL novo | DD base → novo |
|---|---:|---:|---:|---:|---:|---:|---:|
| treino | 3.833 | 136 | 63 | 46% | +US$ 151 | −US$ 483 | 663 → 554 |
| validação | 1.386 | 61 | 27 | 44% | +US$ 50 | −US$ 35 | 201 → 163 |
| holdout | 2.083 | 51 | 25 | 49% | **+US$ 72** | **US$ 196** | **202 → 157** |

O gate melhora PnL e drawdown nos três splits, mas evita somente 7%–9% das perdas do proxy.
Ele é um fusível raro, não um detector universal.

Importante: usar `1 - favMid >= 0,40` não reproduz esse resultado. O modelo calibrado completo
deve ser congelado pelo artefato JSON; o corte bruto de mercado falhou em validação e holdout.

## 5. Saída reativa e latência

Regra:

```text
posição comprada perde a liderança spot/PTB
AND bid do próprio lado < 0,40
=> vender no bid observado
```

Teste canônico sem filtro final, 8.602 trades:

| atraso até execução | PnL | Δ vs hold | maxDD | PnL holdout |
|---:|---:|---:|---:|---:|
| hold | −US$ 683 | — | US$ 822 | −US$ 157 |
| 0 s / mesmo snapshot | **US$ 28** | **+US$ 711** | **US$ 349** | **US$ 198** |
| 0,5 s / próximo tick | −US$ 308 | +US$ 376 | US$ 504 | US$ 73 |
| 1 s | −US$ 383 | +US$ 300 | US$ 574 | US$ 44 |
| 2 s | −US$ 440 | +US$ 244 | US$ 638 | ~US$ 0 |
| 3 s | −US$ 568 | +US$ 115 | US$ 755 | −US$ 73 |
| 5 s | −US$ 511 | +US$ 173 | US$ 703 | −US$ 72 |

Bootstrap pareado por dia:

| atraso | dias com Δ positivo | IC95% do Δ total |
|---:|---:|---:|
| 0 s | 54/91 | **+US$ 268 a +US$ 1.152** |
| 0,5 s | 50/91 | −US$ 44 a +US$ 794 |
| 1 s | 49/91 | −US$ 117 a +US$ 720 |
| 2 s | 52/91 | −US$ 152 a +US$ 636 |

Conclusão: a regra é um **limitador de prejuízo**, mas somente o cenário de execução no mesmo
snapshot teve intervalo de 95% inteiramente positivo. A resolução dos parquets é insuficiente
para provar o que acontece entre 0 e 0,5 s.

Uma checagem preliminar de depth 25 no snapshot do sinal `bid < 0,45` encontrou 99,1% de
full fills para US$ 10 e slippage p95 de 0,0169. Isso prova profundidade naquele snapshot,
mas não prova que o book continuará disponível depois da latência de rede, decisão e ordem.

## 6. Decisão prática

### Candidato A — gate pré-entrada

É o candidato mais seguro para o próximo lab:

```text
checkpoint 30 s
if calibrated_p_flip >= 0.40:
    skip entry
```

Vantagens:

- não depende de executar durante o colapso;
- melhorou PnL e DD em treino, validação e holdout;
- é raro e preserva a maior parte das entradas.

### Candidato B — saída `lead_bid40`

Usar somente em shadow até medir:

- timestamp do tick recebido;
- timestamp da decisão;
- timestamp de envio;
- ack/FAK;
- fill, parcial, preço médio e reconciliação;
- latência p50/p90/p95.

O critério de promoção deve ser Δ pareado positivo no bucket de latência p95 real, não no
snapshot sem atraso.

### O que não fazer

- não usar o book final para excluir eventos;
- não chamar resultado local de settlement;
- não usar saída apenas por queda de bid;
- não promover o Flip Hunt pós-cruzamento com o holdout de julho: seus parâmetros foram
  escolhidos olhando essa mesma janela e o lab ainda usa o winner local;
- não executar live com base neste relatório.

## 7. Próximos testes recomendados

1. Inserir o modelo congelado `pFlip >= 0,40` no lab oficial MIDAS, mantendo o restante do
   envelope inalterado.
2. Rodar walk-forward semanal com seleção apenas em semanas anteriores.
3. Repetir em quotas rápidas de 500, 2.000 e 5.000 eventos.
4. Fazer shadow da saída e estratificar por latência real.
5. Recalcular toda a contabilidade com outcome canônico e fills/FAK reais.
6. Só considerar promoção se o gate continuar melhorando PnL e DD e se a saída tiver IC95%
   positivo na latência p95.

## 8. Auditoria do handoff e padrão novo

### 8.1 O que o handoff realmente acrescenta

Três ideias mereciam teste:

1. reversão após a confirmação `lead_bid40`, comprando o novo líder se `ask < 0,70`;
2. mapeamento da hipótese nos levers `lateFlip` já existentes na MIDAS;
3. crítica correta à probabilidade browniana como estimador de cauda.

A reversão não é nova para a campeã: o preset gold já usa `lateFlipReverseEnabled=true` e
`lateFlipReverseMaxAsk=0,95`. A proposta do handoff restringe uma reversão existente para
0,70 e amplia sua janela.

O estudo local que reporta `reverse<0,70` com +US$ 536 sobre exit-only usa:

- winner pelo último spot local;
- filtro de concordância do book nos segundos finais;
- execução no mesmo snapshot;
- escolha do teto 0,70 olhando os 91 dias, inclusive a janela chamada `PRE`.

Logo, `PRE` não é um blind legítimo para esse parâmetro. Ele pode ser anterior à calibração
da MIDAS, mas participou da seleção da regra de reversão.

### 8.2 Resultado no motor oficial MIDAS

Os três sweeps preservaram essencialmente as mesmas entradas entre variantes: 2.126 em julho,
2.634 em junho e 3.193 na janela antiga. O gold baseline venceu todas as alterações em julho
e junho. Na janela antiga, `rev-078` ficou apenas US$ 12,6 acima, enquanto `rev-070` perdeu
US$ 13,5.

| variante | Δ julho | Δ junho | Δ janela antiga | Δ total 90 dias |
|---|---:|---:|---:|---:|
| `gold-baseline` | — | — | — | — |
| `rev-078` | −34,6 | −118,7 | +12,6 | −140,6 |
| `rev-070` | −79,3 | −177,2 | −13,5 | **−269,9** |
| `full-w20-bid40-rev070` | −383,6 | −336,5 | −1.670,8 | **−2.390,9** |
| `full-w30-bid40-rev070` | −353,5 | −327,7 | −1.631,1 | **−2.312,4** |

Bootstrap diário pareado nas 90 datas:

- `rev-070`: IC95% do delta **−US$ 432 a −US$ 101**;
- `rev-078`: −US$ 282 a +US$ 8;
- pacote completo de 20 s: **−US$ 4.968 a −US$ 749**;
- pacote completo de 30 s: **−US$ 4.927 a −US$ 676**.

Portanto, o teto 0,70 e os pacotes propostos são pioras estatisticamente sustentadas no
envelope atual da MIDAS. O pequeno ganho isolado de `rev-078` na janela antiga não compensa
as duas janelas posteriores. Não criar `btc-gold-v2` com esses levers.

### 8.2.1 A reversão condicional existe, mas é sub-segundo

Para separar “reverter é útil?” de “restringir a reversão da MIDAS é útil?”, o harness
simplificado foi refeito com outcome canônico, sem filtro final, depth 25 e atraso explícito.
Foram 8.601 entradas.

| atraso | saída simples | `reverse<0,70` | Δ reversão vs saída | IC95% do Δ |
|---:|---:|---:|---:|---:|
| mesmo snapshot | −168,5 | **+265,0** | **+433,5** | **+284 a +581** |
| 0,5 s | −510,6 | −426,3 | +84,3 | −71 a +237 |
| 1,0 s | −601,9 | −614,2 | −12,3 | −178 a +149 |
| 2,0 s | −643,9 | −717,1 | −73,2 | −286 a +147 |

No mesmo snapshot, a reversão melhorou a saída em treino (+293,5), validação (+46,5) e
holdout (+93,5). É um efeito real naquele instante. Porém, o ganho estatisticamente seguro
desaparece já em 0,5 s e muda de sinal em 1 s.

O teto 0,70, isoladamente, não foi confirmado. Contra reverter sem teto (`ask < 1,01`):

- mesmo snapshot: +US$ 82, IC95% −US$ 16 a +US$ 181;
- 0,5 s: +US$ 3, IC95% −US$ 96 a +US$ 104;
- 1 s: −US$ 13;
- 2 s: −US$ 13.

Assim, a parte verdadeira do handoff é “após a confirmação física, trocar de lado pode ser
melhor que apenas zerar”. A parte não demonstrada é “0,70 é o teto ótimo”. E a alegada folga
mediana de 13,5 s não é folga de execução: o book captura a vantagem em menos de 0,5–1 s.
Isso também explica por que a MIDAS já reverte, mas restringi-la para 0,70 piora o consolidado.

### 8.3 Por que AUC igual não encerra a busca pré-entrada

AUC mede ranking global, não utilidade econômica numa cauda pequena. Dois modelos podem ter
AUC praticamente igual e tomar decisões diferentes justamente perto do break-even.

Para cada entrada, foi calculado:

```text
E[PnL | pFlip] =
  shares * (1 - pFlip) * 0,995
  - orçamento
  - fee
```

Um walk-forward causal foi então executado:

- 21 dias iniciais de treino;
- refit expansivo toda semana;
- dez folds semanais de 2026-05-18 a 2026-07-26;
- cada semana prevista apenas com dias anteriores;
- outcome canônico e nenhum filtro de book final.

No proxy MIDAS de 5.625 entradas:

| gate walk-forward | bloqueadas | precisão flip | ΔPnL | PnL base → novo | DD base → novo | IC95% Δ |
|---|---:|---:|---:|---:|---:|---:|
| `E[PnL combinado] <= 0` | 3.674 (65,3%) | 16,4% | **+608,7** | −341,4 → **+267,3** | 505,5 → **195,9** | **+65 a +1.152** |
| `E[PnL combinado] <= −0,50` | 574 (10,2%) | 24,2% | +177,8 | −341,4 → −163,6 | 505,5 → 416,0 | −59 a +426 |
| `pFlip combinado >= 0,40` | 185 (3,3%) | **45,9%** | +190,9 | −341,4 → −150,5 | 505,5 → 368,8 | −5 a +396 |
| preço calibrado, `E <= 0` | 3.779 (67,2%) | 13,0% | +249,4 | −341,4 → −92,0 | 505,5 → 373,8 | −245 a +748 |
| menor preço, cobertura equivalente | 216 (3,8%) | 40,3% | **−63,9** | −341,4 → −405,3 | 505,5 → 567,3 | −315 a +190 |

O gate amplo de EV é estatisticamente positivo, mas elimina 65% do proxy e precisa ser
testado sob as entradas reais da MIDAS. O gate raro `pFlip >= 0,40` é a opção anti-flip:
triplica aproximadamente a incidência de flip versus a base de 19,5% e preserva 96,7% das
entradas. Sua vantagem sobre escolher simplesmente os menores preços, com cobertura parecida,
teve IC95% pareado de **+US$ 26 a +US$ 488**.

O padrão econômico é:

> risco de flip materialmente acima do risco que o ask remunera, após uma queda rápida do
> favorito e com o spot fisicamente perto do PTB.

Nos sinais `pFlip >= 0,40`, as medianas foram:

- ask 0,57;
- `z` físico 0,38;
- queda do mid em 15 s de 0,17;
- flip realizado de 45,9%.

Em contraste, escolher só os menores preços produziu ask mediano 0,56, queda de apenas 0,04
e perdeu dinheiro: o payout maior remunerava aquele risco. Essa é a informação residual que
a AUC global esconde.

### 8.4 Regra simples com 30 s de antecedência

Uma busca interpretável foi feita somente até 2026-06-21. Entre regras com ao menos 40 sinais
e precisão mínima de 45%, a de maior ΔPnL foi:

```text
tau = 30 s
favMid caiu pelo menos 0,05 nos últimos 15 s
z = |spot - PTB| / (sigma_1s * sqrt(tau)) <= 0,50
favAsk <= 0,68
=> não entrar
```

Resultado:

| janela | bloqueadas | flip base → sinal | ΔPnL | PnL base → novo | DD base → novo |
|---|---:|---:|---:|---:|---:|
| desenvolvimento | 125/4.501 | 20,4% → **46,4%** | +186,5 | −647,3 → −460,7 | 706,0 → 516,2 |
| posterior 22/06–26/07 | 60/2.801 | 18,7% → **45,0%** | **+64,6** | 51,4 → **116,0** | 214,3 → **194,3** |

No período posterior, o IC95% do delta foi −US$ 59 a +US$ 194: direção favorável, mas ainda
sem potência para promoção. O alerta é pré-entrada, usa somente informação disponível aos
30 s e não depende de conseguir vender durante o colapso.

No sinal mediano do período posterior, o ask foi 0,58. Após fee e settle 0,995, esse preço
tolera aproximadamente 40,0% de flips para break-even; a taxa observada foi 45,0%. É uma
divergência econômica mensurável, não apenas uma classificação de risco.

Essa regra não contradiz a rejeição da saída “só por book”. A ação aqui é **pular a entrada**,
e a queda do mid exige confirmação física `z <= 0,50`; não é vender uma posição no fundo de
um whipsaw.

### 8.5 Decisão atual

- **Rejeitar** os levers de reversão/teto 0,70 do handoff para a MIDAS gold.
- **Manter** `lead_bid40` somente como limitador experimental/shadow sujeito à latência.
- **Promover para próximo lab, não para preset/live**, os dois gates pré-entrada:
  1. regra simples `dMid15 <= -0,05 AND z <= 0,50 AND favAsk <= 0,68`;
  2. fronteira econômica `E[PnL combinado] <= 0`, com sweep de cobertura e orçamento.
- Testar ambos no motor GLS oficial com as entradas reais, sem alterar `btc-gold-v1`.

## 9. Artefatos

- `scratch/flip-model-canonical-report.md` — modelos, métricas e gate.
- `scratch/flip-model-canonical-report.json` — modelo congelado, escalas, pesos e resultados.
- `scratch/tick-exit-latency-canonical.json` — stress test de atraso.
- `scratch/tick-exit-latency-stats.json` — bootstrap pareado por dia.
- `scratch/walkforward-economic-flip-gate.md/json` — fronteira econômica walk-forward.
- `scratch/simple-preentry-flip-rule.md/json` — regra simples e corte posterior.
- `scratch/midas-antiflip-sweeps-bootstrap.md/json` — comparação estatística do sweep.
- `scratch/reverse-latency-canonical.mjs` — teste canônico da reversão com depth e atraso.
- `scratch/reverse-latency-canonical-stats.md/json` — bootstrap da reversão vs saída e sem teto.
- `scratch/gamma-validation-report.md` — auditoria do winner local vs resolvido.
- `scratch/gamma-outcomes.csv` — outcomes resolvidos usados no estudo.
- `labs/sandbox/anti-flip/` — extrator e análises reproduzíveis.

Fontes de regra e taxa:

- https://polymarket.com/event/btc-updown-5m-1777988100?outcomeIndex=0
- https://docs.polymarket.com/trading/fees
