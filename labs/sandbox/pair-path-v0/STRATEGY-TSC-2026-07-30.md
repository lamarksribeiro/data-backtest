# Terminal Spot-Confirmed Favourite (TSC) — especificação e status

**Status:** `research / HOLD` — associação histórica promissora, porém descoberta
na própria janela de 99 dias, **em decaimento monotônico e estatisticamente nula
no mês mais recente**. Não existe holdout limpo e não liberar live.

## A regra

Nos últimos ~12 segundos, comprar o favorito do book **somente quando o spot
confirma o mesmo lado**:

```text
z = (spot − price_to_beat, com sinal a favor do favorito)
    ─────────────────────────────────────────────────────
        spot × σ_por_√s × √tau

entrar se:  tau ∈ [3, 12] s
            ask_favorito ∈ [0,70 , 0,925]
            z ≥ 2
            primeiro tick qualificado do evento (nunca o último)
ordem:      FAK marketable, limite = ask_sinal + 1¢
saída:      nenhuma — carrega até a resolução
```

`σ_por_√s` = desvio-padrão dos log-retornos do spot normalizado por √Δt, janela
móvel de 90s.

**z é usado apenas como limiar, nunca convertido em probabilidade.** A Φ(z)
browniana é comprovadamente enviesada neste book (diz ~0% de flip em z≥3 onde a
realidade é 3–6%); qualquer mapeamento paramétrico importaria esse viés. A taxa
de acerto empírica faz o trabalho.

## Por que funciona (o controle é o argumento)

Mesma população, mesmo período, único parâmetro alterado:

| variante | n | EV/share | PF | meses+ |
|---|---|---|---|---|
| comprar **todo** favorito terminal | 7.308 | **−0,0205** | 0,845 | 0/4 |
| exigir z ≥ 1 | 5.194 | +0,0144 | 1,153 | 4/4 |
| exigir z ≥ 2 | 3.494 | +0,0127 | 1,139 | 4/4 |

O filtro move a mesma população de −2,05¢ para +1,3¢. O valor está quase todo em
**excluir os eventos de z baixo**: o book chama de favorito um lado que o spot
não confirma, e essa subpopulação é catastrófica (EV −5,09¢ em maio).

## Robustez — platô, não knife-edge

21 perturbações uni-axiais em torno do centro; **todas positivas**, 14 com IC95
excluindo zero:

| eixo | faixa testada | EV |
|---|---|---|
| janela de vol | 45–150 s | +0,0104 … +0,0132 |
| limiar z | 1 … 4 | +0,0066 … +0,0144 |
| banda de ask | 0,70–0,95 | +0,0104 … +0,0212 |
| tau | 3–12 … 10–20 | 0,0000 … +0,0198 |

Único eixo que degrada de verdade: **estender tau acima de ~15 s mata o edge**
(`t5_20` → +0,0035; `t10_20` → 0,0000). Apertar melhora (`t3_12` → +0,0198).
O edge vive nos últimos ~12 segundos e em nenhum outro lugar.

## Execução — latência e fill

Modelo: sinal no tick `i`, execução no tick `i+k`, pagando o ask **vigente na
execução**; semântica FAK (se o ask passou do limite, a ordem morre e conta como
*miss*, não como fill a preço velho). Espaçamento do lake ≈ 0,5 s.

| config | fill% | win% | avgAsk | EV | IC95 | PF | pior dia | maxDD |
|---|---|---|---|---|---|---|---|---|
| lat0 slip0 | 100 | 88,0 | 0,843 | +0,0283 | [+0,014; +0,042] | 1,29 | −4,78 | −7,22 |
| lat1 slip1 | 61,1 | 85,4 | 0,800 | +0,0442 | [+0,021; +0,070] | 1,41 | −3,38 | −7,51 |
| lat3 slip0 | 35,3 | 78,8 | 0,717 | +0,0594 | [+0,019; …] | 1,47 | −3,03 | −7,56 |
| lat5 slip0 | 28,9 | 74,1 | 0,657 | +0,0724 | [+0,030; …] | 1,58 | −3,26 | −4,38 |

`lat0` é execução **no mesmo snapshot do sinal**. O identificador foi preservado
para compatibilidade forense, mas não é piso honesto nem prova executável. A
evidência de execução começa em `latencyTicks >= 1`.

**Latência maior aumenta o EV e derruba o fill rate.** O motivo é mecânico: com
FAK, quando o ask sobe acima do limite a ordem morre; só sobram os fills em que o
book veio até nós. `avgAsk` cai de 0,843 para 0,657. Isso é seleção favorável
do modelo, mas **depende de sorte de execução**. Os números de `lat0` não devem
ser citados como resultado operacional.

### Latência real medida (Giovanna)

`.tmp/pair-path-v0-order-path/latency-giovanna-pairpath.json`, host
`giovanna data-robot-engine-btc`, 2026-07-28 — medianas: ping 67 ms,
**create 144 ms**, getOpen 116 ms, cancel 131 ms, **total 384 ms**; primeira
tentativa fria 1025 ms. Auditoria de produção da MIDAS: ciclo completo
**p50 645 ms / p90 1413 ms**.

Portanto `lat1`–`lat3` (0,5–1,5 s) **abrange** o p50–p90 real, e a estratégia é
positiva em toda a faixa. **Duas lacunas permanecem e são conhecidas:**

1. o probe de 384 ms usou ordem `postOnly` de 1¢ — **não** FAK marketable em
   tau 3–12 s sob carga;
2. a latência do book chegando por WS **não** foi modelada; o backtest assume que
   o tick do lake é o que o sistema live enxergaria.

## O problema que impede a liberação

O EV decai monotonicamente, em **todos** os configs, de forma independente:

| mês | lat0 | lat1-slip1 | ask 0,80–0,925 |
|---|---|---|---|
| 2026-04 | +0,0592 | +0,0983 | +0,0362 |
| 2026-05 | +0,0458 | +0,0768 | +0,0308 |
| 2026-06 | +0,0213 | +0,0249 | +0,0174 |
| **2026-07** | **+0,0010** | **+0,0048** | **+0,0025** |

Rodando **só julho** (7.533 eventos), **nenhum** dos 60 configs tem IC95 acima de
zero. O melhor é +0,0129 com IC95 [−0,0041; …].

Decaimento monotônico em quatro meses, replicado em três parametrizações
independentes, é assinatura de **edge sendo arbitrado** — não de ruído. Um sinal
tão simples quanto "spot confirma o favorito" é exatamente o tipo que a
concorrência fecha.

## Auditoria independente e evolução TSC → Clip

A reprodução posterior impôs size 5, caminhada de cinco níveis de depth,
partials FAK e entrada sempre em snapshot posterior. Abril–junho foi usado como
descoberta; julho é somente validação temporal, **não holdout limpo**, pois já
havia sido inspecionado na criação da TSC.

| Entrada | Abr–jun PnL/PF | Jul 1–28 PnL/PF | bootstrap p05 jul | Dia 29 |
|---|---:|---:|---:|---:|
| z≥2, ask 0,70–0,925 | +463,832 / 1,557 | +12,927 / 1,038 | -42,894 | -0,916 |
| z≥2, ask 0,80–0,925 | +283,706 / 1,416 | -3,040 / 0,989 | -44,091 | -0,680 |
| z≥1, ask 0,80–0,925 | +303,456 / 1,247 | +52,500 / 1,114 | -16,203 | +7,434 |

As três versões deixam 100% das entradas direcionais, com pior perda potencial
de aproximadamente -4,67 por evento de 5 shares.

Foram então testadas 183 evoluções que compram o lado oposto por Clip-Path,
com gatilho por z/flip, pisos de complete-set de 0 a -8¢ e latência de 1–2
snapshots:

- 99 foram nominalmente positivas em abril–junho e julho;
- 0 passaram o gate de risco;
- proteção reativa atuou pouco e deixou 91–100% de residual;
- proteção contínua reduziu residual para aproximadamente 21–34%, mas tornou
  julho negativo;
- qualquer miss preservou a cauda cheia de cerca de -4,67.

Logo, a proteção encontrada não oferece o equilíbrio procurado: quando protege
o suficiente, consome o edge; quando preserva o edge, não limita o risco.

## Veredito

- Existe uma **associação histórica mensurável**, não um edge confirmado:
  houve seleção no período completo e não resta holdout limpo.
- A associação **não é tradeable hoje**: julho é estatisticamente nulo e a
  proteção Clip não cria teto duro.
- Não liberar live. Se for testar, **shadow read-only** medindo (a) latência
  sinal→fill do FAK em tau 3–12 s e (b) se o EV de julho se recupera em agosto.

## Reprodução

```bash
node labs/sandbox/pair-path-v0/zmonthly.mjs          # estabilidade e sensibilidade
node labs/sandbox/pair-path-v0/terminal-confirm.mjs  # execução com latência e FAK
node labs/sandbox/pair-path-v0/terminal-confirm.mjs --from=2026-07-01
node labs/sandbox/pair-path-v0/tsc-clip-protection.mjs
```

Resoluções vêm de `scratch/canonical-outcomes-v1.csv` (labels Gamma para
pesquisa, 26.855 eventos), **nunca** do proxy de último tick. Isso ainda não
equivale a finalidade CLOB/on-chain integral.
