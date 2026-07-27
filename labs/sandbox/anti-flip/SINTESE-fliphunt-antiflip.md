# Síntese: Flip Hunt V1 × Anti-Flip — o que se confirma, o que muda

**Data:** 2026-07-27 · **Janela:** 91 dias (2026-04-23 → 2026-07-26) · **Ativo:** BTC 5m, depth 25
**Scripts:** `merge-fliphunt-antiflip.mjs`, `reverse-test.mjs` · **Base:** [README.md](README.md) (estudo anti-flip)

Replicação independente das entradas do preset `btc-tight-spread` sobre o parquet cru, com
varredura de book depth 25 na entrada e na saída, fee `0,07·p·(1−p)`, settle 0,995, e validação
de label contra o mid do book final. **1.146 entradas em 89 dias.**

---

## 1. As duas análises não competem — descrevem o mesmo fenômeno por lados opostos

| | Anti-Flip | Flip Hunt H2 |
|---|---|---|
| Momento | spot cruza o PTB | spot cruza o PTB |
| Ação | **vende** o líder velho | **compra** o líder novo |
| Fonte do ganho | bid ainda não colapsou | ask ainda não subiu |

Ambas exploram **o atraso do book em relação ao cruzamento físico**. São a mesma aresta vista
de dois lados, não duas estratégias distintas.

### Convergência tripla no resultado negativo

Três métodos independentes concluíram que **não se antecipa o flip**:

| Método | Evidência |
|---|---|
| Miner Flip Hunt (H1 `fake_leader_dog`) | comprar o azarão *antes* do flip: train exp **−0,487**, PF 0,906 |
| Estudo anti-flip (AUC residual) | microestrutura dentro de faixa de preço: **AUC ≈ 0,50** |
| Relatório canônico (contrafactual) | bloquear entrada a 20% de risco: **ΔPnL −$173** |

O `market_raw` do relatório canônico (AUC 0,899 a 30s) e meu `favMid` (AUC 0,911) medem a mesma
coisa e concordam. A linha "prever flip previamente" está fechada por três caminhos distintos.

---

## 2. O que MUDA: o termo de física do Flip Hunt está quebrado

O gate do Flip Hunt é `edge = pPhys − ask ≥ 0,05`, com `pPhys = Φ(z)`, `z = |dist|/(σ√τ)`.
Medindo `Φ(z)` contra o resultado real **na própria população de entradas do Flip Hunt**:

| `pPhys` | n | WR real | `pPhys` mediano | **viés** |
|---|---|---|---|---|
| 0,83–0,90 | 187 | 74,3% | 0,860 | **+11,7 pp** |
| 0,90–0,95 | 64 | 78,1% | 0,925 | **+14,4 pp** |
| 0,95–0,98 | 37 | 75,7% | 0,967 | **+21,0 pp** |
| 0,98–0,995 | 24 | 66,7% | 0,989 | **+32,2 pp** |
| ≥ 0,995 | 22 | **63,6%** | 0,999 | **+36,3 pp** |

Média: `pPhys` 0,769 vs WR real 0,661 — **superestima em 10,8 pontos percentuais**. E o viés
**cresce com a confiança**: onde o modelo browniano diz "99,9% certo", a realidade é 63,6%.

Isso é a mesma cauda gorda documentada no estudo anti-flip (`z ∈ [3,5)` com flip empírico de
6,0% contra 0,0% teórico), agravada aqui porque a população é **pós-cruzamento** — exatamente
onde há momentum que o browniano não modela.

### Pior: o gate de edge é anti-preditivo

| edge declarado | n | edge **realizado** | WR | ask médio |
|---|---|---|---|---|
| 0,05–0,08 | 344 | +0,041 | 70,4% | 0,663 |
| 0,08–0,12 | 258 | +0,040 | 67,8% | 0,638 |
| 0,12–0,20 | 273 | +0,061 | 67,8% | 0,617 |
| 0,20–0,40 | 211 | +0,071 | 64,0% | 0,569 |
| **0,40–1,00** | 60 | **−0,028** | **33,3%** | 0,361 |

```
corr(edge declarado, vitória) = −0,157   ← NEGATIVA
corr(ask, vitória)            = +0,272   ← positiva
corr(z, vitória)              = +0,071
```

**Mecanismo:** `edge = Φ(z) − ask` é dominado pelo termo `−ask`. Como o ask *prevê positivamente*
a vitória (o mercado está certo), exigir edge alto é o mesmo que exigir ask baixo, que seleciona
os **piores** trades. O `minEdge` funciona como um filtro disfarçado de "compre mais barato" — e
mais barato, aqui, é pior.

Isso explica de forma mecanicista o que o próprio refino de vocês já mostrava sem explicar: as
variantes com `minEdge = 0` performam de forma comparável às com `minEdge = 0,05`.

---

## 3. O que MUDA: fora da janela minerada, a estratégia quase desaparece

| Split | n | WR | PnL | exp/trade | **PF** | dias+ |
|---|---|---|---|---|---|---|
| **PRE — 23/04→27/05 (nunca minerado)** | 360 | 63,9% | **$21,0** | **+0,058** | **1,016** | 12/30 |
| train deles — 28/05→30/06 | 559 | 64,8% | $169,2 | +0,303 | 1,085 | 20/34 |
| holdout deles — 01/07→26/07 | 227 | 72,7% | $360,6 | +1,589 | 1,577 | 17/25 |

Na janela de 30 dias que o miner **nunca viu**, o `btc-tight-spread` entrega **PF 1,016** — ou
seja, empate. O desempenho forte está concentrado no período minerado.

Isso precisa ser lido junto com a escala da busca: **1.680 variantes testadas, 290
"sobreviventes estritos"** no miner principal e **10.027 sobreviventes** no refino H2. Com essa
carga de teste múltiplo, o holdout de 26 dias deixa de ser um teste limpo — ele participou da
seleção do campeão. A janela PRE é o único teste verdadeiramente cego, e nela o edge some.

**Ressalva de honestidade:** minha replicação não é o motor GLS. Ela dá holdout $360,6 contra
$459,0 do lab oficial e train $169,2 contra $287,8 — mais conservadora, mesma direção. A
comparação **entre splits** é internamente consistente (mesmo código, mesmos custos), que é o
que a conclusão exige.

---

## 4. O que ACRESCENTA: a saída anti-flip resgata o Flip Hunt

Aplicando as variantes de saída do estudo anti-flip aos trades do Flip Hunt (que hoje é
hold-to-settlement):

| saída | nExit | PnL | exp | PF | maxDD | pior dia | **PRE** | train | holdout |
|---|---|---|---|---|---|---|---|---|---|
| **`lead_bid40`** | 446 | **$956,7** | 0,835 | **1,333** | $90 | −$50,0 | **$194,7** | $374,9 | $387,0 |
| `lead_bid45` | 461 | $915,1 | 0,798 | 1,325 | $98 | −$50,0 | $172,6 | $368,7 | $373,8 |
| `lead` | 499 | $889,5 | 0,776 | 1,339 | $80 | −$47,1 | $171,7 | $353,2 | $364,6 |
| `hold` (atual) | — | $550,9 | 0,481 | 1,141 | $121 | −$64,8 | **$21,0** | $169,2 | $360,6 |

**PnL +74%, PF 1,141 → 1,333, maxDD −26%.** E o mais importante:

> Na janela nunca minerada, a saída leva o resultado de **$21 (PF 1,016) para $195** — de empate
> para positivo. O ganho da saída é **maior exatamente onde a estratégia base é mais fraca**.

Nas 446 posições em que `lead_bid40` disparou, a WR se tivesse segurado era de **19,3%**.
Antecedência mediana: **20,0 segundos**. Falsos alarmes custam −$1.022; acertos rendem +$1.428.

O motivo é estrutural e vale registrar: o Flip Hunt entra **logo após um cruzamento**, ou seja,
por construção opera em eventos com spot colado no strike e alta propensão a cruzar de novo.
É a população com **maior** risco de flip subsequente — e é a que mais se beneficia de uma saída
protetora. Hold-to-settlement é a escolha mais frágil possível para essa tese.

---

## 5. O que ACRESCENTA: os cortes de parâmetro estão nos lugares errados

| `ask` | n | WR | exp (hold) | exp (com saída) |
|---|---|---|---|---|
| 0,20–0,50 | 177 | **42,4%** | +0,494 | +1,242 |
| 0,50–0,60 | 273 | 62,3% | +0,989 | +1,395 |
| 0,60–0,70 | 361 | 67,9% | +0,095 | +0,394 |
| **0,70–0,78** | 293 | **77,8%** | +0,306 | +0,456 |

| `tau` | n | WR | exp (hold) | exp (com saída) |
|---|---|---|---|---|
| 10–20 | 168 | 67,9% | +0,968 | +1,512 |
| 20–30 | 224 | 65,6% | +0,593 | +0,940 |
| 30–40 | 243 | 68,3% | +0,809 | +1,315 |
| **40–50** | **448** | 65,2% | **+0,251** | +0,394 |

Duas correções sugeridas, ambas testáveis no lab GLS:

1. **`minAsk` 0,20 → ~0,50.** A faixa 0,20–0,50 tem WR de 42,4% e é 15% das entradas. É a região
   onde o `minEdge` alto está empurrando as entradas, e é a pior.
2. **`maxSecondsLeft` 50 → 40.** A faixa 40–50s é a **maior** (448 de 1.146 entradas) e a de pior
   expectância. Note que os campeões do próprio refino de vocês usam `t8-40`, não `t10-60`.

O teto `maxAsk = 0,78` também merece revisão: a faixa 0,70–0,78 tem a **melhor** WR (77,8%), o
que sugere que o corte está removendo a melhor região, não a pior — consistente com a tese
MIDAS de que favorito caro é subprecificado.

---

## 6. A síntese em si: a saída deve virar REVERSÃO

Se vender o líder velho é bom (Anti-Flip) e comprar o líder novo é bom (Flip Hunt H2), a saída
deveria virar uma **reversão** — uma única ação que fecha um lado e abre o outro. Testado no
harness anti-flip (entrada MIDAS-like τ=30s, 8.251 trades, entrada e saída com varredura depth 25):

| variante | nRev | PnL | exp | PF | maxDD | PRE | train | holdout |
|---|---|---|---|---|---|---|---|---|
| `rev_naive` (sem filtro no novo líder) | 1.417 | $3.156 | 0,382 | 1,250 | $81 | $1.057 | $910 | $1.189 |
| **`reverse ask<0,70`** | 517 | **$3.084** | **0,374** | **1,243** | **$77** | $1.045 | $915 | $1.124 |
| `exit_only` (só vende) | — | $2.548 | 0,309 | 1,193 | $84 | $885 | $658 | $1.005 |
| `rev_fh` (filtros do Flip Hunt) | **31** | $2.556 | 0,310 | 1,193 | $80 | $894 | $648 | $1.014 |

**A reversão acrescenta +$536 sobre a saída simples (+21%), positiva nos três splits**
(PRE +$160, train +$257, holdout +$119), em **73 de 91 dias**, e ainda **reduz** o maxDD de $84
para $77. Pior dia do delta: −$14,9.

### Por que os filtros do Flip Hunt destroem a reversão

`rev_fh` executa apenas **31 reversões de 1.553 gatilhos**. Motivo: no instante em que a saída
dispara, o ask do novo líder tem mediana **0,740** e **36,2%** estão acima do teto `maxAsk = 0,78`;
além disso `minDist ≥ 8` falha porque, logo após um cruzamento, o spot está colado no strike.
Os filtros do Flip Hunt foram calibrados para uma população diferente daquela em que a reversão
acontece.

### Onde está o dinheiro da reversão

| ask do novo líder | n | delta total | delta/trade |
|---|---|---|---|
| **0,60–0,70** | 517 | **+$536** | **+$1,037** |
| 0,70–0,80 | 379 | +$8 | +$0,021 |
| 0,80–0,90 | 289 | +$50 | +$0,173 |
| 0,90–0,95 | 173 | +$12 | +$0,069 |
| ≥ 0,95 | 59 | +$2 | +$0,028 |

**88% do valor da reversão está numa única faixa: ask 0,60–0,70.** Acima de 0,70 é ruído.

Isso é exatamente o mecanismo de atraso do book: quando nosso bid cai abaixo de 0,40, o lado
oposto já vale ~0,60+. Se o ask do novo líder ainda está em 0,60–0,70, **o book não terminou de
repreçar** — é aí que se compra barato. Acima de 0,78 o book já corrigiu e não há nada a extrair.

Preferir `ask < 0,70` ao `rev_naive`: quase o mesmo PnL ($3.084 vs $3.156) com **um terço das
execuções** (517 vs 1.417), expectância por reversão 2,4× maior (+$1,04 vs +$0,43) e maxDD menor.



| # | Ação | Base |
|---|---|---|
| 1 | **Adicionar saída `lead_bid40` ao FlipHuntV1.gls** (hoje é hold-to-settlement) | §4 — +74% PnL, +$174 na janela cega |
| 2 | **Transformar a saída em reversão com `ask_novo < 0,70`** (MIDAS e Flip Hunt) | §6 — +21% PnL, positiva nos 3 splits, maxDD menor |
| 3 | **Remover ou recalibrar o gate `minEdge`** — `Φ(z)` superestima 10,8 pp e o edge é anti-preditivo | §2 |
| 4 | **Subir `minAsk` para ~0,50 e baixar `maxSecondsLeft` para 40** | §5 |
| 5 | **Revalidar na janela 23/04→27/05** antes de qualquer promoção — é o único teste cego restante | §3 |
| 6 | Testar `maxAsk` acima de 0,78 | §5 |
| 7 | Não reabrir a linha "prever flip pré-entrada" | §1 |

**Ordem sugerida:** (1) e (2) primeiro — são o ganho maior e independem dos demais; depois
(3)+(4) juntos como um único experimento de sweep; e (5) como gate de promoção.

**Nota sobre a reversão vs. o `lateFlipReverse` da TFC/MIDAS:** a campeã já tem um mecanismo de
reverse late (8→4s). O que este estudo acrescenta é (a) o gatilho de confirmação dupla
(`lead` + `bid < 0,40`) em vez de janela fixa de tempo, com antecedência mediana de 13,5s em vez
de 4–8s, e (b) o corte `ask_novo < 0,70` na perna de reversão, que concentra 88% do valor.
Comparar as duas no mesmo harness antes de substituir.

## 7. Reprodução

```powershell
# replica entradas Flip Hunt + aplica saídas anti-flip, 91 dias (~35 min)
node --max-old-space-size=8192 labs/sandbox/anti-flip/merge-fliphunt-antiflip.mjs --out <path>/merge-fliphunt.csv
python labs/sandbox/anti-flip/analyze-merge.py   # ajustar CSV no topo do arquivo

# testa se a saída deveria virar reversão (vende velho + compra novo líder)
node --max-old-space-size=8192 labs/sandbox/anti-flip/reverse-test.mjs --out <path>/reverse-test.csv
```
