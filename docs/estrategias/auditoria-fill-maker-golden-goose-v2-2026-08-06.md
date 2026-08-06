# Auditoria de fill maker — Golden Goose V2

**Data:** 2026-08-06
**Status:** **INCONCLUSIVO POR LIMITE DE DADO** — o fill maker não é resolvível
com snapshots de book. Mas dois achados colaterais são decisórios.
**Script:** `labs/sandbox/binance-lead-scalp/run-scalp-lab-fillaudit.mjs`

---

## 1. Achado decisório #1 — os números publicados não reproduzem

Rodando o **script atual** com a **config publicada** do Golden V2
(`--impulse-usd 8 --impulse-vol-mult 2.5 --impulse-cap 20 --stale-mid 0.03
--timeout 20 --rescue --rescue-offset 0.01 --rescue-stop 0.25 --ladder 0.08,0.14
--sizing sharesCap --min-tau 20 --max-tau 280 --budget 5`):

| janela | publicado | script atual (m0, mesma config) |
|---|---|---|
| maio | $6.979 | **$3.551,83** |
| PF global | 4,71 | 2,52 (maio) · 2,43 (julho) |
| WR global | 80,4% | 71,5% (maio) · 70,3% (julho) |
| MaxDD | $14,26 | $47,41 (maio) |

`run-scalp-lab.mjs` foi alterado depois da publicação: agora carrega
`scratch/canonical-outcomes-v1.csv` (settlement canônico) e usa
`cryptoTakerFee`/`binanceTimestampToAvailableSec` de
`src/research/causalLeadSettle.js`. O relatório publicado usava proxy de último
tick.

**Consequência: o doc `estrategia-definitiva-btc-5m-golden-v2-2026-08-05.md` está
com números obsoletos — cerca de metade do PnL e 3× o drawdown.** Isso vale
independentemente de qualquer discussão sobre fill.

## 2. Achado decisório #2 — o proxy de fill usa o lado errado do book

`run-scalp-lab.mjs:387`:

```js
if (bid >= lvl.limitPx) {        // preenche o nível INTEIRO no toque
```

Nossa ordem de saída é uma **venda passiva** em `limitPx` — ela vive na fila do
**ask**. Quem a levanta é um comprador agressivo, e nesse instante o **bid segue
abaixo** do nosso preço. O `bid` é a variável errada, e não há modelagem de fila:
a ladder posta ~10 shares onde tipicamente descansam **100–500**.

Isto é observação de código e de microestrutura; não depende de backtest.

## 3. Por que o fill não é resolvível com este dado

Construí três modelos. **Os três andaram na direção errada**, cada um por um
motivo diferente — e o padrão é o diagnóstico:

| modelo | ideia | por que falhou |
|---|---|---|
| m2a | toda queda de size no nosso preço = negócio | nível saindo da janela de 20 níveis virava "execução" → PF 15,86 |
| m3 | `best_ask > limitPx` = nível varrido | **mais frouxo** que o baseline: com spread de 2¢ o ask passa antes de o bid chegar. E ask subindo também acontece por **cancelamento** |
| none | nenhum fill maker (suposto piso) | **não é piso**: posição fica aberta, bloqueia novas entradas, trades caem 12.035→7.101 e vira outra estratégia (PnL maior, DD $760 vs $47) |

A raiz é única: **um snapshot de book não distingue execução de cancelamento.**
Size sumindo do nosso nível pode ser alguém comprando (preenchemos) ou o vendedor
cancelando (não preenchemos). Sem *trade prints*, qualquer modelo de fila é uma
suposição disfarçada de medição — e o sinal de que ela está errada é justamente o
resultado *melhorar* quando o modelo deveria ser mais duro.

Isto confirma, por outro caminho, o que a auditoria canônica já dizia:
> "exige prints, fila, cancelamento e fill medidos; tocar o book não conta como fill."

## 4. O que ficou robusto: a entrada

Todos os cenários que rodei — teto, m3, sem fill maker, treino e holdout — deram
**PnL positivo**:

| cenário | maio | julho (holdout) |
|---|---|---|
| m0 (bid≥limit) | $3.552 | $2.214 |
| m3 | $4.309 | $2.454 |
| sem fill maker | $3.851 | $3.441 |

O sinal de entrada (lead Binance ≥2,5σ com mid ainda não repreçado) sobrevive a
**qualquer** suposição de saída que testei, inclusive em holdout. Isso é
consistente com o catálogo minerado (83–89% OOS).

**A incerteza está inteiramente na execução da saída, não na tese.**

## 5. O que fazer

1. **Corrigir o doc do Golden V2** com os números do script atual. Ninguém deve
   dimensionar capital pelo $20.095 / DD $14,26.
2. **Medir fill de verdade, não modelar.** Shadow com ordens maker reais de
   tamanho mínimo, registrando: preço postado, size na frente no momento do post,
   tempo até fill, fill parcial vs total, e o estado do book no momento. Duas
   semanas disso resolve o que nenhum backtest sobre snapshots resolve.
3. Enquanto isso, tratar o intervalo como genuinamente aberto. Não há
   justificativa para escolher offsets de ladder por backtest — o sweep que rodei
   (0,02/0,04 até 0,20/0,32) está inteiramente dentro da incerteza de fill.

## 6. Erros meus nesta auditoria (registrados de propósito)

1. **Comparei configs diferentes.** O primeiro run de auditoria usou os defaults
   do script (`impulseVolMult` 0, `rescue` false, `timeout` 8) em vez da config
   publicada, e atribuí a diferença ao fill. Reportei −70% que não existia.
2. **Reproduzi a coisa errada.** Validei "meu script == script original" numa
   janela de 7 dias com args meus, e li isso como "reproduzi o baseline
   publicado". Só o segundo valida a base.
3. **Trabalhei sobre uma cópia velha.** `run-scalp-lab.mjs` mudou depois do meu
   `cp`; a diferença de 2 trades que eu perseguia era a troca para outcome
   canônico.

O portão que funcionou, e que deve ser obrigatório: **reproduzir o run alvo na
casa decimal, com diff de config impresso, antes de mudar uma variável.** Depois
disso o m0 bateu exato (12.035 trades, $3.551,83, PF 2,519968666264226).

Regra prática que emergiu: **quando um modelo mais rigoroso melhora o resultado,
é bug — não descoberta.** Vale como asserção automática em lab de execução.
