# MIDAS: proteção definitiva contra perdas de cauda

**Data da investigação:** 27/07/2026  
**Escopo:** MIDAS Carry V1, BTC/ETH/SOL/XRP/DOGE 5m, lakehouse local e audits live já baixados  
**Estado:** especificação de pesquisa; nenhuma mudança foi promovida ou implantada no `data-robot`

## Veredito executivo

A MIDAS compra favoritos: ganha pouco muitas vezes e, quando o favorito vira no
fim, pode perder quase todo o custo da posição. Não existe detector que torne
essa assimetria inofensiva com probabilidade 100%. O que pode ser tornado
determinístico é o **máximo que o sistema aceita perder antes de enviar a
ordem**.

A solução é substituir o atual “teto de notional” por um **orçamento atômico de
pior caso**, em três níveis:

1. **US$ 2,05 por mercado/evento**, incluindo taxa e qualquer segunda compra;
2. **US$ 4,10 agregados por slot de 5 minutos**, mesmo que os cinco motores
   disparem juntos;
3. congelamento de **novas entradas** por drawdown, sem bloquear `EXIT` redutor
   ou `CANCEL` reconciliatório.

Para a configuração documentada de aproximadamente US$ 150 de capital, esses
tetos representam aproximadamente 1,37% por evento e 2,73% por slot. O valor
deve depois acompanhar o menor entre o teto em dólar aprovado e uma fração da
equity atual.

Isso precisa ser combinado com uma **via de proteção separada**:

- `REVERSE` deixa de ser uma ação indivisível;
- primeiro achata a posição antiga por `EXIT`;
- somente depois tenta comprar o lado novo, e essa nova compra continua sujeita
  a todos os limites;
- falha esperada de FAK, tamanho mínimo e negação de policy não abrem o circuito
  que protege a saída;
- nenhuma ordem GTC é tratada como preenchida até reconciliação.

Essa arquitetura não promete ganhar sempre. Ela promete algo mais útil e
auditável: **uma virada não pode consumir mais que o risco previamente
reservado**, salvo falha externa fora do modelo, e uma falha de entrada não
pode desligar a via que reduz posição.

### Decisão operacional enquanto o P0 não existe

Não há ajuste de preset que entregue esse contrato hoje. `maxEntryBudget=2`
reduziu o drawdown no lab, mas o reverse ainda pode furá-lo e o cap de conta
ainda não é central. Se um limite duro for requisito imediato, o estado seguro
é permanecer **DISARMED para novas entradas** até o P0. Qualquer contenção live
intermediária é best effort e exige plano fresco e aprovação explícita.

## 1. O problema é estrutural, não psicológico

Para `q` shares compradas a preço `p`, antes de considerar proteção:

\[
\text{ganho se vencer} \approx q(s-p)-fee
\]

\[
\text{perda se perder} \approx q p+fee
\]

onde `s = 0,995` é o settlement usado no lab. A taxa taker de cripto é:

\[
fee(q,p)=q \cdot 0,07 \cdot p(1-p)
\]

Quanto maior o preço do favorito, menor o ganho unitário e maior a cauda. A
taxa de acerto, sozinha, esconde esse risco.

### Evidência live deduplicada

O audit ampliado do BTC contém configurações diferentes no mesmo período
(`hardCapUsd` 4, 30 e 6), portanto não é holdout homogêneo. Mesmo assim, ele
mostra claramente a assimetria operacional:

| Medida | BTC live, settlement deduplicado |
|---|---:|
| Mercados únicos | 137 |
| Vitórias / derrotas | 113 / 24 |
| Taxa de acerto | 82,48% |
| Ganho médio observado | +US$ 0,5948 |
| Perda média observada | −US$ 1,8300 |
| Pior settlement | −US$ 2,7450 |
| p05 | −US$ 2,0850 |

Uma perda média apagou **3,08 ganhos médios**; a pior, **4,61 ganhos médios**.
Esses `pnlDelta` são a perna de settlement registrada, pré-fee e sem garantia de
recompor todas as saídas parciais; não são PnL líquido da carteira.

Também houve um episódio temporário com `hardCapUsd=30`: 17 shares foram
preenchidas a 0,88, criando aproximadamente **US$ 14,96 de perda binária
potencial**, antes da taxa. A posição venceu; o ponto é que o sistema chegou a
aceitar uma cauda que poderia apagar dezenas de ganhos pequenos.

### O relatório bruto supercontava PnL

| Audit | Settlements brutos | Mercados únicos | Mercados duplicados | Registros extras | Soma bruta | Soma deduplicada |
|---|---:|---:|---:|---:|---:|---:|
| Portfolio baixado | 184 | 149 | 15 | 35 | 24,0521 | 21,6371 |
| BTC ampliado | 179 | 137 | 18 | 42 | 30,8176 | 23,2976 |

Nos grupos duplicados, os `pnlDelta` repetidos eram idênticos. Portanto, não se
tratava de várias operações econômicas: era repetição contábil do mesmo
settlement.

Artefatos reprodutíveis:

- `labs/sandbox/midas-live-audit-dedup.mjs`
- `labs/sandbox/midas-live-audit-dedup.json`
- `labs/sandbox/midas-live-audit-btc-expanded-dedup.json`

## 2. Por que “prever o flip” não é a proteção definitiva

A auditoria canônica corrigiu duas fontes importantes de otimismo do estudo
inicial: winner pelo último spot local com filtro retrospectivo do book final e
execução no mesmo snapshot. Com outcome resolvido e sem o filtro futuro:

- `favMid` sozinho continuou sendo o melhor ranking geral;
- o modelo completo não melhorou a AUC global;
- sinais somente de book venderam o fundo de whipsaws;
- `lead_bid40` perdeu segurança estatística já no primeiro bucket observável de
  latência, 0,5 s;
- as 11 mudanças de `lateFlip` propostas para a MIDAS perderam para o Gold
  baseline no motor GLS oficial e em três janelas.

O handoff explica por quê: o valor da saída física estava concentrado nos
últimos 4–8 s, faixa que a MIDAS já cobre. Ampliar a janela ou impor
`bid<0,40` mudou a população residual e piorou o resultado. Portanto,
**não reabrir `lead_bid40`, janela 15/20/30 s ou teto de reverse 0,70 para a
MIDAS sem uma hipótese nova**.

### Há, porém, um pequeno padrão pré-entrada ainda em pesquisa

AUC global igual não exclui utilidade econômica numa cauda rara. O estudo
canônico encontrou uma fronteira em que o risco calibrado de flip excede o
risco remunerado pelo ask. Dois candidatos merecem somente o próximo lab:

```text
tau = 30 s
modelo combinado congelado estima pFlip >= 0,40
=> não entrar
```

e a aproximação interpretável:

```text
dMid15 <= -0,05
AND z <= 0,50
AND favAsk <= 0,68
=> não entrar
```

No walk-forward do proxy MIDAS, o primeiro marcou 3,3% das entradas, com 45,9%
de flips, e melhorou o PnL contrafactual em US$ 190,9; o IC95% do delta ainda
cruzou zero por pouco. A regra simples marcou 60 de 2.801 entradas no período
posterior, com 45,0% de flips e delta +US$ 64,6; seu IC95% também cruzou zero.

Essa é informação útil, mas ainda não “alta probabilidade definitiva”. Ela pode
evitar uma pequena parte da cauda sem depender de vender durante o colapso.
Precisa ser testada nas entradas reais da MIDAS, com outcome canônico, antes de
qualquer preset.

Há ainda uma versão ampla:

```text
E[PnL | pFlip combinado, ask, fee, settle] <= 0
=> não entrar
```

Ela bloqueou 65,3% do proxy, melhorou o PnL em US$ 608,7 e reduziu o DD de
US$ 505,5 para US$ 195,9, com IC95% positivo. É o resultado estatístico mais
forte, mas o custo de cobertura é enorme e a base era um proxy, não as entradas
Gold. Deve entrar no próximo lab como sweep de fronteira econômica, nunca ser
transportada diretamente ao live.

## 3. O que o backtest da Gold atual diz sobre reduzir tamanho

Foi executado um ablation novo, mantendo os gates, proteções, odds-shock,
depth 25, fees e settlement da MIDAS Gold live. A única mudança foi o envelope
de budget:

| Janela | Variante | PnL | PF | MaxDD | Pior dia |
|---|---|---:|---:|---:|---:|
| Jul 01–26 | live `$2,5/$4` | 576,41 | 1,703 | 14,62 | +0,73 |
| Jul 01–26 | **budget cap US$ 2** | **412,55** | **1,717** | **10,42** | +0,20 |
| Jul 01–26 | budget cap US$ 1,50 | 270,14 | 1,693 | 7,88 | −2,34 |
| Jun 01–09 | live `$2,5/$4` | 177,49 | 1,734 | 14,03 | −8,13 |
| Jun 01–09 | **budget cap US$ 2** | **125,92** | **1,737** | **9,46** | **−6,95** |
| Jun 01–09 | budget cap US$ 1,50 | 89,28 | 1,805 | 6,56 | −4,59 |

O cap de US$ 2 foi consistente:

- custou 28–29% do PnL;
- reduziu MaxDD em 29% em julho e 33% em junho;
- preservou ou elevou o profit factor;
- melhorou o pior dia de junho em 14%.

O US$ 1,50 reduziu o MaxDD em 46–53%, mas sacrificou 50–53% do PnL. O cap de
US$ 2 foi o ponto conservador mais equilibrado entre os níveis testados na
Gold atual.

Ainda assim, esse experimento limita **budget inicial**, não perda completa. No
contrafactual multiativo, 179 trades terminaram com perda maior que o risco da
primeira entrada — 18,2% dos 982 trades revertidos. Os piores acumularam
aproximadamente US$ 6,5–7,3 em compras por causa do reverse. Por isso,
`budget-cap-2` é evidência para escolher o nível de risco, mas não substitui o
Event Loss Ledger.

Artefatos:

- `reports/labs/midas-carry-v1/2026-07-28T01-41-55-130Z-tail-budget-btc-july`
- `reports/labs/midas-carry-v1/2026-07-28T01-35-18-791Z-tail-budget-btc-june`

## 4. Quatro falhas de arquitetura que hoje anulam a proteção

### 4.1 O circuit breaker bloqueia a saída

`createRiskEngine.evaluate()` consulta o circuito antes de distinguir o tipo de
intent. O limite diário também é aplicado antes de separar entrada de redução.
Assim, FAK miss ou uma rejeição determinística podem abrir o circuito e negar
`EXIT`/`REVERSE`.

No runtime, `MAX_NOTIONAL_EVENT` não consta entre as negações de policy
esperadas. Uma tentativa de reverse negada por esse limite é registrada como
falha e pode produzir a cascata:

```text
reverse negado por policy
        ↓
recordFailure()
        ↓
circuit aberto
        ↓
EXIT protetivo também negado
```

Uma proteção nunca deve ser menos autorizada porque uma entrada ou uma compra
do reverse falhou.

### 4.2 `REVERSE` mistura reduzir risco com criar risco

Hoje a intent pai é avaliada como uma operação única. O risco pode impedir a
compra do lado oposto e, por tabela, impedir também a venda protetiva do lado
antigo. O fluxo correto é:

```text
posição antiga
   │
   ├─ EXIT/CANCEL: via protetiva, delta de pior caso <= 0
   │      ↓
   │   reconciliar até FLAT ou residual conhecido
   │
   └─ ENTER no oposto: nova operação
          ↓
       passa novamente por event/slot/daily budget
```

“Bypass de reverse” deve significar **permitir o flatten**, nunca forçar a nova
compra. O próprio relatório operacional encontrou contrafactual positivo no
BTC e negativo no SOL ao liberar reverses.

### 4.3 O teto “global” não é global nem atômico

O preset ainda documenta `PORTFOLIO_MAX_ACCOUNT_EXPOSURE_USD=16` como
“4 × US$ 4”, mas existem cinco motores. Além disso:

- os containers não compartilham automaticamente o mesmo `/runs`;
- parte da operação usa `ENGINE_SHARE_ACCOUNT_BOOK=0`;
- o livro em arquivo falha aberto para memória local quando não obtém lock;
- `wouldExceed()` e `tryReserve()` usam transações de lock separadas;
- o resultado de `tryReserve()` não é verificado por `recordAccepted()`.

Duas entradas concorrentes podem passar pelo check e competir na reserva. E,
com cinco livros locais, cada motor pode acreditar que está dentro do mesmo
teto. O máximo nominal documentado pode chegar a aproximadamente US$ 20.

### 4.4 O sizing live não usa a mesma variável de risco do backtest

O live calcula quantidade com:

```text
floor(entryBudget / ask)
```

mas reserva risco como:

```text
quantity × maxPrice
```

Como `maxPrice >= ask`, a ordem pode ultrapassar o budget que originou a
quantidade. O GLS usa o preço limite para dimensionar. Esse desalinhamento deve
ser removido antes de confiar em qualquer cap.

## 5. Especificação do Event Loss Budget

Para um mercado binário, mantenha:

- `C`: fluxo de caixa acumulado do evento — vendas menos compras e taxas;
- `qUp`, `qDown`: inventário líquido confirmado;
- `s`: payout do vencedor usado pelo sistema.

Os dois PnLs terminais são:

\[
P_{UP}=C+s q_{UP}
\]

\[
P_{DOWN}=C+s q_{DOWN}
\]

Logo:

\[
L_{event}=\max(0,-\min(P_{UP},P_{DOWN}))
\]

Essa fórmula resolve um erro importante: se a posição for vendida com prejuízo
e ficar flat, `qUp=qDown=0`, mas `C<0`. O prejuízo já realizado continua
consumindo o budget; uma nova compra não “zera” a perda do evento.

Para ordens pendentes, o ledger reserva o pior entre preencher e não preencher.
Uma aproximação conservadora pode somar o maior incremento de perda de cada
ordem pendente.

### Invariante obrigatório

```text
L_event_confirmed + max_incremental_loss_pending <= R_event
```

`L_event_confirmed` é calculado pelos dois outcomes acima e, portanto, já inclui
prejuízo realizado e posição aberta. Não se deve somar novamente o mesmo
prejuízo.

O check e a reserva devem acontecer na mesma transação. O fluxo é:

```text
BEGIN ATOMIC
  ler ledger confirmado
  simular a ordem no maxPrice e com fee
  calcular novo pior caso UP/DOWN
  negar se exceder R_event ou R_slot
  gravar reservationId idempotente
COMMIT

submeter ordem
reconciliar fills reais
converter reservation em posição confirmada
liberar sobra ou expirar reservation
```

Quando o governador estiver indisponível:

- `ENTER`, `ADD` e compra do `REVERSE`: **fail closed**;
- `EXIT` redutor e `CANCEL` reconciliatório: continuam disponíveis pela via
  protetiva;
- o sistema não pode cair silenciosamente para um livro local.

### Sizing exato

Para uma compra simples, a maior quantidade permitida deve satisfazer:

\[
q\,p_{max} + q\cdot 0,07\,p_{max}(1-p_{max}) \le R_{remaining}
\]

ou:

\[
q_{max}=
\left\lfloor
\frac{R_{remaining}}
{p_{max}[1+0,07(1-p_{max})]}
\right\rfloor
\]

respeitando precisão e tamanho mínimo retornados pelo mercado. Se a menor ordem
válida não cabe no orçamento, a decisão correta é **SKIP**, não aumentar o cap.

Exemplo em `pmax=0,94`:

- 2 shares: risco máximo inicial ≈ **US$ 1,8879**;
- 3 shares: risco máximo inicial ≈ **US$ 2,8318**.

Com `R_event=US$ 2,05`, entram 2 e a terceira é matematicamente impossível.

A documentação atual também oferece `max_spend` em BUY market: o SDK reduz o
notional para que ordem + fees caibam no teto. Isso deve ser usado como segunda
barreira quando o client adotado suportar a opção. O `data-robot` atual envia
marketable limit por `createAndPostOrder`, sem `max_spend`; portanto, o cálculo
local e o ledger continuam obrigatórios.

## 6. Governador central por slot

Os ativos não são diversificação independente. No estudo de julho com o sizing
Gold:

- quando BTC perdeu e ETH também estava em trade, ETH perdeu em 40% dos casos,
  contra 25,2% incondicional — lift 1,59;
- 18,3% dos slots com alguma perda tiveram perdas em mais de um ativo;
- com quatro ativos simultâneos, houve pelo menos duas perdas em 34,3% dos
  slots e pelo menos três em 6,0%.

Os valores em dólar desse estudo usam sizing maior e não devem ser transportados
diretamente para o live; as taxas condicionais demonstram a dependência.

### Política inicial recomendada

| Limite | Valor inicial | Regra |
|---|---:|---|
| `R_event` | `min(US$ 2,05; 1,5% da equity)` | pior caso completo de um mercado |
| `R_slot` | `min(US$ 4,10; 3,0% da equity)` | soma do pior caso de todos os ativos no mesmo 5m |
| ativos simultâneos | no máximo 2 unidades de risco | cinco sinais não viram cinco apostas |
| indisponibilidade do governor | negar aumento | redução continua |

Na equity documentada de aproximadamente US$ 150:

| Envelope de pior caso simultâneo | Risco | % da equity |
|---|---:|---:|
| teto configurado atual, 5 × US$ 4 | até US$ 20,00 | 13,33% |
| somente `R_event`, 5 × US$ 2,05 | até US$ 10,25 | 6,83% |
| `R_event` + `R_slot` | **US$ 4,10** | **2,73%** |

Isso é um teto, não uma previsão de que todos perderão. A correlação observada
mostra por que o cenário conjunto não pode ser descartado como independência.

### Contrafactual de admissão nos cinco ativos

O GLS oficial foi reexecutado em BTC/ETH/SOL/XRP/DOGE no sizing live
`$2,5/$4`. Em seguida, as entradas foram aceitas cronologicamente até consumir
um cap de risco inicial por slot:

| Cap inicial/slot | Trades aceitos | Skips | PnL | PF | MaxDD | Pior slot |
|---:|---:|---:|---:|---:|---:|---:|
| sem cap efetivo | 6.605 | 0,0% | 1.218,71 | 1,448 | 29,20 | −10,11 |
| US$ 8,20 | 6.294 | 4,7% | 1.170,20 | 1,450 | 30,09 | −10,11 |
| US$ 6,20 | 5.693 | 13,8% | 1.053,74 | 1,443 | 26,24 | −7,88 |
| **US$ 4,10** | **4.000** | **39,4%** | **864,04** | **1,538** | **25,41** | **−6,50** |

O cap US$ 4,10 reduziu o pior slot em 36% e elevou o PF, ao custo de 29% do
PnL. Esse número de skips é conservador para a arquitetura proposta: ele foi
aplicado às entradas atuais, que ainda chegam a US$ 3–4 cada. Com
`R_event=US$2,05`, duas unidades cabem no slot por construção.

Mais importante: a pior perda individual continuou em −US$ 6,50 porque o
contrafactual só controlou a admissão inicial e deixou o reverse vigente.
Portanto, o teste **refuta** a ideia de que um simples portfolio cap resolve a
cauda e confirma a necessidade do ledger por evento.

Artefato: `labs/sandbox/midas-portfolio-tail-budget.json`.

O cap deve usar **pior perda terminal**, não soma de notionals. Isso reconhece
corretamente holdings nos dois lados e prejuízo já realizado.

A política de escolha entre sinais simultâneos afeta PnL, não segurança. Ela
deve ser validada separadamente. Até existir ranking calibrado em holdout,
usar ordem determinística e auditável; não aumentar `R_slot` para evitar skips.

## 7. Via protetiva de execução

### Classes de circuit

1. **Entry circuit:** bloqueia aumentos de risco.
2. **Transport/auth circuit:** informa que o CLOB está indisponível; aciona
   alarme, cancel/reconcile e impede novas entradas.
3. **Protection lane:** permite `CANCEL` e tentativas limitadas de `EXIT`; não é
   aberta por miss FAK, min size, post-only, FOK miss ou negação de policy.

O nome da intent não basta: antes do bypass, o ledger simula a operação e exige
`L_after <= L_before`. Isso impede que um `EXIT` incorreto de uma carteira
hedgeada seja tratado como redutor apenas pelo rótulo.

O kill switch também deve ter semântica explícita:

- `FREEZE_ENTRY`: impede aumentar risco, permite cancelar/achatar;
- `TRANSPORT_OFF`: nenhuma escrita externa, reservado a incidente de
  credencial/operador e acompanhado de alarme crítico.

### Saga de saída

1. Ler book fresco, ordens abertas e balance `CONDITIONAL`.
2. Calcular `sellable = min(qty_OMS, balance - sells_abertas)`.
3. Obter `min_order_size`/`mos` do mercado; não hardcodar 5.
4. Enviar FAK marketable com piso explícito; aceitar preenchimento parcial.
5. Reconciliar order status, fills, balance e posição.
6. Fazer no máximo duas novas tentativas com quote fresco e deadline.
7. Se usar GTC como fallback, dar TTL curto, verificar fill e cancelar o
   residual; GTC não é fill garantido.
8. Confirmar `FLAT` por estado reconciliado. Residual abaixo do mínimo vira
   `UNEXITABLE_DUST` e permanece no pior caso do ledger.

Na Polymarket, FAK pode preencher parcialmente e cancelar o restante; FOK é
tudo ou nada; GTC descansa até preencher ou ser cancelada. BUY market usa valor
em dólares e SELL usa shares. A implementação deve seguir essas semânticas, não
o status de aceitação HTTP.

## 8. Contabilidade e observabilidade

### Idempotência de settlement

Usar chave única:

```text
(strategyInstanceId, marketId, settlementVersion)
```

com estado persistente `queued -> settling -> settled`. WS, poll e rotação
devem chamar o mesmo método transacional. Um segundo chamador recebe o resultado
existente e não altera PnL.

### Ledger mínimo

Registrar de forma append-only:

- reservation criada/negada/expirada;
- snapshot de `eventWorstLoss` e `slotWorstLoss`;
- submit, ack, fill parcial, fill final, cancel e reject normalizado;
- balance/allowance usado na saída;
- PnL de saída, settlement, fees e idempotency key;
- configuração e commit ativos em cada evento.

O painel deve mostrar **pior perda ainda possível**, não apenas notional aberto
ou taxa de acerto.

## 9. Proteções auxiliares: o que manter e o que rejeitar

### Manter depois dos P0

- o `lateFlip`/danger já calibrado do Gold baseline;
- FAK nas entradas com retries limitados e quote fresco;
- self-deleveraging por equity, sem martingale;
- os gates pré-entrada canônicos apenas como variantes de próximo lab.

### Não tratar como proteção dura

- odds-only, book-collapse ou early-warn sem cruzamento físico;
- reverse forçado;
- GTC como “fill garantido”;
- `lossStreakPause` como preditor de próximo flip;
- cinco limites locais chamados de teto global;
- `maxLossUsd` atual como se fosse stop-loss.

No sizing pequeno, a saída parcial de odds-shock também conflita com tamanho
mínimo: o relatório operacional observou 9 submits abaixo de 5 shares, 5
rejeitados e 4 preenchidos. Ela pode continuar como experimento
min-size-aware, mas não deve contar na promessa de limite de perda.

## 10. Drawdown governor

O limite diário deve bloquear apenas novas exposições. Uma proposta inicial,
para shadow e replay, é:

| Estado | Gatilho desde o high-water diário | Ação |
|---|---:|---|
| normal | < 2 `R_event` | `R_event` integral |
| soft | ≥ 2 `R_event` | reduzir novos budgets em 50% |
| hard | ≥ 3 `R_event` | congelar entradas até reset/manual |
| emergency | erro de ledger ou divergência de balance | freeze entry + reconcile + alerta |

Os valores não foram ainda selecionados por holdout e não devem ser promovidos
como alpha. São limites de dano. `EXIT` com `deltaRisk<=0` e `CANCEL`
reconciliatório permanecem autorizados em todos os estados, exceto
`TRANSPORT_OFF` explícito.

## 11. Ordem de implementação

### P0 — torna o teto real

1. Implementar `EventLossLedger` com cálculo UP/DOWN, fees e pending orders.
2. Substituir o file book por governador central transacional.
3. Corrigir sizing live para `maxPrice + fee`.
4. Dividir reverse em `flatten` e nova entrada.
5. Separar circuits e liberar intents redutoras de risco.
6. Tornar settlement idempotente.

| Alvo no `data-robot` | Mudança necessária |
|---|---|
| `src/risk/createRiskEngine.js` | classificar intent antes dos blocks; reserva atômica de pior caso; verificar resultado |
| `src/risk/fileAccountBook.js` | retirar fail-open e TOCTOU; substituir por backend realmente compartilhado |
| `src/tfc/sizeCanaryBuy.js` | dimensionar por `maxPrice + fee`, respeitando risco restante |
| `src/engine/runtime.js` | policy denial e miss esperado não chamam `recordFailure`; protection lane própria |
| `src/oms/reverseSaga.js` | flatten autorizado separadamente; nova compra reavaliada depois de `FLAT` |
| `src/control/engineApp.js` | settlement transacional e idempotente entre WS, poll e rotação |

### P1 — torna a saída honesta

1. Normalizar reason codes CLOB.
2. Implementar saga FAK/reconcile/GTC-TTL.
3. Sincronizar balance `CONDITIONAL` antes de SELL.
4. Tratar dust/min size explicitamente.

### P2 — tenta recuperar PnL sem reabrir a cauda

1. Testar `pFlip>=0,40`, a regra simples e a fronteira `E[PnL]<=0` nas entradas
   oficiais.
2. Testar ranking de sinais quando `R_slot` só comportar dois ativos.
3. Calibrar os thresholds de drawdown em walk-forward.
4. Não reabrir os levers `lead_bid40`/reverse 0,70 já rejeitados.

## 12. Gates de promoção

### Testes determinísticos

- ordem que excede o cap por US$ 0,01 é negada;
- duas reservas concorrentes não ultrapassam `R_slot`;
- falha de lock/governador nega entrada;
- FAK miss não abre protection circuit;
- `MAX_NOTIONAL_EVENT` não é falha de sistema;
- daily stop nega ENTER, mas permite EXIT com `deltaRisk<=0` e CANCEL
  reconciliatório;
- reverse vende primeiro; compra oposta negada não desfaz o flatten;
- partial fill atualiza risco pelo fill real e libera reserva excedente;
- settlement repetido mantém PnL exatamente uma vez;
- tamanho mínimo acima do budget produz SKIP.

### Replay e shadow

1. Repassar os audits atuais e verificar que a cascata
   `FAK miss -> circuit -> deny EXIT` desaparece.
2. Reexecutar 100, 500, 2.000 e 5.000 eventos com book walk, fee, latency,
   partial/miss e dust.
3. Shadow simultâneo nos cinco ativos, comparando ledger central com CLOB e
   balance real após cada mercado.
4. Só então preparar canário; qualquer escrita live exige aprovação explícita
   e plano fresco.

## 13. Limites desta conclusão

- A segurança econômica depende de reservar pelo preço máximo e de o ledger
  central ser realmente atômico.
- Uma exchange indisponível, credencial inválida ou settlement excepcional pode
  impedir uma saída; por isso exits são best effort e o cap pré-entrada é a
  defesa principal.
- Os audits live misturam versões e não são um experimento causal de PnL.
- A simulação de cap agregado por slot é contrafactual de admissão; o reverse
  deverá ser reexecutado sob o novo ledger antes de promoção.

## Referências internas

- `docs/operacao/falhas-envio-ordens-achados-2026-07-27.md` no `data-robot`
- `labs/sandbox/anti-flip/HANDOFF-completo.md`
- `reports/research/anti-flip-btc5m-canonical-2026-07-27.md`
- `labs/sandbox/midas-loss-mitigation-report.md`
- `labs/sandbox/midas-gold-portfolio-size-2026-07-27.md`
- `labs/sandbox/midas-cross-asset-loss-corr.json`
- `reports/labs/midas-carry-v1/2026-07-26T15-41-19-595Z-eps-shield-july`
- `reports/labs/midas-carry-v1/2026-07-26T15-45-38-712Z-eps-shield-june`

## Referências oficiais Polymarket

- [Place Orders](https://docs.polymarket.com/trading/place-orders)
- [Order Lifecycle](https://docs.polymarket.com/concepts/order-lifecycle)
- [Fees](https://docs.polymarket.com/trading/fees)
- [Get CLOB market info](https://docs.polymarket.com/api-reference/markets/get-clob-market-info)
- [Get order books](https://docs.polymarket.com/api-reference/market-data/get-order-books-request-body)
