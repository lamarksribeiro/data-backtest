# Relatório complementar — correção FAK-exit e achados de investigação de código

**Base:** `RELATORIO-MIDAS-LIVE-VS-BT.md` (achados A1-A10, propostas S1-S13)
**Escopo desta rodada:** leitura de código em `data-robot` (live) e `data-backtest` (lab), cruzando duas investigações independentes (própria + agente), para transformar os achados de dados em causa raiz de código e aplicar a correção mais certeira.
**Gerado:** 2026-07-25
**Arquivos alterados:** `data-robot/src/tfc/preset-midas.js`, `data-robot/test/midas-micro-live.test.js`

---

## 1. Correção aplicada

### 1.1 O bug

`MICRO_AGGRESSIVE` e `MICRO_ROBUST` (`data-robot/src/tfc/preset-midas.js:109-124`), presets usados pelo canário `btc-micro-aggressive-v1` (o que está rodando ao vivo), definiam:

```js
entryOrderType: 'FAK',
exitOrderType: 'FAK',
```

`exitOrderType` alimenta **toda saída protetora** da estratégia, não só a entrada:
- `danger_exit_continuous`, `early_warn_exit`, `danger_exit` (`midasV1.js:380-437`)
- `late_flip_exit` (`midasV1.js:481-492`)
- a perna `EXIT` da saga `REVERSE` — o "vender o lado perdedor" antes de comprar o lado novo (`reverseSaga.js:60-76`)

FAK (*Fill-And-Kill*) é atômico e sem retry: ou enche tudo instantaneamente, ou morre. Nos últimos 4-8s antes do expiry (exatamente a janela do late-flip), o book do lado que se está tentando vender costuma estar fino — o mercado já convergiu para os extremos (0.95+/0.05-) e há pouca profundidade do lado comprador daquele token. Quando a FAK falha nesse momento, `reverseSaga.js:91-92` marca a ordem-mãe como `REVERSE_EXIT_INCOMPLETE` e **não tenta de novo** — a posição fica presa no lado que está perdendo, sem proteção nenhuma.

Isso bate exatamente com o achado A2 do relatório original (`REVERSE_EXIT_INCOMPLETE` em `btc-updown-5m-1784953500`, ver `prod-reverse-diagnosis.json`).

### 1.2 Por que o backtest não pegou isso

`labs/strategies/terminal/midas-carry-v1/strategy.gls:218`:

```
let flipped = reverse(oppSide, { price: oppAsk, exitPrice: bid, budget: state.reverseBudget, tick: tick, ignoreConsumed: true, reason: "late_flip_reverse" })
```

`ignoreConsumed: true` faz o executor do lab **sempre encher** a reversão ao preço cotado, sem checar profundidade/liquidez residual do book — não existe conceito de FAK-miss no simulador. O mesmo vale para `exit()` (saídas normais) e `enter()` (entradas). Por isso o profit factor do BT (1,68) e a taxa de reversão bem-sucedida do BT não se reproduzem ao vivo: o gap não é de **edge direcional** (WR bate: 80% live vs 79,2% BT — isso está confirmado, é sinal real), é de **modelo de execução**. O lab assume fills garantidos onde a exchange real, sob FAK, pode simplesmente recusar a ordem.

### 1.3 A correção

`exitOrderType` mudou de `'FAK'` para `'GTC'` em ambos os presets. `entryOrderType` continua `'FAK'` (não há motivo pra mudar: overpagar numa entrada não é uma emergência, dá pra esperar o próximo tick; já falhar em sair de uma posição perdedora, sim).

O preço submetido na saída já é calculado como *marketable* — `buildExitOrderFields` em `midasV1.js:56-72` usa `minPrice = max(stopMinBid, bid)` para ordens não-FAK, ou seja, precificado exatamente no melhor bid vigente, o que deveria cruzar o book imediatamente contra o bid existente. A diferença prática entre FAK e GTC nesse ponto específico:

| | FAK (antes) | GTC (depois) |
|---|---|---|
| Fill completo disponível | executa | executa |
| Fill parcial disponível | **rejeita tudo**, saga marca `REVERSE_EXIT_INCOMPLETE`, sem retry | preenche o que der, **resto fica como ordem residual no book** em vez de sumir |
| Sem contraparte no instante do submit | **rejeita tudo** | fica de pé no book esperando cruzar |

Ou seja: no pior caso (zero liquidez), o resultado é equivalente ao que já acontecia (posição não sai). Mas em qualquer caso de liquidez parcial ou levemente atrasada, GTC recupera exposição que a FAK simplesmente descartava. É uma mudança estritamente aditiva em termos de proteção — não há cenário identificado em que GTC piora o resultado de uma saída protetora.

**Testes:** `data-robot/test/midas-micro-live.test.js` tinha uma asserção (`assert.equal(exit.orderType, 'FAK')`) que fixava o comportamento antigo como esperado — atualizada para `'GTC'`. Suíte completa do `data-robot` (231 testes, 75 suites) passa sem outras quebras — nenhum outro teste ou módulo dependia de `exitOrderType === 'FAK'`.

### 1.4 O que essa correção NÃO resolve

- Não muda `entryOrderType` — os 23 `fakMisses` de ENTER (achado A4/A5, fill drift) continuam existindo. Ver seção 3.
- Não adiciona retry — se o GTC não achar contraparte imediatamente, a ordem fica pendente. Não há garantia de que ela seja cancelada/reprecificada antes do settlement; ver risco 4.1 abaixo.
- Não resolve o "winner divergente" (mercado `1784963700` no relatório original) — isso é um problema de paridade de dados/settlement, não de tipo de ordem.
- Não é validado em produção ainda — a mudança está no código, não foi deployada.

---

## 2. Achado novo: o audit journal esconde os ticks "sem evento"

Este achado **não gerou mudança de código nesta rodada**, mas **muda a interpretação do achado A1** do relatório original ("late-flip não protege losses: 8/8 losses sem sinal") e é pré-requisito para qualquer investigação futura de late-flip.

### 2.1 O mecanismo

`data-robot/src/control/engineApp.js:813-817`:

```js
const shouldAuditDecision =
  (decisionResult?.acceptedCount ?? 0) > 0 ||
  decisionResult?.stateChanged === true ||
  deniedProtective.length > 0 ||
  deniedEntryPolicy.length > 0;
if (shouldAuditDecision) {
  executionAudit.append('decision', { ... });
}
```

Uma linha `type:'decision'` só é gravada no audit JSONL quando algo *aconteceu* (intent aceito, mudança de estado, denial de proteção/política de entrada). O snapshot loop roda a até 50ms perto do expiry (`snapshotSources.js:234`, `hotIntervalMs=50`, ativado nos últimos `preEntryHotSecs=45s`), então a estratégia pode estar avaliando o late-flip dezenas de vezes por segundo **sem deixar rastro nenhum**, se a condição de cruzamento nunca fica verdadeira.

### 2.2 Por que isso importa

Os scripts de diagnóstico já escritos (`analyze-loss-lateflip.mjs`, `diagnose-reverse.mjs`) contam `tickCount30s` a partir dessas linhas `type:'decision'`. Verifiquei manualmente o mercado `btc-updown-5m-1784990400` (uma das 8 losses) no audit JSONL bruto:

```
decision  1784990671002  secsLeft=29.626   (logo após o fill de entrada)
...
(nenhuma linha 'decision' entre esse ponto e o settlement)
position_settled  1784990706537
```

Só existe **uma** linha de decisão para esse mercado inteiro (a da entrada), depois nada até o settlement — um vão de ~35s sem nenhum evento journalado. Isso é **consistente tanto com** "o late-flip avaliou centenas de vezes e nunca cruzou de verdade" **quanto com** "o processo parou de avaliar por algum motivo" — não dá pra distinguir os dois cenários com os dados atuais, porque ambos produzem exatamente zero linhas no journal.

A conclusão A1 do relatório ("8/8 losses sem sinal de late-flip") portanto não está errada necessariamente, mas está **subprovada**: o dado que a sustenta (`tickCount30s=0-4`) mede ausência de eventos notáveis, não ausência de avaliação. Não há como hoje diferenciar "o preço nunca cruzou o floor" de "cruzou mas fora da janela 4-8s" de "cruzou dentro da janela mas o bid não bateu `stopMinBid`" de "o processo simplesmente não rodou".

### 2.3 Proposta (não implementada — recomendo priorizar)

Adicionar uma quarta condição a `shouldAuditDecision` em `engineApp.js:813`: sempre que `diagnostics.lateFlip?.active === true` (mesmo sem intent aceito), gravar uma linha no audit. Isso corresponde à proposta S3 do relatório original, mas deveria ter prioridade **antes** de qualquer replay/diagnóstico adicional (S1), porque sem esse breadcrumb qualquer conclusão sobre o mecanismo de late-flip continua sendo especulação sobre dados ausentes.

**Cuidado de implementação:** logar a cada tick hot (50ms) dentro da janela geraria até ~20 linhas/s por mercado em posição — considerar throttle (ex. 1 amostra a cada 250-500ms dentro da janela late-flip), preservando pelo menos 1 amostra por segundo na janela crítica de 4-8s.

---

## 3. Achados que ficam para investigar (não corrigidos nesta rodada)

| # | Achado | Evidência | Por que não corrigi agora |
|---|--------|-----------|---------------------------|
| F1 | **FAK misses na entrada (23 ocorrências)** causam fill drift — ex. mercado `1784963700`: 3 tentativas FAK rejeitadas (0.62, 0.57, 0.62) antes de encher em 0.69, pior que o preço-alvo original | `prod-status.json` orders `ord-42..45`; `prod-audit-summary.json.fakMissSample` | Mudar `entryOrderType` para GTC traria risco oposto: ordem de entrada resting pode encher tarde, com o mercado já tendo se movido contra o gate original (adverse selection). Precisa de teste no lab antes, não é tão claramente aditivo quanto a correção de saída. |
| F2 | **Winner divergente**: mercado `1784963700` — live registrou vencedor "Up" (posição DOWN perdeu, −1.35), BT/lake registrou vencedor "Down" (a mesma posição teria ganho +0.66) | Tabela "deep-dive" do relatório original, `full-parity-report.json` | Preciso investigar a fonte de settlement de cada lado (oracle live vs reconstrução do lake) — pode ser convenção de empate/tick final, pode ser lag de dados no lake. Não tenho ainda causa raiz de código, só o sintoma. |
| F3 | **Cobertura baixa**: 40 entradas live vs 125 BT no mesmo período — parcialmente explicada por FAK miss (F1) e por 35 restarts do processo com posição aberta (`protective_halt` reason `market-rotated-with-position`, 3 ocorrências capturadas, mas relatório cita 35 no total) | `prod-audit-summary.json.protectiveHalts`, achado A4 original | Requer decisão de produto (aumentar budget de retry, reduzir frequência de restart do processo) mais do que um bug de código pontual. |
| F4 | **Journal multi-leg / PnL duplicado**: `prod-audit-summary.json.lossSettles` mostra o mercado `1784971800` e `1784963700` repetidos 4x cada com o mesmo PnL — sugere reprocessamento/replay do settlement gravando o mesmo evento múltiplas vezes no audit por causa de restarts | Observado diretamente nesta sessão em `prod-audit-summary.json` (não estava explicitado assim no relatório original, que só menciona "journal multi-leg" como A7) | Preciso achar o ponto exato do código que reemite `position_settled` em replay/restart antes de propor fix — ainda não localizado. Isso pode estar inflando os números de "perdas" reportados por ferramentas que leem o audit bruto sem deduplicar por `intentId`/`marketId`+`tsMs`. |
| F5 | **GTC residual sem cancelamento garantido** (risco da própria correção desta rodada) | Não encontrei, na leitura desta sessão, um watchdog explícito que cancele ordens `EXIT`/`REVERSE:exit` GTC que fiquem penduradas além do `deadlineMs` do intent (3000ms) | Ver seção 4.1 — precisa de mais leitura em `engine/runtime.js` / `oms/createOms.js` para confirmar se há reconciliação de ordens órfãs no expiry do mercado. |

---

## 4. Riscos e premissas a validar antes do próximo deploy

### 4.1 Ordem GTC pendurada além do settlement
A mudança FAK→GTC assume que, se a ordem de saída não cruzar imediatamente, ficar pendurada no book é estritamente melhor que morrer. Isso é verdade *se e somente se* o sistema tiver algum mecanismo de reconciliação que cancele/reconheça essa ordem quando o mercado expira (a posição settla binariamente independente da ordem CLOB pendente, ver `createOms.js:344 settlePosition`). Vale confirmar: uma ordem GTC de EXIT que nunca cruzou e cujo mercado settla — ela fica "penduarada" indefinidamente no CLOB (ordem órfã) depois que a posição já foi zerada via settlement binário? Isso apareceria como `orphanOrders` no health check (`prod-status.json.health.orphanOrders`, hoje **0**). Recomendo monitorar esse contador nas primeiras horas pós-deploy.

### 4.2 O lab não modela FAK-miss em lugar nenhum
Isso significa que **qualquer** comparação futura live-vs-BT vai continuar mostrando gap de cobertura/PF por causa da entrada (F1), mesmo depois dessa correção. S6 do relatório original ("modelar FAK miss no lab") seria o próximo passo para fechar esse gap de forma mensurável, não só na saída.

### 4.3 Amostra pequena
A correção desta rodada foi motivada por **1 evento confirmado** de `REVERSE_EXIT_INCOMPLETE` em ~40 trades live. É a causa mais defensável tecnicamente (reproduz exatamente o mecanismo do bug), mas o tamanho de amostra é baixo — recomendo rodar 1-2 dias adicionais de canário pós-deploy e comparar a taxa de `REVERSE_EXIT_INCOMPLETE`/`REVERSE_ENTER_FAILED` antes/depois via `prod-reverse-diagnosis.json` (script já existente, `scratch/live-vs-backtest/diagnose-reverse.mjs`).

---

## 5. Próximos passos sugeridos (ordem)

1. **Deploy da correção FAK→GTC** (requer aprovação — não fiz o deploy, só editei o código) e observar `orphanOrders`/`REVERSE_EXIT_INCOMPLETE` nas primeiras 24h.
2. **Breadcrumb de lateFlip no audit** (seção 2.3) — sem isso, não dá pra saber se a correção de fato reduziu perdas por late-flip perdido ou se o mecanismo continua "cego".
3. **F2 (winner divergente)** — auditoria pontual, não bloqueia o resto.
4. **F4 (journal duplicado)** — corrigir antes de confiar em qualquer contagem agregada de losses vinda do audit bruto (os scripts atuais já usam `prod-trades.json`, que parece deduplicado — mas `prod-audit-summary.json` não é, então cuidado ao usar esse artefato para novas conclusões).
5. **F1 (FAK na entrada) + S6 (modelar FAK-miss no lab)** — só depois de ter mais sinal live pós-(1) e (2), para não mexer em duas variáveis ao mesmo tempo.

---

## Artefatos desta rodada

- `data-robot/src/tfc/preset-midas.js` — `exitOrderType: 'FAK' → 'GTC'` em `MICRO_AGGRESSIVE`/`MICRO_ROBUST` (com comentário explicando o motivo).
- `data-robot/test/midas-micro-live.test.js` — asserção atualizada para `'GTC'`.
- Este relatório.
