# HANDOFF — Estudo de flips terminais BTC 5m (GoldenLens)

> Documento autocontido para transferência de contexto a outro agente/IA.
> **Gerado:** 2026-07-27 · **Repo:** `D:\Projetos\projeto-goldenlens\data-backtest` (branch `main`)
> Tudo aqui é resultado empírico reproduzível; os scripts estão em `labs/sandbox/anti-flip/`.

> [!CAUTION]
> **Auditoria canônica posterior (2026-07-27):** as conclusões econômicas deste handoff
> usam winner local, filtro retrospectivo de consenso do book final e execução no mesmo
> snapshot. Consulte `reports/research/anti-flip-btc5m-canonical-2026-07-27.md` antes de
> reutilizar números. Correções principais: `pFlip>=0,40` foi positivo nos três splits
> (o −US$173 citado no §9 é o corte de 20%); `rev-070` perdeu −US$270 vs gold nos três
> sweeps e o teto 0,70 não superou reverter sem teto com significância; a reversão melhora
> exit-only somente no mesmo snapshot, perdendo segurança em 0,5 s e valor em ~1 s.
> A nova linha pré-entrada é `dMid15<=-0,05 AND z<=0,50 AND favAsk<=0,68`, ainda em pesquisa.

---

## 0. Contexto do domínio (leia primeiro)

O projeto opera mercados binários **Up/Down de 5 minutos** da Polymarket sobre BTC (e ETH/SOL/XRP/DOGE/HYPE).
Cada evento tem:

- `price_to_beat` (**PTB** ou *strike*): preço de referência fixado no início do evento.
- `underlying_price` (**spot**): preço do BTC, atualizado ~2×/s.
- Dois contratos, **UP** e **DOWN**, com book próprio (bid/ask, profundidade 25 níveis).
- Settlement: vence UP se `spot_final > PTB`, senão DOWN. O vencedor paga 1,0 por share.

**Vocabulário crítico:**

| Termo | Definição |
|---|---|
| **líder** / favorito físico | o lado que venceria se o evento terminasse agora (`spot > PTB` → UP) |
| **flip** | o líder em τ segundos do fim **não** é o vencedor final |
| **τ (tau)** | segundos restantes até o fim do evento |
| **dist** | `spot − PTB` (assinado) ou `\|spot − PTB\|` (absoluto) |
| **z** | colchão normalizado: `\|dist\| / (σ·√τ)`, σ = vol realizada em USD/√s |
| **favMid** | mid do book do lado favorito = probabilidade implícita pelo mercado |
| **PTB cross** | o spot cruza o strike, trocando quem é o líder |

**Custos honestos usados em todos os labs:** fee taker `0,07·p·(1−p)` por share, varredura de book
depth 25 (fill realista, não best-price), settle do vencedor a **0,995** (haircut), US$ 10/trade.

**Pergunta original do usuário:** detectar com antecedência os flips no fim do evento para não
entrar, sair antes, ou minimizar o prejuízo.

---

## 1. Conclusão executiva (o essencial em 6 linhas)

1. **Não existe alfa de previsão de flip pré-entrada.** O preço do book já é a previsão, e é bem
   calibrado. Confirmado por **três** métodos independentes. **Linha fechada — não reabrir.**
2. **O dinheiro está na saída/reversão dentro do trade**, disparada pelo **cruzamento físico do
   PTB confirmado pelo book**.
3. A regra vencedora: `signedDistance ≤ 0` **E** `bid_próprio < 0,40` → **reverter** para o
   lado oposto se `ask_novo < 0,70`, senão sair.
4. Regras baseadas **só no book** (choque de odds, colapso de bid) são **destrutivas**.
5. A estratégia `flip-hunt-v1` tem dois defeitos sérios (§6) e não deve ser promovida como está.
6. **A MIDAS gold já tem os levers e JÁ ESTAVAM BEM CALIBRADOS.** O sweep no motor GLS oficial
   **rejeitou** todas as 11 variantes propostas (§8.2). A janela `lateFlipExitSec = 8` já está
   sobre a faixa de maior valor. **Não reabrir esta linha.**
7. Achado colateral: a **MIDAS gold generaliza para a janela cega** (PF 1,570), ao contrário da
   `flip-hunt-v1` (PF 1,016). A saída anti-flip segue promissora **só para o Flip Hunt** (§8.3).

---

## 2. Dados e metodologia

**Fonte:** `lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=YYYY-MM-DD/*.parquet`
(Parquet particionado, lido via DuckDB `@duckdb/node-api`).

- **Janela:** 2026-04-23 → 2026-07-26 (**91 dias**), 23.829 eventos válidos, ~166 mil linhas de features.
- **Cadência:** ~2 ticks/s (≈600 ticks/evento); `coverage >= 0.9` exigido.
- **Schema relevante:** `event_start`, `event_end`, `ts`, `underlying_price`, `price_to_beat`,
  `up_best_bid/ask`, `down_best_bid/ask`, `up_bid_px_1..25`/`sz`, idem ask e DOWN, `coverage`.

**Validação de label (importante):** o vencedor é inferido por `spot > PTB` no último tick, mas
**só é aceito se concordar com o mid do book final** (média dos últimos 5s). Isso descarta eventos
com feed de spot congelado que geravam flips fictícios — problema já documentado no projeto
(ex.: 2026-05-29 12:52).

**Splits temporais usados:**

| Estudo | Splits |
|---|---|
| Anti-flip (§3–5) | train `< 2026-06-25` · holdout `≥ 2026-06-25` |
| Comparação com Flip Hunt (§6) | **PRE** `< 2026-05-28` (nunca minerado) · train `05-28→06-30` · holdout `07-01→07-26` |

**Ambiente:** Node 24 + `@duckdb/node-api`; Python 3.13 com **apenas pandas e numpy**
(sem scipy/sklearn — regressão logística implementada à mão com Newton-Raphson; Φ via `math.erf`).

---

## 3. Taxa-base e calibração do modelo de difusão

Probabilidade de flip por antecedência (91 dias):

| τ | 120s | 90s | 60s | 45s | 30s | 20s | 10s |
|---|---|---|---|---|---|---|---|
| flip | 22,0% | 18,6% | 15,6% | 13,6% | **11,1%** | **9,1%** | **6,9%** |

**O modelo browniano é mal calibrado e o erro é assimétrico** (τ=30s):

| z | [0; 0,25) | [0,5; 0,75) | [1; 1,5) | [2; 3) | [3; 5) | ≥5 |
|---|---|---|---|---|---|---|
| flip **empírico** | 46,1% | 28,3% | 18,3% | **10,7%** | **6,0%** | **3,2%** |
| flip **browniano** | 50,0% | 49,3% | 21,4% | 1,7% | 0,0% | 0,0% |

**Leitura:** existe um regime de **salto** que a difusão não modela. Onde o browniano diz
"impossível" (z≥3), a realidade é 3–6%. Isso é a causa-raiz do defeito da `flip-hunt-v1` (§6).

> **Regra para quem continuar:** nunca usar `Φ(z)` como probabilidade calibrada perto do strike.
> Usar a tabela empírica acima ou recalibrar na população específica.

---

## 4. FINDING 1 — Não há alfa de previsão pré-entrada

### 4.1 O preço domina qualquer feature

AUC no holdout para prever flip:

| τ | modelo completo (6 features) | só `favMid` | só `z` |
|---|---|---|---|
| 60s | 0,851 | **0,852** | 0,755 |
| 30s | 0,909 | **0,911** | 0,774 |
| 10s | 0,956 | **0,962** | 0,752 |

Features testadas no modelo: `z`, momentum normalizado por vol (10s e 30s), contagem de
cruzamentos em 60s, idade do último cruzamento, `dMid15` (repricing do book em 15s), `favMid`.
**Nenhuma bate o preço sozinho.**

### 4.2 Informação residual dentro de faixa de preço ≈ zero

| faixa `favMid` | n (holdout) | AUC microestrutura (sem preço) |
|---|---|---|
| 0,55–0,70 | 571 | 0,526 |
| 0,70–0,80 | 576 | **0,505** |
| 0,80–0,90 | 911 | **0,493** |
| 0,90–0,95 | 871 | 0,534 |

Condicionado ao preço, a microestrutura não sabe nada. **Este é o resultado mais conclusivo do estudo.**

### 4.3 Convergência tripla (três métodos independentes)

| Método | Evidência | Onde |
|---|---|---|
| Miner Flip Hunt, tese H1 (`fake_leader_dog` = comprar o azarão *antes* do flip) | train exp **−0,487**, PF 0,906 | `scratch/flip-hunt-results.json` |
| Este estudo (AUC residual) | **AUC ≈ 0,50** dentro de faixa de preço | §4.2 |
| Relatório canônico (contrafactual de não-entrada) | bloquear a 20% de risco: **ΔPnL −$173**; a 30%: **−$194** | `scratch/flip-model-canonical-report.md` |

O relatório canônico (pré-existente, feito por outro agente) mede `market_raw` AUC 0,899 a 30s
contra `combined` 0,898 — mesma conclusão que §4.1 com metodologia diferente.

### 4.4 O que sobra de útil pré-entrada: leitura de nível, não previsão

Flip real vs implícito pelo mercado (τ=30s) — **o real fica sempre abaixo do implícito**:

| `favMid` | 0,5–0,6 | 0,6–0,7 | 0,7–0,8 | 0,8–0,9 | 0,9–0,95 | ≥0,95 |
|---|---|---|---|---|---|---|
| flip real | 41,0% | 30,8% | 19,8% | **12,2%** | 5,3% | **0,9%** |
| implícito | 45,0% | 35,0% | 25,0% | 15,0% | 7,5% | 2,0% |

Esse gap **é** a tese que TFC/MIDAS já explora (favorito subprecificado). `favMid ≥ 0,95` em τ=30s
tem flip de 0,9% — gate de risco barato, mas não é previsão.

---

## 5. FINDING 2 — A saída/reversão é onde está o dinheiro

### 5.1 Simulação tick-a-tick

Harness: entrada no favorito em **τ=30s** (ask 0,50–0,94, US$ 10 taker), monitoramento a **cada
tick**, saída taker no bid do lado próprio, settle 0,995. **8.252 trades / 91 dias.**

| variante | regra | saídas | PnL | exp | PF | maxDD | pior dia | dias+ |
|---|---|---|---|---|---|---|---|---|
| **`lead_bid40`** | perdeu liderança **E** bid < 0,40 | 18,8% | **$2.728** | 0,331 | 1,207 | **$79** | −$67 | 67 |
| `lead_bid45` | idem, bid < 0,45 | 19,5% | $2.703 | 0,328 | 1,208 | $73 | −$73 | 69 |
| `lead` | só perdeu liderança | 22,2% | $2.426 | 0,294 | 1,195 | $113 | −$81 | 64 |
| **`hold`** | segura até settlement (baseline) | — | **$1.213** | 0,147 | 1,077 | **$207** | −$147 | 55 |
| `bid45` | **só book**: bid < 0,45 | 30,4% | **−$343** | −0,042 | 0,974 | $2.272 | −$604 | 56 |
| `bid35` | **só book**: bid < 0,35 | 26,6% | −$451 | −0,055 | 0,969 | $2.386 | −$653 | 57 |
| `shock` | **só book**: mid cai 0,15 em 2s | 43,7% | **−$1.756** | −0,213 | 0,857 | $2.149 | −$446 | 42 |

**`lead_bid40` vs `hold`: PnL +125%, maxDD −62%.** Positivo em train (+$1.640) e holdout (+$1.088),
delta positivo em **71 de 91 dias**.

### 5.2 A confirmação dupla é obrigatória (resultado negativo importante)

As variantes **só-book** são catastróficas — disparam em repricing transitório e vendem o fundo de
whipsaws. Isso **reproduz de forma independente** a rejeição do `earlyWarnEnabled` já documentada
em `docs/estrategias/implementadas/midas-carry-v1.md` (−US$ 530 a −US$ 620).

> **O sinal só funciona quando o spot efetivamente cruza o strike (evento físico) E o book confirma.**
> Nenhum dos dois sozinho presta.

Eficiência de `lead_bid45`: nas 1.607 posições em que disparou, a WR se tivesse segurado era de
apenas **16,6%**. Falsos alarmes custam −$2.737; acertos rendem +$4.227.

**Antecedência:** mediana **13,5s** (p25 6s, p75 21s); 62% dos sinais com >10s de sobra.

### 5.3 A saída deve virar REVERSÃO

Testado no mesmo harness (8.251 trades), com entrada e saída varrendo depth 25:

| variante | nRev | PnL | exp | PF | maxDD | PRE | train | holdout |
|---|---|---|---|---|---|---|---|---|
| `rev_naive` (sem filtro) | 1.417 | $3.156 | 0,382 | 1,250 | $81 | $1.057 | $910 | $1.189 |
| **`reverse ask<0,70`** | 517 | **$3.084** | 0,374 | 1,243 | **$77** | $1.045 | $915 | $1.124 |
| `exit_only` | — | $2.548 | 0,309 | 1,193 | $84 | $885 | $658 | $1.005 |
| `rev_fh` (filtros Flip Hunt) | **31** | $2.556 | 0,310 | 1,193 | $80 | $894 | $648 | $1.014 |

**+$536 sobre a saída simples (+21%)**, positiva nos três splits, **73 de 91 dias**, e o maxDD
**melhora** ($84 → $77).

**88% do valor da reversão está numa única faixa de `ask` do novo líder:**

| ask novo líder | 0,60–0,70 | 0,70–0,80 | 0,80–0,90 | 0,90–0,95 | ≥0,95 |
|---|---|---|---|---|---|
| n | 517 | 379 | 289 | 173 | 59 |
| delta total | **+$536** | +$8 | +$50 | +$12 | +$2 |
| delta/trade | **+$1,037** | +0,021 | +0,173 | +0,069 | +0,028 |

**Mecanismo:** quando nosso bid cai abaixo de 0,40, o lado oposto já vale ~0,60+. Se o ask do novo
líder **ainda** está em 0,60–0,70, o book **não terminou de repreçar** — é aí que se compra barato.
Acima de 0,78 o book já corrigiu e não sobra nada.

Varredura do teto: `<0,65` +$311,8 (exp +1,086) · `<0,68` +$504,7 (+1,137) · **`<0,70` +$536,3
(+1,037)** · `<0,72` +$559,9 (+0,921) · `<0,80` +$544,2 (+0,607). Preferir 0,70 a `naive`: quase o
mesmo PnL com **1/3 das execuções** e expectância 2,4× maior.

### 5.4 Realismo de execução — verificado, não assumido

A doc do projeto registra que "book fino aos 3–8s" matava saídas FAK. Varredura do book bid depth
25 no **instante exato** de cada saída (n = 1.607):

- Profundidade mediana **6.304 shares** vs **14,5** necessários (p95 19,2)
- **99,1%** preenchem 100%; 15 casos parciais
- Slippage mediano vs best bid: **0,0000** (p90 0,0094)
- Custo total do realismo: **−$36 sobre −$10.941 = −0,3%**
- Liquidez **não** colapsa no fim: faixa 2–5s ainda tem mediana 4.954 shares

---

## 6. FINDING 3 — Crítica à estratégia `flip-hunt-v1`

`flip-hunt-v1` é uma estratégia candidata (não promovida) criada por outro agente na mesma sessão.
Tese H2 `post_cross_lead`: após o spot cruzar o PTB, o book atrasa → compra o **novo líder**.

**Regra do preset `btc-tight-spread`:**
```
ptbFlipCount(15s) ≥ 1  AND  10 ≤ τ ≤ 50  AND  |spot−PTB| ≥ 8
AND 0,20 ≤ ask_fav ≤ 0,78  AND  spread ≤ 0,02  AND  0,96 ≤ oddsSum ≤ 1,08
AND  Φ(|dist|/(σ√τ)) − ask ≥ 0,05          ← "edge"
→ buy fav, HOLD TO SETTLEMENT, $10
```
Números oficiais do lab GLS: train +$287,8 (n=559) · holdout **+$459,0** (n=238, PF 1,74, WR 72,7%).

### 6.1 Insight estrutural: Flip Hunt e Anti-Flip são o mesmo fenômeno

| | Anti-Flip (§5) | Flip Hunt H2 |
|---|---|---|
| Momento | spot cruza o PTB | spot cruza o PTB |
| Ação | **vende** o líder velho | **compra** o líder novo |
| Fonte do ganho | bid ainda não colapsou | ask ainda não subiu |

Ambos exploram **o atraso do book em relação ao cruzamento físico**. Não são estratégias distintas.

### 6.2 DEFEITO 1 — O termo de física está quebrado e o gate é anti-preditivo

Medindo `Φ(z)` contra o resultado real **na própria população de entradas do Flip Hunt** (n=1.146):

| `pPhys` = Φ(z) | n | WR real | **viés** |
|---|---|---|---|
| 0,83–0,90 | 187 | 74,3% | +11,7 pp |
| 0,90–0,95 | 64 | 78,1% | +14,4 pp |
| 0,95–0,98 | 37 | 75,7% | +21,0 pp |
| 0,98–0,995 | 24 | 66,7% | +32,2 pp |
| ≥ 0,995 | 22 | **63,6%** | **+36,3 pp** |

Média: `pPhys` 0,769 vs WR real 0,661 → **superestima em 10,8 pp**, e **o viés cresce com a
confiança**. É a cauda gorda de §3, agravada porque a população é pós-cruzamento (há momentum).

**O gate de edge é anti-preditivo:**

```
corr(edge declarado, vitória) = −0,157   ← NEGATIVA
corr(ask, vitória)            = +0,272   ← positiva
corr(z, vitória)              = +0,071
```

| edge declarado | n | edge **realizado** | WR | ask médio |
|---|---|---|---|---|
| 0,05–0,08 | 344 | +0,041 | 70,4% | 0,663 |
| 0,12–0,20 | 273 | +0,061 | 67,8% | 0,617 |
| **0,40–1,00** | 60 | **−0,028** | **33,3%** | 0,361 |

**Mecanismo:** `edge = Φ(z) − ask` é dominado pelo termo `−ask`. Como o ask *prevê positivamente*
a vitória, exigir edge alto ≡ exigir ask baixo ≡ selecionar os **piores** trades. O `minEdge` é um
"compre mais barato" disfarçado — e mais barato, aqui, é pior. Isso explica mecanicamente por que
o refino do próprio miner mostra `minEdge=0` performando igual a `minEdge=0,05`.

### 6.3 DEFEITO 2 — Fora da janela minerada, o edge desaparece

Replicação independente sobre o parquet cru, 91 dias, mesmos custos:

| Split | n | WR | PnL | exp | **PF** | dias+ |
|---|---|---|---|---|---|---|
| **PRE — 23/04→27/05 (nunca minerado)** | 360 | 63,9% | **$21,0** | +0,058 | **1,016** | 12/30 |
| train deles — 28/05→30/06 | 559 | 64,8% | $169,2 | +0,303 | 1,085 | 20/34 |
| holdout deles — 01/07→26/07 | 227 | 72,7% | $360,6 | +1,589 | 1,577 | 17/25 |

Na janela que o miner **nunca viu**, o resultado é **empate (PF 1,016)**.

Contexto de teste múltiplo: o miner testou **1.680 variantes com 290 "sobreviventes estritos"**, e
o refino H2 reporta **10.027 sobreviventes**. Com essa carga de busca, o holdout de 26 dias
participou da seleção do campeão — não é teste cego. **A janela PRE é o único teste limpo restante.**

> **Ressalva de honestidade:** a replicação não é o motor GLS oficial. Ela dá holdout $360,6 contra
> $459,0 do lab e train $169,2 contra $287,8 — mais conservadora, mesma direção. A comparação
> **entre splits** usa o mesmo código e custos, que é o que a conclusão exige.

### 6.4 A saída anti-flip resgata o Flip Hunt

| saída | PnL | exp | PF | maxDD | **PRE (cego)** | train | holdout |
|---|---|---|---|---|---|---|---|
| **`lead_bid40`** | **$956,7** | 0,835 | **1,333** | $90 | **$194,7** | $374,9 | $387,0 |
| `lead_bid45` | $915,1 | 0,798 | 1,325 | $98 | $172,6 | $368,7 | $373,8 |
| `hold` (atual) | $550,9 | 0,481 | 1,141 | $121 | **$21,0** | $169,2 | $360,6 |

**PnL +74%**, e na janela cega vai de **$21 (empate) para $195**. O ganho é maior exatamente onde a
base é mais fraca.

**Razão estrutural:** o Flip Hunt entra logo após um cruzamento, ou seja, por construção opera em
eventos com spot colado no strike e alta propensão a cruzar de novo. É a população com **maior**
risco de flip subsequente — hold-to-settlement é a escolha mais frágil possível para essa tese.

### 6.5 Os filtros do Flip Hunt bloqueiam a reversão

`rev_fh` executa **31 reversões em 1.553 gatilhos**. No instante da saída, o ask do novo líder tem
mediana **0,740** e **36,2%** estão acima do teto `maxAsk = 0,78`; além disso `minDist ≥ 8` falha
porque logo após um cruzamento o spot está colado no strike. **Os filtros foram calibrados para
uma população diferente daquela em que a reversão acontece.**

### 6.6 Atribuição dos filtros (onde os cortes estão errados)

| `ask` | n | WR | exp (hold) |
|---|---|---|---|
| 0,20–0,50 | 177 | **42,4%** | +0,494 |
| 0,50–0,60 | 273 | 62,3% | +0,989 |
| 0,60–0,70 | 361 | 67,9% | +0,095 |
| **0,70–0,78** | 293 | **77,8%** | +0,306 |

| `τ` | n | WR | exp (hold) |
|---|---|---|---|
| 10–20 | 168 | 67,9% | +0,968 |
| 30–40 | 243 | 68,3% | +0,809 |
| **40–50** | **448** | 65,2% | **+0,251** |

Sugestões: `minAsk` 0,20 → **~0,50** (a faixa baixa tem WR 42%); `maxSecondsLeft` 50 → **40** (a
faixa 40–50 é a maior e a pior); testar `maxAsk` **acima** de 0,78 (a melhor faixa está no teto).

---

## 7. FINDING 4 — A MIDAS gold já tem os levers, mal calibrados

`midas-carry-v1` preset **`btc-gold-v1`** (Studio v11) é a campeã de produção BTC.
Arquivos: `labs/strategies/terminal/midas-carry-v1/{strategy.gls,defaults.json,presets/btc-gold-v1.json}`.

**Mecanismo `lateFlip` existente** (`strategy.gls` ~linha 435):
```
secsLeft <= lateFlipExitSec(8)  AND  secsLeft >= lateFlipMinSec(4)
AND state.signedDistance <= lateFlipExitCrossDist(0)   ← JÁ É a condição "lead"
AND bid >= stopMinBid(0.05)
  → se lateFlipReverseEnabled(true) E oppAsk <= lateFlipReverseMaxAsk(0.95): reverse()
  → senão: exit()
```

`signedDistance` é assinado **relativo ao nosso lado** (positivo = ganhando), logo `<= 0` é
exatamente a condição `lead` de §5.

**Diagnóstico — o que falta:**

| # | Problema | Param | Atual | Proposto | Base |
|---|---|---|---|---|---|
| 1 | Janela só τ∈[4,8]s; o gatilho tem antecedência mediana **13,5s** → perde a maioria dos disparos | `lateFlipExitSec` | 8 | 15/20/30 | §5.2 |
| 2 | Sem confirmação de book (só piso `bid≥0,05`) | `lateFlipExitMaxBid` | — (**novo**) | 0,40 | §5.1 |
| 3 | Teto da reversão solto; 88% do valor está abaixo de 0,70 | `lateFlipReverseMaxAsk` | 0,95 | 0,70 | §5.3 |

**Mecanismos relacionados já existentes (não confundir):**
- `cushionDecay*` — saída com janela alargada e `signedDistance <= 0`, mas com condição de bid
  **invertida** (piso `bid ≥ entry·0,55`, não teto) e **sem reversão**. Está `false` no gold.
- `earlyWarn*`, `bookCollapse*` — puramente book, **rejeitados** (coerente com §5.2). Manter off.
- `oddsShock*` — ligado no gold (Δ0,15/2s, vende 50%). É um "só-book" que sobreviveu porque é
  **parcial** e tem `oddsShockMinBidRatio 0,55`. Não mexer sem lab próprio.

---

## 8. Estado da implementação

### 8.1 Já feito (commitável)

| Arquivo | Mudança |
|---|---|
| `labs/strategies/terminal/midas-carry-v1/strategy.gls` | **+1 param** `lateFlipExitMaxBid = 1.0` (no-op) e **+1 condição** `&& bid < params.lateFlipExitMaxBid` na linha do `lateFlip` |
| `.../midas-carry-v1/defaults.json` | `"lateFlipExitMaxBid": 1.0` — no-op, preserva todos os presets |
| `.../midas-carry-v1/experiments/antiflip-levers-{july,june,blind}.json` | sweep de 12 variantes gerado a partir do preset gold |
| `.../midas-carry-v1/experiments/antiflip-smoke.json` | smoke de 3 variantes × 3 dias |
| `labs/sandbox/anti-flip/*` | 8 scripts + 3 documentos (este, `README.md`, `SINTESE-fliphunt-antiflip.md`) |

**Smoke validado** (20–22/07, 3 variantes): compila, e as **230 entradas são idênticas** nas três
variantes — confirma que só a saída mudou (paridade de entrada preservada).

**Nenhum preset foi alterado.** `btc-gold-v1` continua idêntico.

### 8.2 RESULTADO DO SWEEP — hipótese REJEITADA na MIDAS

Sweep concluído: 3 janelas × 12 variantes no motor GLS oficial (`compiled-soa`, depth 25).
Relatórios em `reports/labs/midas-carry-v1/2026-07-27T0{6-50,7-13,7-45}*-antiflip-levers-*`.
Comparador: `python labs/sandbox/anti-flip/compare-midas-levers.py`

**O `gold-baseline` vence nas três janelas. Todas as 11 variantes perdem.**

| variante | PnL julho | PnL junho | PnL cego | **PnL total** | **Δ vs baseline** |
|---|---|---|---|---|---|
| **`gold-baseline`** | **1.933,6** | **2.214,6** | 3.075,6 | **7.223,8** | — |
| `rev-078` | 1.899,0 | 2.095,9 | **3.088,2** | 7.083,1 | −140,7 |
| `rev-070` | 1.854,3 | 2.037,4 | 3.062,1 | 6.953,8 | −270,0 |
| `lf-sec15` | 1.835,2 | 2.074,1 | 2.071,8 | 5.981,1 | −1.242,7 |
| `lf-sec20` | 1.922,7 | 1.907,0 | 2.050,0 | 5.879,7 | −1.344,1 |
| `lf-sec30` | 1.867,4 | 1.775,3 | 1.995,4 | 5.638,1 | −1.585,7 |
| `w20-bid40` | 1.682,0 | 1.979,6 | 1.515,8 | 5.177,4 | −2.046,4 |
| `lf-bid45` | 1.527,7 | 2.117,7 | 1.473,5 | 5.118,9 | −2.104,9 |
| `lf-bid40` | 1.516,4 | 2.094,6 | 1.342,5 | 4.953,5 | −2.270,3 |
| `full-w20-bid40-rev070` | 1.550,0 | 1.878,1 | 1.404,8 | 4.832,9 | **−2.390,9** |

Entradas idênticas em todas as variantes (2.126 jul / 2.634 jun / 3.193 cego) — a diferença é
**só** de saída, como o smoke já garantia.

#### Por que não transferiu — mecanismo

O achado do §5 era real **no seu próprio harness**, mas o harness tem entrada simplificada
(favorito em τ=30s fixo) enquanto a MIDAS entra em τ∈[9,30] com `tierMinZ 2.0`, e já tem
`oddsShock` (parcial 50%) e `dangerExit` ativos **antes** do bloco `lateFlip`.

A explicação está nos **meus próprios dados**. Decompondo o ganho de sair por τ no momento do
disparo (harness anti-flip, regra `lead`):

| τ no disparo | n | WR se segurasse | ganho de sair **por trade** |
|---|---|---|---|
| **4–8s** | 456 | 0,09 | **+$1,21** |
| 8–15s | 389 | 0,23 | +$0,97 |
| 15–25s | 672 | 0,34 | +$0,27 |
| 25–30s | 268 | 0,42 | +$0,08 |

**O valor de sair está concentrado em 4–8s e decai para quase zero aos 25–30s.** A janela
`lateFlipExitSec = 8` da MIDAS **já está exatamente sobre a faixa de maior valor**. Alargá-la só
adiciona faixas fracas, onde o cruzamento frequentemente reverte (WR 0,34–0,42 se segurar) —
daí `lf-sec15/20/30` perderem de −$1.243 a −$1.586.

O teto `bid < 0,40` bloqueia saídas cujo bid ainda está alto. No harness isso ajuda (essas
posições recuperam, WR 0,77–0,96), mas na MIDAS o `oddsShock` e o `dangerExit` já retiraram os
casos fáceis antes do `lateFlip`, então o resíduo que chega ao gatilho se comporta de forma
diferente e segurá-lo custa caro. **A calibração da MIDAS já era a certa para a população dela.**

#### Achado positivo colateral (importante)

**A MIDAS gold generaliza bem para a janela cega**: PF **1,570** em 23/04→27/05 contra 1,577 em
julho e 1,534 em junho, com PnL $3.075,6 em 35 dias. Consistência notável — e contraste direto
com a `flip-hunt-v1`, que na mesma janela cega dá **PF 1,016** (§6.3). Evidência independente de
que a MIDAS gold é genuinamente robusta, não artefato de calibração.

#### Estado do código após a rejeição

O param `lateFlipExitMaxBid` foi **mantido com default 1.0 (no-op)**, seguindo a convenção já
adotada no projeto de preservar mecanismos rejeitados como params desativados no GLS (ver a
tabela "Mecanismos testados e rejeitados" em `docs/estrategias/implementadas/midas-carry-v1.md`).
**Nenhum preset foi alterado; `btc-gold-v1` v11 segue idêntico.**

### 8.3 Próximos passos, em ordem

1. ~~Portar os levers para a MIDAS~~ — **feito e rejeitado** (§8.2). Não reabrir sem hipótese
   nova sobre *por que* a população difere.
2. **Flip Hunt** — aqui a saída **não** foi testada no motor GLS e continua promissora, porque a
   população dele é o oposto da MIDAS: entra logo após um cruzamento, com spot colado no strike.
   §6.4 mostra +74% no harness e +$174 na janela cega. Adicionar a saída ao `FlipHuntV1.gls`,
   remover/recalibrar `minEdge`, subir `minAsk`→0,50, baixar `maxSecondsLeft`→40.
3. **Gate de promoção do Flip Hunt:** revalidar em 23/04→27/05, onde hoje dá PF 1,016.
4. Se testar a reversão de novo, fazê-lo **na população pós-cross** (Flip Hunt), não na MIDAS.

---

## 9. Hipóteses testadas e REJEITADAS (não repetir)

| Hipótese | Resultado |
|---|---|
| Modelo logístico multi-feature prevê flip melhor que o preço | Não — AUC igual ao `favMid` sozinho (§4.1) |
| Microestrutura tem sinal residual dentro da faixa de preço | Não — AUC ≈ 0,50 (§4.2) |
| Momentum contra o líder prevê flip | Marginal; some ao condicionar no preço |
| Contagem de cruzamentos (`cross60`) prevê flip | Não — 26,4% (0 cruz.) vs 29,9% (5 cruz.) |
| Idade do último cruzamento | Não — sem monotonicidade |
| Feed stale (`staleSecs`) como precursor | Não — sem sinal, n insuficiente |
| Hora do dia / slot de 5 min | Fraco — 7,8% (14h UTC) a 13,9% (01h UTC); não acionável |
| Gate pré-entrada por `pFlip` do modelo | Inconsistente train↔holdout; contrafactual canônico dá ΔPnL −$173 |
| Saída por choque de odds **sem** confirmação de spot | **Destrutivo** (−$1.756, maxDD $2.149) |
| Saída por colapso de bid **sem** confirmação de spot | **Destrutivo** (−$343 a −$451, maxDD >$2.200) |
| Comprar o azarão antes do flip (Flip Hunt H1) | train exp −0,487, PF 0,906 |
| Momentum atravessando a barreira (Flip Hunt H4) | train −0,508, holdout −0,895 |
| Re-ranking por edge empírico calibrado | Melhora exp/trade mas **reduz PnL total** — não é ganho claro |
| **Alargar `lateFlipExitSec` da MIDAS (8→15/20/30)** | **Rejeitado no GLS: −$1.243 a −$1.586 nas 3 janelas.** A janela de 8s já cobre a faixa de maior valor (§8.2) |
| **Teto `lateFlipExitMaxBid` (bid<0,40/0,45) na MIDAS** | **Rejeitado no GLS: −$2.105 a −$2.270.** Param mantido no-op |
| **Baixar `lateFlipReverseMaxAsk` da MIDAS (0,95→0,70/0,78)** | **Rejeitado: −$141 a −$270.** Quase neutro, mas nunca positivo |
| Qualquer combinação dos três levers acima | **Pior de todas: −$2.391** |

---

## 10. Limitações conhecidas (ler antes de confiar demais)

1. **O harness anti-flip usa entrada simplificada** (favorito em τ=30s fixo), não os gates reais da
   MIDAS (tier high-ask, `tierMinZ`, velocity guard, OBI, `minSecondsLeft 9`). Por isso o sweep de
   §8.2 existe: os ganhos **precisam** ser reconfirmados no motor oficial.
2. **Sem modelo de latência.** As saídas assumem decisão e execução no mesmo tick. Em produção há
   latência de rede/decisão; com antecedência mediana de 13,5s há folga, mas isso não foi medido.
3. **Não modela impacto de mercado.** A varredura de depth 25 assume o book estático no instante.
   Em US$ 10/trade isso é seguro (14,5 shares vs 6.304 de profundidade), mas não escala linearmente.
4. **A replicação do Flip Hunt não é o motor GLS** — ver ressalva em §6.3.
5. **Um único ativo (BTC) e 91 dias.** Nada foi testado em ETH/SOL/XRP. O projeto tem dados de
   ETH e XRP no lake; SOL/DOGE/HYPE têm presets mas não verifiquei cobertura de parquet.
6. **Regime único.** A janela 04/2026–07/2026 pode não conter todos os regimes de volatilidade.
7. `settleWinnerPrice 0,995` é um haircut adotado pelo projeto; o settle real é 1,0 com risco de
   execução/uptime — ver memória `midas-honest-exec-v2`.

---

## 11. Reprodução

```powershell
# 1. Cubo de features por evento × checkpoint (~166k linhas, ~2 min)
node labs/sandbox/anti-flip/extract-flip-features.mjs --out <path>/flip-features.csv
python labs/sandbox/anti-flip/analyze-flips-1-calibration.py   # calibração, AUC
python labs/sandbox/anti-flip/analyze-flips-2-residual.py      # poder residual + robustez

# 2. Simulação tick-a-tick das 11 variantes de saída (~15 min)
node labs/sandbox/anti-flip/tick-level-exit.mjs --out <path>/tick-exit.csv
python labs/sandbox/anti-flip/analyze-flips-3-tick-exit.py

# 3. Liquidez real no bid no instante da saída (~35 min, lê 200 colunas)
node --max-old-space-size=8192 labs/sandbox/anti-flip/exit-liquidity-check.mjs --out <path>/exit-liq.csv

# 4. Merge Flip Hunt × Anti-Flip (~35 min)
node --max-old-space-size=8192 labs/sandbox/anti-flip/merge-fliphunt-antiflip.mjs --out <path>/merge-fliphunt.csv
python labs/sandbox/anti-flip/analyze-merge.py

# 5. Teste de reversão (~40 min)
node --max-old-space-size=8192 labs/sandbox/anti-flip/reverse-test.mjs --out <path>/reverse-test.csv

# 6. Sweep dos levers na MIDAS (motor GLS oficial, ~25 min/janela)
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/antiflip-levers-july.json
python labs/sandbox/anti-flip/compare-midas-levers.py
```

Os scripts Python têm o caminho do CSV **hardcoded no topo** — ajustar antes de rodar.

---

## 12. Índice de artefatos

**Criados neste estudo** (`labs/sandbox/anti-flip/`):

| Arquivo | Função |
|---|---|
| `HANDOFF-completo.md` | **este documento** |
| `README.md` | estudo anti-flip base (§3–5) |
| `SINTESE-fliphunt-antiflip.md` | cruzamento com Flip Hunt (§6) |
| `extract-flip-features.mjs` | cubo de features por evento × checkpoint |
| `tick-level-exit.mjs` | simulação tick-a-tick de 11 variantes de saída |
| `exit-liquidity-check.mjs` | varredura de book no instante da saída |
| `merge-fliphunt-antiflip.mjs` | replica entradas Flip Hunt + aplica saídas anti-flip |
| `reverse-test.mjs` | testa saída-vs-reversão com 5 filtros |
| `analyze-flips-{1,2,3}*.py`, `analyze-merge.py` | análises |
| `compare-midas-levers.py` | comparador do sweep GLS |

**Pré-existentes, relevantes:**

| Arquivo | Conteúdo |
|---|---|
| `scratch/flip-model-canonical-report.md` | estudo canônico de flips (AUC, contrafactual) — **confirma §4** |
| `scratch/flip-hunt-results.json` · `flip-hunt-h2-refine.json` | artefatos do miner (teses H1–H4) |
| `labs/strategies/terminal/flip-hunt-v1/` | lab da estratégia candidata |
| `src/backtestStudio/gls/strategies/FlipHuntV1.gls` | fonte GLS do Flip Hunt |
| `reports/labs/flip-hunt-v1/` | relatórios train/holdout oficiais |
| `docs/estrategias/implementadas/midas-carry-v1.md` | doc da campeã (registra `earlyWarn` rejeitado) |
| `docs/analise-quantitativa/catalogo-anomalias.md` | catálogo ANOM-01..39 |

**Memória do projeto:** `anti-flip-exit-lead-bid.md` (índice em `MEMORY.md`).

---

## 13. Resumo em uma frase

> Não se antecipa o flip — o preço já é a previsão. O **cruzamento físico do PTB confirmado pelo
> book** é um gatilho de saída/reversão robusto e executável, que mais que dobra o PnL num harness
> de entrada simplificada; mas ao ser testado no motor oficial **a MIDAS gold já o implementava
> melhor do que a proposta**, e o ganho não transferiu. O alvo restante é a `flip-hunt-v1`, cuja
> população pós-cross é o oposto da MIDAS e que hoje segura até o settlement.
