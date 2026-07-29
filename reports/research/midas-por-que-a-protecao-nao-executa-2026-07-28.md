# MIDAS — por que a proteção não executa: o GTC não é o problema

**Data:** 2026-07-28
**Fonte:** `prod-audit-2026-07-24.jsonl` + `prod-audit-2026-07-25.jsonl` (22.330 registros)
**Código:** `data-robot` @ working tree local
**Estado:** diagnóstico. Nenhuma configuração live, deploy ou ordem foi alterada.

---

## Veredito

**Trocar `FAK → GTC` na perna de saída não conserta nada hoje, porque nenhuma
ordem de saída chega a ser criada.** A proteção é negada pelo risk engine antes
de virar ordem.

Em dois dias de operação:

| Fato | Número |
|---|--:|
| Ordens submetidas ao CLOB, no total | **60** |
| Delas, `ENTER/FAK` | 58 |
| Delas, `REVERSE/FAK` | 2 |
| Delas, `EXIT` puro | **0** |
| Intents protetivas **negadas antes de virar ordem** | **200** |
| — por `CIRCUIT_OPEN` | **196** |
| — por `MAX_NOTIONAL_EVENT` | 4 |
| Intents `ENTER` negadas | **0** |

200 tentativas de proteger a posição, 2 executadas. A taxa de execução da
proteção é **1%**.

---

## A cadeia causal, confirmada no código

```text
ENTER FAK com maxPrice = ask + 0,02
        ↓  latência p50 645 ms, p90 1413 ms, p99 3806 ms
        ↓  o book anda 1–2 atualizações (ticks de ~500 ms)
23× "no orders found to match with FAK order"      ← comportamento NORMAL de FAK
        ↓
liveTransport.js → circuit.recordFailure()
        ↓
circuit abre
        ↓
createRiskEngine.evaluate() consulta o circuito ANTES de classificar a intent
        ↓
196× REVERSE protetivo negado com CIRCUIT_OPEN
        ↓
posição segura até o settlement → perda média −US$ 1,83
```

### Evidência 1 — a falha de ENTER não é falta de liquidez

24 de 24 falhas amostradas tinham **liquidez visível no book no momento do
submit**: 48 a 368 shares disponíveis, para ordens de 2–3 shares, com `maxPrice`
2 centavos acima do ask.

| resultado | ask no submit | maxPrice | liq visível | qty preenchida | latência |
|---|--:|--:|--:|--:|--:|
| REJECT | 0,83 | 0,85 | 92,4 | 0 | 578 ms |
| REJECT | 0,88 | 0,90 | 368,3 | 0 | 376 ms |
| REJECT | 0,91 | 0,93 | 260,8 | 0 | 466 ms |
| REJECT | 0,60 | 0,62 | 76,0 | 0 | 3806 ms |

Taxa de falha de `ENTER`: **40,7%** (24 de 59 terminais).

Hipótese de **tamanho mínimo foi testada e refutada**: todas as ordens foram de
2 ou 3 shares e mesmo assim 29–43% preencheram. Não é piso de tamanho.

O que sobra é **latência + colchão de slippage estreito**: `entrySlippageMax`
0,02 com p50 de 645 ms, numa janela de 9–30 s do expiry onde o gamma terminal
faz o preço andar 2–3 c em menos de um segundo.

### Evidência 2 — o circuito bloqueia a saída por construção

`src/risk/createRiskEngine.js`:

```js
function evaluate(intent, ctx = {}) {
  ...
  const circuitEval = circuit.evaluate();
  if (!circuitEval.allow) {
    return deny(RISK_REASON.CIRCUIT_OPEN, circuitEval.detail, meta);   // ~linha 121
  }
  ...   // a classificação da intent só acontece DEPOIS
```

A intent nunca é classificada como redutora de risco. Um `REVERSE` protetivo é
negado exatamente como um `ENTER`.

### Evidência 3 — a proteção parcial existente não cobre o caso

`src/engine/runtime.js:22` já tem um `EXPECTED_POLICY_DENIALS` que impede
negações de policy de abrir o circuito. Mas a lista tem 10 códigos e
**`MAX_NOTIONAL_EVENT` não está entre eles** — então as 4 negações por esse
motivo também chamaram `recordFailure()` e realimentaram o circuito.

Além disso, esse guard cobre negações do *risk engine*. As aberturas de circuito
que causaram o problema vêm do *transporte* (`liveTransport.js`, três chamadas a
`circuit.recordFailure()`), onde um FAK sem match é tratado como falha de
sistema.

---

## O fix, em ordem de impacto

| # | Mudança | Alvo | Destrava |
|---|---|---|---|
| **1** | Classificar a intent **antes** de consultar o circuito; intents redutoras de risco (`EXIT`, perna de flatten do `REVERSE`, `CANCEL`) passam por uma protection lane própria | `src/risk/createRiskEngine.js:~121` | **196 das 200 negações** |
| **2** | FAK sem match **não** é falha de transporte — não chamar `circuit.recordFailure()` | `src/executor/liveTransport.js:~524` | impede o circuito de abrir |
| **3** | Incluir `MAX_NOTIONAL_EVENT` em `EXPECTED_POLICY_DENIALS` | `src/engine/runtime.js:22` | as outras 4 |
| **4** | Dividir `REVERSE` em flatten + nova entrada, avaliadas separadamente | `src/oms/reverseSaga.js` | a compra negada não desfaz a venda |
| **5** | *Só então* `FAK → GTC` na perna de saída | `src/tfc/preset-midas.js` | passa a importar: agora existe ordem |
| **6** | Reduzir a perda de `ENTER`: alargar `entrySlippageMax` ou cortar latência | preset / transporte | recupera ~40% das entradas |

Os itens 1–3 são pequenos e independentes. **Sem eles, o item 5 é inócuo.**

Sobre o item 6: alargar o slippage custa dinheiro por trade e o lab pode medir o
trade-off (`+1c ≈ −12% do PnL hold`, `+3c ≈ −35%`, do plano de lucratividade
§3.3). Cortar a latência é gratuito e p50 645 ms é muito alto para uma
estratégia que decide numa janela de 9–30 s.

---

## Sobre testar com ordens reais

**Para encontrar o defeito, não é necessário.** Ele está inteiramente visível no
audit que já existe: 200 negações, 196 com o código do motivo, e a linha de
código que as produz.

Teste live com ordem real é a ferramenta certa para a fase seguinte — **verificar
o fix** e medir o que o audit não consegue medir: a probabilidade de fill de uma
venda GTC no book fino de 3–8 s, que hoje é desconhecida porque nunca foi
tentada.

### Antes de gastar: replay do audit (grátis)

Reprocessar os audits de 24–25/07 contra o código corrigido e verificar que a
cascata `FAK miss → circuit → deny REVERSE` desaparece. Critério objetivo:
as 200 negações viram ≤ 4. Isso é regressão determinística e não custa nada.

### Protocolo de sonda live, se e quando for autorizado

Desenho com **risco direcional zero** e custo conhecido de antemão:

1. Rodar com a estratégia **DISARMED** — a sonda não interage com a MIDAS.
2. Comprar um **complete set** (UP e DOWN, mesma quantidade) cedo, com o book
   grosso. Sem exposição direcional: um dos lados sempre paga 0,995.
3. Aos 3–8 s do expiry, identificar a perna perdedora e enviar a venda GTC
   marketable que se quer testar.
4. Registrar: foi submetida? preencheu? quanto? latência? book no submit?
5. Aconteça o que acontecer, a perna vencedora liquida — a perda é limitada e
   conhecida antes da ordem.

Custo por sonda, com 5 shares e soma de odds ≈ 1,00:

```text
(upAsk + downAsk − 0,995) × 5  +  2 fees taker
≈ 0,025 + 0,07  ≈  US$ 0,10
```

**50 sondas ≈ US$ 5–8**, e entregam uma curva real de fill por faixa de
segundos restantes — exatamente o número que falta para decidir entre GTC,
retry e sair mais cedo (`cushionDecay`).

Isso é gasto de dinheiro real e ordem externa: requer autorização explícita e
plano fresco no momento da execução. Não foi executado.

---

## O que isso muda no relatório anterior

`reports/research/midas-execucao-vs-envelope-2026-07-28.md` recomendava, na §4.1,
"deploy do fix GTC per-leg" como ação #2. **Continua necessário, mas não é
suficiente e não é o primeiro passo.** A ordem correta é: itens 1–3 acima,
depois o GTC.

O `cushionDecay` recomendado naquele relatório **fica ainda mais indicado**: ele
dispara aos 20–4 s em vez de 8–4 s, então sofre menos com a latência de 645 ms, e
só age com `bid ≥ 0,55 × entrada`, ou seja, quando existe contraparte. Mas ele
também é uma intent de saída — **também está sujeito às mesmas 196 negações**
enquanto os itens 1–3 não forem feitos.
