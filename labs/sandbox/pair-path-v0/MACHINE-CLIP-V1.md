# Clip-Path V1 — lab (Phil clip × Pair-Path)

**Status:** HOLD / PARITY GAP em 2026-07-29  
**Evidência real:** 4 complete-sets lucrativos; gross +US$ 3,05  
**Execução:** preset amplo bloqueado; nenhuma nova ordem sem paridade e aprovação  
**Engine:** [`engine.mjs`](./engine.mjs) · replay L2 [`lake-replay.mjs`](./lake-replay.mjs)

> A auditoria de 95 dias / 24.502 eventos depth-25 rejeita a generalização
> contínua do preset: todas as 12 variantes perderam. Ela termina em 26/07 e não
> contém os quatro trades reais de 28–29/07. Portanto, o path real está validado;
> a política/filtro que o selecionou ainda não está em paridade.

---

## 1. Tese

Complete-set com **avgSum &lt; 1**. O Phil lucra no **clip** (1–2 viradas, avgSum 91–95¢), não na escada MULT. O Pair-Path V0 prova fill live no path curto (1+1). Clip-Path = V0 + **hedge em 2–3 níveis DESC**.

```text
PnL ≈ sh × (1 − avgSum) − fees
sujeito a: residual ~ 0  OU  escape / EQ barata
           MULT = 1 · sem re-open · sem EQ cara
```

---

## 2. Contrato

| Peça | Regra |
|---|---|
| Open | Igual V0: chase [52–62¢], trigger 55, cap +2¢ |
| Hedge | `hedgeLevels` fracionados (ex. 50% @≤42 + 50% @≤38) |
| Escape | Opcional: `tau ≤ tauHedgeEscape` completa residual @ `hedgeEscapeAskMax` |
| EQ | Só se `proj avgSum ≤ eqAvgSumMax` (0,98) e ask ≤ `eqAskMax` |
| Freios | `avgSumMax` 0,95 · `maxEventNotional` 50 micro · `maxHedgeAttempts` 6 |
| Proibido | MULT&gt;1 · grade full · re-arme · EQ com avgSum≥1 |

---

## 3. Como rodar o lab

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node labs/sandbox/pair-path-v0/clip-levels-ab.mjs
```

Journals (14 evt):

- `.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8`
- `.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow`
- `.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow`

Saída: `.tmp/clip-path-v1-ab/report.json`

### Gate histórico de calibração (vs `v0-baseline`; não é GO)

- `stuck = 0`
- `worst ≥ 0`
- `pnl ≥ V0 − 0.5`
- `avgSumMed ≤ V0`

---

## 4. Variantes no A/B

| Nome | Hedge |
|---|---|
| `v0-baseline` | 100% @≤42 |
| `clip-2` | 50/50 @42 / @38 strict |
| `clip-2-escape` | clip-2 + escape τ≤20 @42 |
| `clip-3` | 40/30/30 @42/38/34 strict |
| `clip-3-escape` | clip-3 + escape |
| `clip-2-tight` | 50/50 @40/36 + escape @42 |

Preset histórico: [`presets/clip-path-v1.json`](./presets/clip-path-v1.json)  
(= **deep3** após mechanics-sweep: 40%@≤40 + 30%@≤36 + 30%@≤32, avgSumMax 0,94, escape τ≤20→τ≤12).

Lab champion: [`presets/clip-path-v1-deep4.json`](./presets/clip-path-v1-deep4.json) (42/38/34/30 @ avg 0,93).

### Resultado 1º A/B (14 evt baliza)

| Variante | pnl | avgMed | stuck | vs V0 |
|---|---:|---:|---:|---|
| v0-baseline | 7.09 | 0.940 | 0 | — |
| clip-2 / escape | 7.47 | 0.935 | 0 | +0.38 |
| clip-3 / escape | 11.69 | 0.919 | 0 | +4.60 |
| **clip-2-tight** | **12.42** | **0.925** | **0** | **+5.33** |

### Mechanics sweep histórico (148 variantes, fee 0.07 sh25)

| Pick | pnl | avgMed | CLI |
|---|---:|---:|---|
| V0 | 7.09 | 0.940 | `--clip=off` |
| Ops deep3 | **16.64** | 0.914 | `--clip=deep3` |
| Lab deep4 | **18.71** | 0.900 | `--clip=deep4` (dry first) |

```powershell
node labs/sandbox/pair-path-v0/mechanics-sweep.mjs
```

Saída: `.tmp/clip-path-mechanics-sweep/LEADERBOARD.md`

Escape não disparou nestes journals (mercado já entregou o nível fundo). Strict ≈ escape aqui.

---

## 5. Fixture Phil (referência)

[`fixtures/phil-session-6-clips.json`](./fixtures/phil-session-6-clips.json) — scorecard dos 6 TXT (produto = clip_1v / clip_2v).

---

## 6. Fora de escopo neste lab

- Live / dry Giovanna → ver secção 7
- Patch gates no `Phil_Hopper_Real_1.0.py`
- Escada Studio / Shotandgo optimistic

---

## 7. Micro harness (data-robot)

Arquivo: `data-robot/scripts/pair-path/micro-live.js`

```powershell
# DRY HISTÓRICO — NÃO EXECUTAR
# node scripts/pair-path/micro-live.js --clip=tight --open-shares=10 --max-events=2 --max-notional=16 --open-cap-cents=2 --min-tau-start=150

# LIVE HISTÓRICO — NÃO EXECUTAR; status HOLD / PARITY GAP
# node scripts/pair-path/micro-live.js --live --clip=tight --open-shares=10 --max-events=1 --max-notional=16
```

`--clip`: `off` (V0) | `2` | `3` | `tight` (antigo pick A/B; rejeitado).

Giovanna dry:
```bash
# no host: copiar micro-live.js → /tmp/pair-path-micro-live.js
bash labs/sandbox/pair-path-v0/boot-micro-dry-clip-tight.sh 2 10
```

Live script existe (`boot-micro-live-clip-tight.sh`) — **não rodar sem confirmação** (ordens reais).

---

## 8. Mecanismo real (auditoria 2026-07-28)

Runner: [`exit-depth-ab.mjs`](./exit-depth-ab.mjs) · saída `.tmp/clip-path-v1-ab/exit-depth.json`

### 8.1 Não existe complete-set barato simultâneo

Nos 14 journals (11 868 ticks com os dois lados): `ask_UP + ask_DOWN` tem
**mediana 1,01** e fica abaixo de 1,00 em **0,03%** dos ticks (mínimo 0,98).
O book binário da Polymarket é 1¢ de spread de cada lado de uma soma 1,00.

Disso sai uma identidade que governa tudo:

```text
avgSum = 1,01 − (deriva do open leg entre a 1ª e a 2ª perna)
```

**O edge é direcional.** Não se compra um par barato; abre-se no favorito e o
hedge só fica barato porque a perna aberta subiu. O hedge **realiza** o lucro,
não o cria. `avgSum 0,92` = "a perna aberta subiu 9¢ antes de eu fechar".

Consequência prática: o modo de falha não é "hedge caro", é **a perna aberta
cair e o hedge nunca aparecer**. Esse cenário tem **zero ocorrências** nos
journals — o lab não consegue medir o único risco que importa.

### 8.2 `avgSumMax` é a trava vinculante; `hedgeAskMax` é config morta

Com open em 0,55–0,57 e soma 1,01, o hedge só passa se
`ask_oposto ≤ avgSumMax − openPx` — ou seja **0,37–0,40**. `hedgeAskMax 0,42`
nunca vincula: é recusado antes por `HEDGE_REFUSE_AVGSUM`.

| `avgSumMax` | hedge efetivo | avgSumMed | pnl 14 evt | recusas |
|---|---|---|---|---|
| 0,95 | ≤ 0,39 | 0,940 | **+7,09** | 135 |
| 0,98 | ≤ 0,42 | 0,980 | +0,35 | 7 |
| 1,00 | ≤ 0,44 | 0,980 | **−1,27** | 0 |

O V0 "lucrativo" (+7,09) só lucra porque `avgSumMax 0,95` **acidentalmente**
força o hedge para ≤0,39. A regra declarada (`hedge @≤0,42`) perde dinheiro.
`avgSumMax` não é freio de risco — é a regra de preço da 2ª perna.

Mesmo efeito no preset vigente: `avgSumMax 0,94` recusa hedge acima de 0,37,
então o nível declarado `0,40` é inalcançável num open a 0,57.

### 8.3 A curva de profundidade é monótona muito abaixo da faixa testada

100% do hedge num nível único, mesmos 14 journals, escape τ≤25 @≤0,42:

| nível | deriva exigida | equalizou | avgSumMed | pnl | pnl (fee `min`) |
|---|---|---|---|---:|---:|
| ≤0,42 | +3¢ | 10/10 | 0,980 | −1,27 | −5,88 |
| ≤0,40 | +5¢ | 10/10 | 0,960 | +2,51 | −2,82 |
| ≤0,38 | +7¢ | 10/10 | 0,940 | +7,97 | +3,08 |
| ≤0,36 | +9¢ | 10/10 | 0,920 | +13,23 | +9,12 |
| ≤0,32 | +13¢ | 10/10 | 0,880 | +22,78 | +18,79 |
| ≤0,28 | +17¢ | 10/10 | 0,840 | +31,40 | +27,22 |
| ≤0,20 | +25¢ | 10/10 | 0,770 | +38,09 | +33,65 |

O A/B original varreu 0,42→0,36 (6¢) e parou. **Nenhum nível falha nesta
amostra**, inclusive 0,20. Isso *não* prova que fundo é melhor — prova que
estes journals **não têm poder** para escolher o nível. O que a amostra
descarta é o inverso: não há evidência para preferir 0,40/0,36 a 0,36/0,28.

O nível fundo é atingido de verdade (não é resgate do escape) até ~0,28:

| nível | encheu no nível | via escape τ≤25 |
|---|---|---|
| 0,36 | 9/10 | 1 |
| 0,28 | 9/10 | 1 |
| 0,24 | 8/10 | 2 |
| 0,20 | 7/10 | 3 |

(coluna `esc` do runner. Abaixo de 0,20 o escape passa a carregar a maioria —
sinal de que o nível virou ficção.)

### 8.4 O modelo de fee vale metade do edge

`feeFor` usa a fórmula oficial atual para crypto:
`0,07·p·(1−p)·sh`. O runner também calcula
`0,07·min(p,1−p)·sh` somente como **stress conservador não-oficial**, que custa
~2× nesses preços. No total de 14 eventos, esse stress derruba o preset de
**+15,32 → +10,48** e o V0 `@≤0,42` de −1,27 → −5,88. O ledger ainda precisa
registrar maker/taker e fee efetivamente cobrada por order ID.

### 8.5 Bug corrigido: vencedor proxy invertido

`finish()` decidia o vencedor com `Number(upAsk) >= Number(downAsk)`. Na
resolução o book fica de um lado só (o vencedor perde o *ask*), e
`Number(null) === 0` com `Number.isFinite(0) === true` ⇒ o lado vencedor virava
0 e "perdia". **10 de 14 eventos vinham invertidos.**

Não contaminava as manchetes do A/B (com residual 0, `pnl` independe do
vencedor), mas invalidava qualquer variante que carregue residual — justamente
a classe que precisa ser avaliada. Corrigido em `resolveWinner()`: usa bid como
sinal de valor, cai para ask, varre de trás para frente.

Continua sendo **proxy**: os journals não gravam settlement. `summary.json` tem
`conditionId` — dá para buscar o resultado real na API e fechar essa lacuna.

### 8.6 O que fazer com isso

1. **Não escalar size** com base nestes journals. A amostra é uma janela de
   ~90min (28/07 04:03–05:30 UTC) de regime muito volátil: a perna aberta
   derivou **+24¢ a +44¢ em 10/10 eventos**. Num regime calmo (deriva < 10¢)
   nenhum nível fundo enche e o residual vira o caso comum.
2. O replay depth-25 já incluiu regimes diversos e rejeitou todas as
   profundidades testadas. Não coletar mais journals com objetivo de escolher
   0,40/0,36 vs 0,36/0,28.
3. **Medir fee real** do ledger CLOB apenas para reconstruir os quatro trades
   históricos; isso não reabre o gate.
4. Avaliar por `guardedWorst` e PnL realizado incluindo residual, nunca somente
   pelos paths que equalizaram.

## 9. Decisão da auditoria de 2026-07-29

O book simultâneo teve `ask_UP + ask_DOWN` mediano de 1,01. Logo, abrir o
favorito e depois comprar o oposto por 0,40 não captura arbitragem: exige que o
favorito se mova a favor antes do hedge. A estratégia é momentum direcional com
seguro condicional.

No replay depth-25, os paths equalizados foram positivos, mas 19,6%–32,5% das
entradas deixaram residual. Na melhor configuração por PnL, equalizações
somaram +US$ 9.683,91 e residuais −US$ 17.461,05, resultando em
−US$ 7.777,14. O preset amplo está congelado como fixture `research`. Os quatro
paths reais continuam como ground truth positivo, mas nenhuma nova etapa
operacional é autorizada até recuperar o filtro de seleção e obter aprovação.
