# Auditoria de realismo — Escada Dupla V1

Data: **2026-07-25**
Estratégia: `escada-dupla-v1` (family `carry`, library-runner, promovida ao Studio em 2026-07-25)
Mercado: Polymarket BTC Up/Down 5 minutos
Objetivo: responder se o edge do campeão sobrevive à execução real e definir o caminho de validação antes de qualquer teste no `data-robot`.
Público: pesquisadores, revisores quantitativos e outras IAs.

> Este documento separa **fatos medidos**, **inferências** e **hipóteses**. Inclui duas sondas empíricas novas sobre o lake (`scratch/escada-dupla-book-depth-probe.js` e `scratch/escada-dupla-gap-probe.js`), reproduzíveis com os comandos da seção 11.

---

## 1. Resumo executivo

**Veredito: o PnL do campeão atual (+US$ 38,8k em 22 dias, PF 1,87) é, com alta probabilidade, artefato de execução — não edge real.**

Evidência central, em três peças:

1. **O modo de execução honesto perde dinheiro.** Com hedge `resting_maker` (fill só por atravessamento) e taker pagando o book real (`takerPriceMode=walk`), a mesma estratégia produz **−US$ 8.540, PF 0,86, 1/22 dias positivos** (lab09, variante `resting-walk-slip0`). O sinal do PnL flipa inteiramente com a hipótese de execução, em **todas** as escalas de sizing (budget-micro: sizeScale 0,25/0,5/1,0 → otimista sempre positivo, honesto sempre negativo).
2. **A diferença não é profundidade de book — é preço fantasma no disparo.** Sonda empírica no lake de julho mostra que o book é *profundo* (best ask mediano com 214 shares; 30 shares custam ≤ best+1¢ em 98% dos ticks). O rombo vem de outro lugar: quando o ask **cruza** um nível SUB, o ask real já está em média **1,9¢ acima do nível** (p90 = 5¢, p99 = 16¢). Os modos `formula`/`capped` preenchem ao preço do nível (+0,5–2,5¢), ou seja, a preços que **não existem mais no book** — e isso se concentra exatamente nos eventos de momentum, onde a escada mais compra.
3. **O "mais realista dá mais lucro" do lab10 é ilusão de RNG.** Reduzir `makerFillProb` *aumenta* o PnL (p=0,25 → +US$ 38,7k), o que é assinatura de adverse selection nos fills do hedge DESC. O modelo sorteia os misses aleatoriamente; a realidade é anti-correlacionada — o operador leva ~100% dos fills tóxicos e perde os bons.

Agravante metodológico: a janela 2026-07-01→22 foi usada em **todos** os labs de seleção (holdout, budget, lab09, lab10). O "holdout" está queimado — é in-sample.

Este é o mesmo padrão de colapso já documentado na Hopper 3 (+US$ 4.863 maker otimista → −US$ 4.962 taker honesto; dossiê 2026-07-10), e é consistente com o catálogo de anomalias: nenhum edge taker sobreviveu a book real + fee 0,07 neste mercado.

**Recomendação: não iniciar testes com capital no data-robot.** Antes disso, existe um caminho de 3 etapas (seção 9): (1) backtest honesto com modo `taker_limit` + latência + maker pessimista em janela limpa; (2) se PF ≥ 1,2, campanha shadow no data-robot medindo execução; (3) micro-canário Post Only só para medir fills. O critério de rejeição já consta no doc da estratégia: *"edge só existe em `optimistic_maker` (alfa de fill irreal)"* — hoje a evidência aponta para esse desfecho, mas a variante honesta ainda não foi construída e testada.

---

## 2. Escopo e metodologia da auditoria

Examinados:

- Motor: `labs/legacy/strategy-runners/portable/escada-dupla-runner.js` (leitura integral).
- Documentação: `docs/estrategias/implementadas/escada-dupla-v1.md`, `labs/strategies/carry/escada-dupla-v1/README.md`, `labs/sandbox/escada-dupla-lab-report.md`.
- Experimentos e relatórios: `holdout-july`, `budget-micro-july`, `lab09-realistic-edge-july`, `lab10-fill-rate-july` (em `reports/labs/escada-dupla-v1/`).
- Precedentes: `docs/estrategias/avaliacao-integrada-conta-real-2026-07-10.md` (Hopper 3), `docs/analise-quantitativa/catalogo-anomalias.md`.
- Dados: lake `backtest_ticks` BTC 5m depth 25 (parquet, desde 2026-04-23), via DuckDB.
- Infra alvo: `data-robot` (README, status 1.11.1, próximo gate = campanha shadow).

Produzidas duas sondas empíricas novas (seção 6).

---

## 3. O que a estratégia realmente é

Tirando a roupagem de "escada dupla", o perfil campeão (`ascent_hedge`, `rearmMode=off`, `sideMultiplier=1`, maxSub=8, maxDesc=4, freio `maxPairAvgSumCents=98`) se reduz a:

| Perna | Mecânica | Execução assumida |
|---|---|---|
| **Líder (1º lado a bater 55¢)** | compra SUB 55→90¢ conforme o ask sobe | **taker** (fee crypto 0,07·p·(1−p)) |
| **Oposto** | compra DESC 45→30¢ conforme o ask cai | **maker** (fee 0) |
| **Equalização** | se o lado menor chega a ≤5¢, completa shares e trava o par | segue regra líder/oposto |

É um **carry de momentum com hedge barato** — parente direto da TFC (comprar o favorito terminal) e da Hopper 3 (equalização + maker). O lucro estrutural exige média(UP)+média(DOWN) < 100¢ com shares equalizadas; o risco estrutural é o chicote (acumula os dois lados caro e o par custa > 100¢).

Nota: com `rearmMode=off` e `sideMultiplier=1`, o campeão **não usa** as duas features que dão nome à estratégia (re-arme oscilante e multiplicador martingale). O que sobrou é o carry acima.

---

## 4. Evidência existente nos labs (fatos medidos)

Janela de todos os experimentos abaixo: **2026-07-01 → 22** (22 dias, 5.823 entradas, ~3,49M ticks, fees crypto on, spread 1¢).

### 4.1 Lab09 — microestrutura (`lab09-realistic-edge-july`)

| Variante | Taker | Maker hedge | PnL | PF | DD | Dias+ |
|---|---|---|---:|---:|---:|---:|
| `opt-slip0` | fórmula (nível+0,5¢) | fill imediato no limit | +38.798 | 1,87 | 279 | 22/22 |
| `touch-formula-slip0` | fórmula | touch (fill no toque) | +38.798 | 1,87 | 279 | 22/22 |
| `resting-formula-slip1` | fórmula+slip1 | resting (atravessamento) | +35.394 | 1,55 | 491 | 22/22 |
| `touch-capped1-slip1` **(preset v5 "realista")** | min(walk, fórmula+1¢) | touch | +29.251 | 1,63 | 312 | 22/22 |
| `resting-walk-slip0` **(honesto)** | **book real (walk)** | resting | **−8.541** | **0,86** | 1.203 | **1/22** |

Leitura factual: mantendo o hedge idêntico (`resting`), trocar o preço taker de `fórmula` para `walk` (book real) move o resultado em **~US$ 44k** (+35,4k → −8,5k). O que decide o sinal do PnL é **o preço pago no lado líder**, não o modelo de fill do hedge.

### 4.2 Budget-micro (`budget-micro-july`) — sizing não salva

| sizeScale | `optimistic_maker` | `resting_maker` (taker=walk) |
|---:|---:|---:|
| 0,25 | +9.700 / +8.398 | −2.444 / −2.629 |
| 0,50 | +19.399 / +16.796 | −4.935 / −5.244 |
| 1,00 | +38.798 / +33.592 | −9.955 / −10.577 |

(pares = slip 0¢ / 1¢). O flip otimista→honesto ocorre em **todas** as escalas: não é problema de tamanho de ordem.

### 4.3 Lab10 — fill-rate do hedge (`lab10-fill-rate-july`)

Base = preset v5 (touch-capped1-slip1). Varredura de `makerFillProb` com RNG determinístico:

| p fill | miss | PnL | PF |
|---:|---|---:|---:|
| 1,00 | — | +29.251 | 1,63 |
| 0,70 | skip | +32.753 | 1,64 |
| 0,40 | skip | +37.258 | 1,67 |
| 0,25 | skip | +38.711 | 1,66 |

Fato: **menos fill maker ⇒ mais PnL**, monotônico. Inferência (forte): os fills do hedge DESC têm expectativa negativa (adverse selection — compram o lado que está caindo e tende a continuar caindo). Ver seção 7.2 para por que isso torna o lab10 *otimista*, não conservador.

### 4.4 Escala do PnL é implausível a priori

+US$ 38,8k em 22 dias com teto de US$ 80/evento e 5.823 entradas ≈ **US$ 6,66/evento ≈ 8% de retorno médio por evento de 5 minutos**. O catálogo de anomalias (ANOM-01 a 04) mostra que sinais taker com win rate bruto de até 83% terminam com expectativa **negativa** neste mercado após book real + fee. Um edge de 8%/evento acessível via taker não persistiria com arbitradores ativos.

---

## 5. Sonda 1 — profundidade real do book (fato novo)

Script: `scratch/escada-dupla-book-depth-probe.js`. Amostra: 23.895 ticks de julho/2026 com `up_best_ask` ∈ [0,50; 0,92], book depth 25.

| Métrica | p10 | p50 | p90 | p99 |
|---|---:|---:|---:|---:|
| Spread (¢) | 1,00 | 1,00 | 1,00 | 5,00 |
| Tamanho do best ask (shares) | 22 | **214** | 917 | 1.918 |
| Depth até best+1¢ (shares) | 97 | 527 | 1.655 | 3.313 |
| Slip médio p/ 20 shares vs best (¢) | 0,00 | 0,00 | 0,00 | 1,09 |
| Slip médio p/ 30 shares vs best (¢) | 0,00 | 0,00 | 0,28 | 1,50 |

- 20 shares custam ≤ best+1¢ em **98,8%** dos ticks; 30 shares em **98,1%**.

**Conclusões da sonda 1:**

1. **Profundidade não explica o rombo do modo walk.** Para o sizing da escada (10–30 shares/nível), varrer o book quase nunca custa mais de 1¢ sobre o best ask.
2. **Positivo para viabilidade física:** o mercado comporta o sizing micro/campeão sem impacto relevante de profundidade; spread mediano de 1¢ valida o `spreadCents=1` dos presets.

---

## 6. Sonda 2 — o gap no cruzamento (fato novo; a causa-raiz)

Script: `scratch/escada-dupla-gap-probe.js`. Método: tick-a-tick (cadência ~0,5s), para cada evento e cada lado, detectar cruzamentos `prevAsk < nível ≤ ask` nos níveis SUB (55…90¢) e medir `gap = ask real − nível`. Amostra: 10 dias (2026-07-10→19), 1.585.796 ticks, **98.098 cruzamentos**.

| Métrica do gap | Valor |
|---|---:|
| Média | **1,90¢** |
| p50 | 1,00¢ |
| p75 | 2,00¢ |
| p90 | **5,00¢** |
| p99 | **16,00¢** |
| % cruzamentos com gap > 1¢ | 53,4% |
| % com gap > 2¢ | 32,5% |
| % com gap > 5¢ | 10,9% |

Por nível (média do gap): 55¢ → 2,39¢ · 60¢ → 2,31¢ · 65¢ → 2,12¢ · 70¢ → 1,98¢ · 75¢ → 1,78¢ · 80¢ → 1,54¢ · 85¢ → 1,35¢ · 90¢ → 0,93¢.

**Mecânica da mentira** (inferência forte, consistente com todos os números):

- O nível SUB dispara quando o ask **já cruzou** o preço do nível. Com ticks de ~0,5s e mercado de 5 minutos, o ask frequentemente **pula** vários centavos de uma vez.
- `takerPriceMode=formula` preenche a `nível + spread/2 + slip` (ex.: 56,5¢ com ask real a 70¢). `capped` limita a `fórmula + 1¢` — ainda fantasma em 1/3 dos cruzamentos.
- Pior: num pulo de 53→70¢, os níveis 55/60/65/70 disparam **no mesmo tick**, cada um com preço fantasma próprio. O modo `walk` paga o ask real (~70¢) nos quatro — daí os ~US$ 44k de diferença.
- Os gaps grandes concentram-se em momentum forte — exatamente os eventos em que a escada mais acumula o lado líder. O erro de preço é **correlacionado com o path**, não é ruído simétrico.

Corolário: o preset "realista" v5 (`touch-capped1-slip1`) e o v6 (`fill70`) **ainda contêm a fantasia**, porque `capped` preenche sempre (não modela o miss) a um preço até fórmula+1¢, enquanto 32,5% dos cruzamentos têm gap > 2¢ e 10,9% têm gap > 5¢.

---

## 7. Diagnóstico consolidado — onde o backtest mente

### 7.1 Mentira nº 1 (decisiva): preço taker fantasma no gap

Coberta nas seções 4.1, 4.4 e 6. O modo honesto existente (`walk`) dá PF 0,86. E o `walk` ainda é **otimista**, porque assume latência zero (fill no mesmo tick da observação; na prática soma-se latência de decisão→assinatura→envio→match, com o ask andando contra).

### 7.2 Mentira nº 2: fill maker com moeda ao ar (RNG independente)

O lab10 modela o miss do hedge como sorteio independente do path. Na realidade, ordens maker no lado que cai sofrem seleção adversa determinística:

- **Fill garantido quando o preço atravessa e continua caindo** (fluxo tóxico) — são os fills de pior expectativa;
- **Miss provável quando o preço toca e volta** (os fills bons, onde haveria rebote).

Como o lab10 provou que os fills maker têm média negativa (menos fill ⇒ mais PnL), o cenário real — que entrega ~100% dos fills ruins e uma fração dos bons — é **pior que qualquer linha da tabela do lab10**, inclusive p=1,0. A leitura do README do lab ("mais realista ≠ menos lucro") está invertida.

Nota adicional de modelagem: no `touch_maker` com `throughFillOnTrigger`, quando o ask já está ≤ limit no disparo, o runner registra fill **maker a preço = limit** (acima do ask real, fee 0). Na realidade isso seria um fill **taker ao ask** (mais barato, com fee) — uma ordem postada no limit ≥ ask é marketable e não descansa. O efeito líquido é pequeno comparado à mentira nº 1, mas o rótulo de liquidez está errado.

### 7.3 Mentira nº 3: holdout queimado (seleção múltipla na mesma janela)

Todos os experimentos que escolheram o campeão e os presets v4–v6 rodaram em 2026-07-01→22: `holdout-july`, `budget-min/micro`, `lab09`, `lab10`. Parâmetros como `maxSubLevels=8`, `maxPairAvgSumCents=98`, `capped1`, `slip1`, `fill70` foram selecionados **olhando essa janela**. Ela não pode mais ser citada como out-of-sample. O lake tem dados desde 2026-04-23; maio–junho estão disponíveis para re-split.

### 7.4 Mentiras menores (não decisivas, mas a corrigir)

| Item | Situação | Risco |
|---|---|---|
| Latência | 0ms (fill no tick da observação; ticks ~0,5s) | Subestima custo taker além do walk; crítico em momentum |
| Settlement | `winnerSide = btc_price(último tick) ≥ price_to_beat` | Pode divergir da resolução oficial em eventos de fronteira; commits recentes tocaram nessa lógica |
| Auto-impacto | ordens resting próprias não afetam o book/outros bots | Relevante só ao escalar; irrelevante no micro |
| Equalização | fill a `equalizeMaxAskCents` (5¢) com book de cauda | Asks a ≤5¢ perto do fim podem estar vazios/largos |

---

## 8. Precedentes internos (por que este padrão é conhecido)

| Precedente | Resultado | Paralelo com a Escada |
|---|---|---|
| **Hopper 3 V1** (dossiê 2026-07-10) | +US$ 4.863 maker otimista → **−US$ 4.962** taker honesto; 52/59 → 1/59 dias positivos | Flip idêntico de sinal com a hipótese de execução; mesma família carry/equalização |
| **Catálogo de anomalias** (ANOM-01…04) | 4 hipóteses taker rejeitadas; até WR 83% bruto vira expectativa negativa após book real + fee | O lado líder da Escada é exatamente um comprador taker de favorito em movimento |
| **Apex/TFC maker profit lock** | comprar o oposto via maker elevou WR a 86% mas derrubou PF abaixo de 1 | O hedge DESC maker da Escada tem a mesma natureza; lab10 confirma média negativa dos fills |

---

## 9. A estratégia pode sobreviver? O que precisaria ser verdade

O edge honesto, se existir, tem que vir de **não pagar o gap**. Isso significa reformular o lado líder:

- **`taker_limit` (marketable-limit com miss):** ao disparar o nível, enviar limit a `nível + cap` (ex.: +1¢). Se o walk real ≤ cap → fill (é o que o `capped` já precifica); **senão → miss** (skip ou re-arme), em vez do fill fantasma atual. Isso é implementável no runner hoje (o walk já existe; falta a política de miss no taker).
- Consequência esperada: nos trends rápidos a estratégia acumula **menos** lado vencedor (perde os fills de momentum), o que corta parte dos lucros junto com os custos. **O sinal do resultado líquido é uma questão empírica em aberto** — é o experimento decisivo.
- A favor da viabilidade física: sonda 1 mostra book profundo e spread de 1¢ — execução limit/maker é factível neste mercado; o problema nunca foi liquidez, foi o preço assumido.
- Contra: sondas + precedentes sugerem que o mercado precifica bem; o que sobra após remover a fantasia tende a ser pequeno e frágil.

Hipóteses adicionais (só depois do baseline honesto): reduzir densidade de níveis SUB (menos perseguição), hedge DESC só em níveis profundos (≤35¢), gates de velocidade do spot para não comprar em gap.

---

## 10. Plano de validação em 3 etapas (gates objetivos)

### Etapa 1 — Backtest honesto de verdade (bloqueante; ~1–2 dias de runner)

Mudanças no `escada-dupla-runner.js`:

1. **`taker_limit`**: novo `takerPriceMode` (ou `takerMissPolicy: skip|rest`) — fill só se walk real ≤ fórmula+cap; miss não gera inventário e re-arma/pula o nível.
2. **Latência**: preencher com o book do tick t+1 (≥ +0,5s) — aproximação de latência de envio.
3. **Maker pessimista**: remover `throughFillOnTrigger` do cenário de referência; fill só por atravessamento (`shouldFillRestingBuy`); tratar `makerFillProb < 1` como **teto de otimismo**, nunca como cenário-base.
4. **Janela limpa**: treinar em mai–jun (lake desde 23/04), validar em julho **congelado**; idealmente reservar agosto como forward puro.
5. Testes: estender `tests/escadaDuplaTouchMaker.test.js` / `escadaDuplaFillRate.test.js` para a política de miss do taker.

**Gate de aprovação:** PF ≥ 1,2 e PnL > 0 no holdout limpo, na config honesta (`taker_limit` + latência + maker por atravessamento + fees). **Gate de rejeição** (já previsto no doc da estratégia): edge só existe nos modos otimistas → mover para `docs/rejeitadas/` e registrar o post-mortem.

### Etapa 2 — Shadow no data-robot (sem CLOB, sem capital; ≥30 dias)

A infra já existe (`npm run midas:shadow-sprint` como molde; próximo gate do robot já é "campanha shadow supervisionada"). Medir, por nível e por tempo restante:

- gap real entre sinal e preço executável (validar a sonda 2 ao vivo, com latência real);
- fill rate maker das ordens DESC hipotéticas (postadas de verdade? não — shadow apenas observa o book e simula fila conservadora);
- adverse selection pós-toque (250ms / 1s / 5s / expiração);
- custo de oportunidade dos misses do `taker_limit`.

Métricas e critérios do §12 do dossiê 2026-07-10 aplicam-se integralmente.

### Etapa 3 — Micro-canário Post Only (medir execução, não lucro)

Somente se as etapas 1–2 passarem, seguindo os gates do dossiê: capital dispensável e segregado, risco estressado ≤ 0,25% da banca/evento, kill switches, ≥1.000 fills e 30 dias antes de qualquer escala, parâmetros congelados.

---

## 11. Reprodução

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest

# Sondas desta auditoria
node scratch/escada-dupla-book-depth-probe.js
node --max-old-space-size=8192 scratch/escada-dupla-gap-probe.js

# Labs citados (regeram os relatórios em reports/labs/escada-dupla-v1/)
npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/lab09-realistic-edge-july.json --variant-workers 4
npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/budget-micro-july.json --variant-workers 4
npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/lab10-fill-rate-july.json --variant-workers 4
```

Relatórios usados: `reports/labs/escada-dupla-v1/2026-07-25T05-03-21-873Z-…lab09…`, `…04-43-07-596Z-…budget-micro…`, `…05-36-21-849Z-…lab10…`, `…03-31-07-957Z-…holdout-july`.

---

## 12. Achados por nível de certeza

**Fatos (medidos nesta auditoria ou nos relatórios):**

- `resting_maker` + `walk` → −US$ 8.541, PF 0,86, 1/22 dias (lab09).
- Flip otimista/honesto em todas as escalas de sizing (budget-micro).
- Book profundo: 214 shares medianos no best ask; 30 shares ≤ best+1¢ em 98% dos ticks (sonda 1).
- Gap médio de 1,9¢ no cruzamento de níveis SUB; p90 = 5¢; 53% > 1¢ (sonda 2, 98k cruzamentos).
- `makerFillProb` menor ⇒ PnL maior, monotônico (lab10).
- Todos os labs de seleção usaram 2026-07-01→22.

**Inferências fortes:**

- O PnL do campeão vem majoritariamente de fills taker a preços inexistentes nos pulos de ask; o `capped(+1¢)` cobre só ~2/3 dos cruzamentos.
- Os fills maker do hedge têm expectativa negativa; qualquer modelo de fila realista piora o resultado vs lab10.
- Após remover as duas fantasias, o resultado esperado da config atual é ≤ 0.

**Em aberto (só a Etapa 1/2 responde):**

- Sinal do PnL com `taker_limit` + miss honesto (o experimento decisivo).
- Fill rate maker real e adverse selection medida ao vivo.
- Divergência settlement lake vs resolução oficial em eventos de fronteira.

---

## 12b. RESULTADO DA ETAPA 1 (2026-07-26) — REJEITADA

A Etapa 1 foi executada em 2026-07-26: `taker_limit` + `takerLatencyTicks` implementados no runner (testes em `tests/escadaDuplaTakerLimit.test.js`), janela limpa mai–jun/2026 (61 dias, 10,97M ticks, nunca usados em seleção). Experimento: `taker-limit-may-june.json`; relatório `reports/labs/escada-dupla-v1/2026-07-26T00-26-13-517Z-…`.

**Todas as 7 configs honestas perderam**: PnL entre −US$ 27,5k e −US$ 43k, PF 0,60–0,84, 0–9 dias positivos em 61. O gate (PF ≥ 1,2, PnL > 0) falhou por margem enorme; a validação em julho congelado tornou-se sem objeto. O win rate honesto desabou para 32–41% (vs 67% otimista), confirmando que o PnL do campeão morava nos fills a preço fantasma. `skip` "vence" por comprar menos; retry com latência piora (seleção adversa no rearm).

**Desfecho: estratégia movida para [`../rejeitadas/escada-dupla-v1.md`](../rejeitadas/escada-dupla-v1.md) (post-mortem completo). Este documento passa a ser o anexo técnico do post-mortem.**

## 13. Decisão recomendada (vigente até a Etapa 1)

- **Não** iniciar testes com capital no `data-robot`.
- **Não** citar os presets v5/v6 como "realistas" — contêm preço taker fantasma (cap sem miss) e fila RNG.
- Tratar a Escada Dupla como **hipótese de microestrutura** (mesma classe da Hopper 3), com um experimento decisivo bem definido e barato (Etapa 1).
- Se a Etapa 1 rejeitar: arquivar em `docs/rejeitadas/` com este documento como post-mortem.

## 14. Referências

- Doc da estratégia: `docs/estrategias/implementadas/escada-dupla-v1.md`
- Runner: `labs/legacy/strategy-runners/portable/escada-dupla-runner.js`
- Dossiê conta real: `docs/estrategias/avaliacao-integrada-conta-real-2026-07-10.md`
- Anomalias: `docs/analise-quantitativa/catalogo-anomalias.md`
- Maker realista Hopper: `docs/estrategias/hopper-3-maker-realista.md`
- Robot: `../data-robot/README.md` (status 1.11.1, gate shadow)
