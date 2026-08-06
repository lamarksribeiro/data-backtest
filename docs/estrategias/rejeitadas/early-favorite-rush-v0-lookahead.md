# Early Favorite Rush V0 — REJEITADA (lookahead na seleção da entrada)

**Data:** 2026-08-05
**Status:** **REJEITADA** — o edge reportado não existe
**Substitui:** `docs/estrategias/nao-implementadas/early-favorite-rush-v0.md`

> **Addendum canônico BTC:** a análise multiasset abaixo usa proxy de último tick.
> A auditoria decisória com 25.313 settlements canônicos BTC também rejeitou o
> suposto sobrevivente terminal: `τ≤30s & z≥1,25` fez +US$80,88 no treino,
> +US$10,95 na validação e **−US$77,78 no teste**. O stop `z≤−2` baixou falsos
> stops para 8,13%, mas ficou pior que o stop atual em PnL agregado. Portanto,
> **não há candidato promovível nesta família**. Relatório autoritativo:
> `reports/research/early-favorite-rush-causal-canonical-audit-2026-08-05.md`.

**Scripts de auditoria:**
- `scratch/efr-extract-features.mjs` — dump de features + path por entrada
- `scratch/efr-01-calibration.mjs` — calibração e z
- `scratch/efr-02-verify-lookahead.mjs` — **a prova**
- `scratch/efr-03-residual-edge.mjs` — break-even, gates, concorrência
- `scratch/efr-04-stops-and-survivor.mjs` — stops e robustez

---

## 1. O bug

`scratch/multi-asset-early-fav-rush.mjs`, função `firstCross()` (linha 137). O buffer
vem `ORDER BY ... tau DESC`, ou seja **índice 0 = início do evento**. O laço percorre
`i` de `buf.length-1` até `0` — **de trás para frente no tempo** — e `prev` guarda o
tick de índice `i+1`, que é o tick **posterior** no tempo.

```js
for (let i = buf.length - 1; i >= 0; i -= 1) {      // ← anda para TRÁS no tempo
  ...
  if (favAsk >= thr && favAsk < 1 && (prev == null || prev < thr)) {
    return { side, ask: favAsk, tau: t.tau, ... };  // ← prev é o tick SEGUINTE
  }
  prev = favAsk;
}
```

A condição dispara quando `fav(i) >= thr` **e** `fav(i+1) < thr`: um cruzamento
**para baixo**, olhando o tempo para frente. E como a varredura começa no fim do
evento e retorna no primeiro achado, ela devolve o **último** cruzamento para baixo
do evento inteiro.

Dois problemas, um fatal:

1. Não é "o primeiro tick em que o favorito cruza ≥85¢" — é quase o oposto.
2. **Saber qual cruzamento é o último exige ter visto o evento inteiro.** Ao vivo,
   em τ=200s, é impossível saber se virá outro cruzamento depois. A seleção da
   entrada usa informação do futuro.

O efeito da seleção é grande porque, por construção, depois da entrada escolhida o
favorito cai abaixo de 85¢ **uma vez** e depois sobe e fica acima até o settle —
condiciona a amostra a eventos que resolveram limpo.

## 2. A prova

`efr-02-verify-lookahead.mjs` reimplementa `firstCross` **literalmente** e reproduz
os números do lab original **na casa decimal** (BTC `n=10159 win=92.02% pnl=$5494.57`
bate exatamente com o relatório). Na mesma passagem calcula duas variantes honestas:

- **HONESTO** — primeiro cruzamento de **subida**, varredura para frente.
- **AO VIVO** — a *mesma* regra do original (cruzamento para baixo), mas pegando o
  **primeiro** em vez do último: é o que dá para executar sem ver o futuro.

Mesmas regras por asset, mesmo modelo de PnL ($10/trade, settle 0.995, fee 7%):

| Asset | ORIGINAL (com lookahead) | HONESTO 1ª subida | MESMA regra, executável |
|-------|--------------------------|-------------------|--------------------------|
| BTC   | n=10159 win=92.02% **+$5.495** | n=21010 win=85.52% **−$3.691** | n=15946 win=81.98% −$9.631 |
| ETH   | n=5331 win=92.18% **+$3.045** | n=12576 win=85.70% **−$2.081** | n=8861 win=81.51% −$5.857 |
| SOL   | n=6948 win=92.03% **+$3.782** | n=13951 win=86.55% **−$1.160** | n=10173 win=82.67% −$5.418 |
| XRP   | n=4641 win=91.73% **+$2.386** | n=12538 win=84.68% **−$4.281** | n=8678 win=80.57% −$6.770 |
| BNB   | n=4353 win=90.90% **+$1.592** | n=11150 win=82.22% **−$7.738** | n=7936 win=77.72% −$9.192 |
| DOGE  | n=6767 win=91.33% **+$1.729** | n=13805 win=86.42% **−$4.485** | n=9453 win=81.67% −$7.924 |
| HYPE  | n=1665 win=93.21% **+$1.241** | n=2310 win=82.68% **−$1.202** | n=1680 win=78.69% −$1.575 |
| **TOTAL** | **n=39864 +$19.270** | **n=87340 −$24.639** | **n=62727 −$46.367** |

**7 de 7 ativos invertem o sinal.** O lucro de +$19.270 é integralmente artefato.

Todos os labs derivados herdaram a mesma entrada e portanto o mesmo artefato:
`multi-asset-early-fav-optimize`, `-disaster-exit`, `-take-profit`,
`-reward-risk-exit`, `-corr`, e os `xrp-early-fav-*`.

## 3. Por que não havia edge para achar

Comprar a `ask` e segurar até o settle exige um win rate mínimo. A 85¢, com fee 7%
e settle 0.995, o break-even é **86,3%**. Realizado por faixa de ask (entradas
honestas, 129.576 candidatas):

| ask | break-even | win real | n | $/trade | gap |
|-----|-----------|----------|---|---------|-----|
| 0,85 | 86,80% | 81,59% | 63.233 | −$0,554 | −5,21pp |
| 0,86 | 87,76% | 84,14% | 20.957 | −$0,363 | −3,61pp |
| 0,87 | 88,71% | 82,89% | 14.883 | −$0,611 | −5,82pp |
| 0,88 | 90,14% | 86,00% | 15.436 | −$0,404 | −4,14pp |
| 0,90 | 92,51% | 83,51% | 8.471 | −$0,901 | −9,00pp |
| 0,93 | 97,22% | 69,19% | 6.596 | −$2,775 | −28,03pp |

Nenhuma faixa cobre o próprio break-even. É a mesma conclusão de
`book-e-calibracao-btc5m`: **o book está calibrado**, a `ask` já é a probabilidade.
Não existe "favorito barato" nessa família.

## 4. O stop atual piora o resultado

Sobre entradas honestas (população operável, spot concorda, n=114.342):

| política | $/trade | saídas | falsas | %falsas | Δ vs hold |
|----------|---------|--------|--------|---------|-----------|
| hold | −$0,2984 | — | — | — | 0 |
| `bid≤0,25` só nível | −$0,5624 | 23.199 | 6.578 | 28,4% | −$30.191 |
| **LIVE `bid≤0,25`+flips** | **−$0,3271** | 18.401 | 3.366 | **18,3%** | **−$3.285** |
| `bid≤0,25`+flips+τ≤120 | −$0,3170 | 18.053 | 3.045 | 16,9% | −$2.134 |
| `z≤−1,0` | −$0,2853 | 17.056 | 2.369 | 13,9% | +$1.494 |
| `z≤−1,5` & τ≤60 | −$0,2780 | 14.269 | 975 | 6,8% | +$2.332 |
| **`z≤−2,0`** | **−$0,2771** | 12.776 | 570 | **4,5%** | **+$2.428** |

*falsa = saiu mas teria ganho no settle.*

O stop que está rodando **destrói $3.285** contra simplesmente segurar, e 18,3% das
suas saídas são falsas. A suspeita de "falsos stops" estava certa.

A causa é o gatilho ser o `bid`, que é uma variável **atrasada e endógena** — o book
recua com ruído. O gatilho causal é o **z**: quanto o underlying andou contra a
posição em relação à vol restante,

```
z = ln(S/PTB) · sinal(lado) / (σ · √τ)
```

Trocar `bid≤0,25` por `z≤−2,0` derruba o falso-stop de **18,3% → 4,5%** e vale
**+$5.713** contra o stop atual. Mas atenção: isso só **reduz a sangria**. Nenhum
stop transforma entrada de EV negativo em positivo.

## 5. Os 7 ativos não são 7 apostas

O lab `-corr` mediu correlação **diária** (média 0,169) e concluiu diversificação.
A medida certa é **por evento** — é lá que o risco acontece:

| k ativos no evento | eventos | P(todos perdem) | esperado se indep. | razão |
|---|---|---|---|---|
| 2 | 1.779 | 4,95% | 2,232% | 2,2× |
| 4 | 1.257 | 0,64% | 0,050% | 13× |
| 5 | 3.104 | 0,71% | 0,007% | 100× |
| 7 | 5.798 | 0,52% | 0,000% | ~1000× |

Em **53,6%** dos eventos com ≥2 ativos, **todos entram no mesmo lado**. Resolvendo
`p^k_ef = 0,0052` com `p≈0,15`: os 7 ativos valem **≈2,8 apostas independentes**.

É exatamente o "quando perde, perde tudo" do dashboard: 02:05Z perdeu SOL+BNB juntos,
02:00Z perdeu ETH+DOGE juntos. Não é azar — é uma aposta só, dividida em sete tickets.

## 6. O que sobrevive

Das 17 hipóteses pré-registradas (train/holdout 70/30 por ativo, IC95 bootstrap por
**dia** — bloco, porque trades do mesmo dia são correlacionados), passaram três, todas
da mesma família:

| gate | n | win% | $/trade | IC95 | train | holdout |
|------|---|------|---------|------|-------|---------|
| τ≤30s & z≥1,25 | 1.667 | 91,42% | +$0,267 | [0,125; 0,414] | +0,325 | +0,132 |
| τ≤45s & z≥1,5 | 1.758 | 90,22% | +$0,168 | [0,009; 0,333] | +0,243 | +0,010 |
| **τ≤30s & z≥1,25 & spread≤0,01** | **653** | **92,19%** | **+$0,495** | **[0,285; 0,735]** | **+0,515** | **+0,530** |

Note que isso é o **oposto** da tese: não é rush **precoce**, é **favorito terminal**.
A família "early" (τ≥60s) é toda negativa. Sensibilidade sem knife-edge — degrada
suavemente ao abrir τ (τ≤20: +$0,61 · τ≤30: +$0,50 · τ≤40: +$0,39 · τ≤60: +$0,29).

Por mês, não está decaindo: abr −0,52 (n=24) · mai +0,12 · jun +0,60 · jul +0,68 ·
ago +0,68. Concentra em BTC (379) / ETH (169) / SOL (57) / XRP (39); BNB, DOGE e HYPE
praticamente não produzem sinal.

**Ressalvas honestas:**
- **6,66 trades/dia** somando os 7 ativos → **$3,30/dia** a $10/trade. É pequeno.
- 653 trades, e foram testadas 17 hipóteses — risco de multiple testing real. O que
  sustenta é a consistência train/holdout (+0,515 vs +0,530) e o platô de limiares.
- **Fill não foi validado.** Todo este lab assume ask tocável idealizado. A τ≤30s é
  justamente onde latência e FAK mais machucam, e o filtro de spread≤0,01 provavelmente
  está capturando "book real" — isto é, exatamente o que sumiria com execução honesta.
- É a mesma família do TSC (`tsc-edge-decaindo`), que já foi medida antes.

## 7. Veredito

1. **Parar a Early Favorite Rush como está.** Não tem edge; está pagando taxa para
   comprar probabilidade a preço justo, com um stop que piora o resultado.
2. Se for manter algo ligado enquanto se decide: **tirar o stop `bid≤0,25`** (segurar
   é melhor) ou trocá-lo por `z≤−2,0`.
3. **Marcar como concorrentes** os 7 ativos: são ~2,8 apostas, não 7. Sizing precisa
   ser por evento, não por ativo.
4. O único candidato é o **favorito terminal** (τ≤30s, z≥1,25, spread≤0,01) — e
   antes de qualquer capital ele precisa de **smoke com fill honesto**, porque é o
   regime mais sensível a execução.

## 8. Lição de método

O lab original nunca comparou a entrada contra uma versão executável de si mesma.
Um teste barato que teria pego isto no primeiro dia: **rodar a mesma regra pegando o
primeiro sinal em vez do melhor/último, e ver se o número sobrevive.** Vale como
gate padrão para todo lab novo daqui em diante — junto com "win rate realizado vs
break-even do preço pago", que aqui teria mostrado −5pp de cara.
