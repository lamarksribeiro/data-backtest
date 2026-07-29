# BRIEFING — Clip-Path / Pair-Path / Phil Hopper

**Propósito:** documento autônomo para input de outra IA.  
**Data do briefing:** 2026-07-28 (noite, UTC−3) / trades CLOB até ~2026-07-29 01:46 UTC.  
**Autor da sessão:** agente Cursor + operador (Lamar) · monorepo GoldenLens.  
**Status operacional:** nenhum `micro-live` rodando; `getOpenOrders = 0` no funder.

> **CORREÇÃO DE PARIDADE — 2026-07-29:** os quatro complete-sets abaixo são
> resultados reais e lucrativos na conta: gross +US$ 3,05, net estimado
> +US$ 1,36. O replay depth-25 termina em 26/07 e não contém esses trades de
> 28–29/07. O que ele rejeitou foi a generalização automática aplicada a
> 24.502 eventos, não os resultados reais. Estado: **HOLD / PARITY GAP**; o path
> real está validado, o filtro de seleção ainda precisa ser reconstruído, e
> nenhuma nova operação está autorizada. Ver `AUDIT-PAIR-PATH-2026-07-29.md`.

---

## 0. Como usar este documento

Leia na ordem: (1) tese → (2) evidências CLOB → (3) lab → (4) travas → (5) decisões abertas.  
Não reimplementar Phil full / MULT / escada. Não equalizar com `avgSum > 1`.  
Host live: **Giovanna** (Coolify), app `data-robot`, sidecar Docker `pair-path-micro`.  
Não confundir com produção Hulw (`data-colector` / `data-backtest` / `data-index`).

---

## 1. Ecossistema (mapa)

```
data-colector (ticks PG) → data-backtest (lab Parquet/DuckDB + labs/sandbox)
                         ↘ data-robot (CLOB live · robot.fracta.online · Giovanna)
polymarket-fm/  = Phil Hopper Python (sim/referência; NÃO host live desta fase)
```

| Path | Papel |
|---|---|
| `data-backtest/labs/sandbox/pair-path-v0/` | Engine offline + A/B + docs lab |
| `data-robot/scripts/pair-path/micro-live.js` | Harness dry/live WS + GTC |
| `polymarket-fm/Phil_Hopper_Real_1.0.py` | Phil sim (escada/MULT) — só referência |
| Canvases Cursor | `phil-hopper-sessao-6-eventos`, `phil-hopper-autopsia-execucao`, `phil-hopper-vs-pair-path-v0` |

**Carteira CLOB usada nos lives:**
- Signer: `0x5324940Da03C8A157aE1D173630daC448E184CbB`
- Funder: `0x6dd3DA3e37765ED4dC0d4856aCdd916B797eeda2`

---

## 2. Tese central (produto)

**Complete-set barato:** comprar UP e DOWN até equalizar shares com

```text
avgSum = avg(UP) + avg(DOWN) < 1
PnL estrutural ≈ shares × (1 − avgSum) − fees
```

Se equalizado (`residual = 0`), o vencedor do evento **não importa** para o PnL estrutural (payout = shares).  
Se `residual > 0` (só um lado), vira aposta direcional.

### O que funciona vs o que mata

| Funciona | Mata |
|---|---|
| Clip curto 1–2 “viradas” / path open→hedge | MULT 4×–7× + spray |
| avgSum final 0,91–0,96 | EQ com avgSum > 1 (Phil −$50) |
| Size micro, teto notional | Grade full / re-arme maker |
| Fill real GTC na Giovanna | Simulador optimistic / fee ignorada |

---

## 3. Três máquinas (evolução)

### 3.1 Phil Hopper (sim Python)

- Escada SUB/DESC, MULT, muitas viradas, teto alto ($1000).
- Sessão Telegram 6 TXT (sim `SHOTANDGO`):

| Evento | PnL | avgSum | Vir | EQ | Leitura |
|---|---:|---:|---:|---|---|
| …3800 | −50,89 | **109,6¢** | 7 | sim | Modo morte: EQ com par caro |
| …5900 | +5,91 | 94,7¢ | 2 | sim | Clip ok |
| …6200 | +3,28 | 93,7¢ | 1 | sim | Clip limpo |
| …6800 | +4,20 | 91,9¢ | 1 | sim | Clip limpo |
| …7100 | +17,01 | **103,1¢** | 3 | **não** | Exposto — sorte no lado |
| …7400 | +4,73 | 90,9¢ | 1 | sim | Clip limpo |

- Sessão B bruta ≈ +$35 (não +$300). Estrutural sem o 7100 ≈ +$18.
- Autópsia 3800: equalizou 530/530, médias 40,3+69,3 = **109,6¢** → prejuízo travado (~$50). Não foi “falha de equalizar”.

**Produto Phil útil = clip 1–2 viradas com avgSum < 1.** Escada full = edge fantasma (baliza path-full avgSum med ~1,045).

### 3.2 Pair-Path V0 (1 open + 1 hedge)

Contrato:
- Open: chase favorito ask ∈ [0,52–0,62], trigger 55¢, cap +1–2¢, book sum ~0,95–1,05.
- Hedge: 100% residual @ ask ≤ `hedgeAskMax` (tip. 0,42), `proj avgSum ≤ avgSumMax`.
- MULT=1, sem re-arme, EQ opcional só ask ≤5¢.
- Live: GTC marketable + settle ~1,2–2,5s + cancel.

### 3.3 Clip-Path V1 (open + hedge multinível)

= V0 + hedge em 2–3 clips DESC (ex. 50%@≤40 + 50%@≤36) + escape tardio.

Preset lab vencedor A/B: **`clip-2-tight`** (histórico)  
Preset histórico do sweep: **`--clip=deep3`** (= `RECOMMENDED-deep3-as94-e2`, rejeitado)
- níveis: 40% @≤40 + 30% @≤36 + 30% @≤32
- `avgSumMax` clips: 0,94
- escape: estágio1 τ≤20 @≤42 avg≤0,98; estágio2 τ≤12 @≤45 avg≤1,00; **nunca >1**
- `openRequireHedgeReady`: **OFF**

Lab champion histórico: **`--clip=deep4`** (42/38/34/30 @ avg 0,93; rejeitado)

CLI histórica, preservada somente para reprodução: `node scripts/pair-path/micro-live.js --clip=deep3 ...`

---

## 4. Evidência lab offline (A/B)

**Runner:** `data-backtest/labs/sandbox/pair-path-v0/clip-levels-ab.mjs`  
**Journals:** 14 eventos BTC 5m (~1h30 de janela, 28/07 UTC manhã)  
**Base:** sh25, cap+2, avgSumMax 0,95, hedgeAskMax 0,42, notional≤50

| Variante | traded | eq | stuck | pnl | avgMed | vs V0 |
|---|---:|---:|---:|---:|---:|---|
| v0-baseline | 10/14 | 10 | 0 | 7,09 | 0,940 | — |
| clip-2 | 10 | 10 | 0 | 7,47 | 0,935 | +0,38 |
| clip-3 | 10 | 10 | 0 | 11,69 | 0,919 | +4,60 |
| **clip-2-tight** | 10 | 10 | 0 | **12,42** | **0,925** | **+5,33** |

Recomendação lab: `prefer_clip-2-tight`. Escape não disparou nestes journals (mercado já entregou nível fundo).

Relatório: `data-backtest/.tmp/clip-path-v1-ab/report.json`

### 4.1 Mechanics sweep (céu é o limite) — 2026-07-29

**Runner:** `mechanics-sweep.mjs` · **148 variantes** · mesmos 14 evt · fee 0,07 · sh25  
**Saída:** `.tmp/clip-path-mechanics-sweep/{report.json,LEADERBOARD.md}`

Filtro de execução da calibração: exclui `fee=0`, size-scale e hedge-ready. Não é gate live.

| Pick | Variante | pnl | avgMed | worst | Uso |
|---|---|---:|---:|---:|---|
| V0 baseline | `v0-as95-h42` | 7,09 | 0,940 | 0 | controle |
| **Lab max histórico** | `RECOMMENDED-deep4-as93-e20` | **18,71** | **0,900** | 0 | rejeitado pelo replay L2 |
| **Antigo pick ops** | `RECOMMENDED-deep3-as94-e2` / `--clip=deep3` | **16,64** | **0,914** | 0 | rejeitado pelo replay L2 |
| Prior tight | clip-2-tight | ~12,4 | ~0,925 | 0 | fallback |

**Achados fortes:**
1. Escadas mais profundas (c3/c4 até 30–32¢) + `avgSumMax` 0,93–0,94 batem V0 em **+110–160%** pnl no sample.
2. Escape **cedo** (τ≤40 @≤42) **queima** ~$1,5–2 quando dispara; preferir τ≤20 + escape2 só τ≤12 @≤1,00.
3. `tight-fee0` / size40 são ilusão de ranking — não usar como config live.
4. hedge-ready continua **0 trades** (controle confirmado).
5. Teses novas quase-vencedoras mas frágeis: `deep3-as92`, `c3-38-34-30`, `deep60` (worst −0,1 / recusam mais).

**CLI histórica (não executar; estratégia rejeitada):**
```powershell
# node scripts/pair-path/micro-live.js --clip=deep3 --open-shares=10 --max-events=1 --max-notional=16 --open-cap-cents=2
# agressivo lab: --clip=deep4 (dry primeiro)
```

---

## 5. Evidência dry Giovanna (sem ordem real)

`--clip=tight --open-shares=10 --max-events=5` (dry):

| Evento | Path | avgSum | PnL≈ | Residual |
|---|---|---:|---:|---:|
| …7700 | DN@55 → UP@39 + UP@36 | 0,925 | +0,41 | 0 |
| …8000 | UP@55 → DN@39 + DN@34 | 0,915 | +0,51 | 0 |
| …8300 | UP@55 → DN@39 + DN@36 | 0,925 | +0,41 | 0 |

Dois slots idle (`OPEN_MISS_CAP` / `BOOK_SUM`). Máquina dry validada: open → 2 clips → done.

PnL pequeno é esperado em size 10 (~4% ROC/evento), não erro de conta.

---

## 6. Evidência live CLOB (ground truth)

Fonte: `client.getTrades` / `getTradesPaginated` no container `pair-path-micro`, filtrado por `maker_address = funder`.  
Fee na API: `fee_rate_bps: "0"` (campo); net abaixo usa **estimativa** `fee = 0,07·p·(1−p)·sh` — fee real pode ser menor.

### 6.1 Pares equalizados confirmados

| Quando UTC | Estilo | Legs CLOB | Inv. | avgSum | Gross | Net est. |
|---|---|---|---:|---:|---:|---:|
| 2026-07-28 07:46 | V0 1+1 sh5 | DN@0,55×5 + UP@0,27×5 | 4,10 | **0,820** | +0,90 | +0,74 |
| 2026-07-28 16:11 | V0 1+1 sh10 | UP@0,55×10 + DN@0,40×10 | 9,50 | **0,950** | +0,50 | +0,16 |
| 2026-07-28 17:16 | V0 1+1 sh25 | DN@0,55×25 + UP@0,41×25 | 24,00 | **0,960** | +1,00 | +0,14 |
| 2026-07-29 01:46 | **Clip tight** sh10 | DN@0,57×10 + UP@0,37×5 + UP@0,36×5 | 9,35 | **0,935** | +0,65 | +0,32 |

**Totais:** inv **$46,95** · gross **+$3,05** · net est. **+$1,36**  
- V0 (3 trades): inv $37,60 · net ≈ +$1,05  
- Clip (1 trade): inv $9,35 · net ≈ +$0,32  

### 6.2 Clip live detalhado (…1785289500)

```text
OPEN   10 DOWN @ 0,57 = 5,70     orderId 0xf0f6a799…  matched 10
CLIP1   5 UP   @ 0,37 = 1,85     orderId 0x483e3686…  matched 5   (harness logou 0,38; CLOB 0,37)
CLIP2   5 UP   @ 0,36 = 1,80     orderId 0x52b5f5fb…  matched 5
Investido 9,35 | avgSum 0,935 | payout 10 | gross +0,65 | fee est −0,33 | net est +0,32
residual 0 | status CONFIRMED
```

Market: `0x39355d225c298a5ed4a298aaccfa24f214265435c71e463a012f374ca26965bc`

### 6.3 Misses / idle live

| Evento | O que aconteceu |
|---|---|
| …8600 clip | GTC open @0,56 postada, matched 0, cancel — $0 |
| …8900 / …9200 | idle (OPEN_MISS_CAP / sem banda) |
| …9800 (série “protegida”) | **OPEN_PAIR_NOT_CHEAP ×261** — hedge-ready/pair≤1 matou open — $0 |

### 6.4 Problema de reconciliação (importante para a outra IA)

Reports V0 antigos no harness às vezes têm **`orderId` vazio** no JSON → matching parcial com CLOB.  
Ex.: harness size25 reportou UP@57+DN@38; CLOB no horário próximo mostra DN@55+UP@41.  
**Priorizar CLOB** para PnL histórico; corrigir persistência de `orderId` no micro-live.

---

## 7. Travas — o que foi testado e a decisão

### 7.1 Travas que cortam lucro / mataram sessão

| Trava | Efeito medido | Decisão |
|---|---|---|
| `openRequireHedgeReady` + slack | …9800: 261× block | **OFF** no default tight |
| `openPairSumMaxAtOpen` ≤ 1,00 | Idem (`OPEN_PAIR_NOT_CHEAP`) | **OFF** no default |
| `avgSumMax` 0,95 nos clips | Recusa hedge caro (bom) | **MANTER** |
| `stopOnResidual` imediato | Ok se após escapes | Só **depois** de tentar flatten |

### 7.2 Travas inteligentes (contrato alvo)

**Entrada (qualidade):**
- banda open [52–62], trigger 55, cap +2¢
- book sum razoável (legado 0,95–1,05)
- teto notional / size
- MULT=1, 1 open

**Saída (sobrevivência) — camadas:**
1. Clips ideais @ níveis (40/36) se `proj avgSum ≤ 0,95`
2. Escape 1: residual @≤42 se `proj ≤ 0,98` (τ≲40)
3. Escape 2: residual se `proj ≤ 1,00` (τ baixo)
4. **Proibido** flatten com avgSum **> 1,00** (modo Phil 3800)
5. Se ainda residual → `stopOnResidual` (para a série)

**Operacional (manter):** cancelAll preflight/fim/SIGINT; aceitar partial fill no inventário; GTC settle 2,5–3s.

### 7.3 Residual (definição)

`residual = |shares_UP − shares_DOWN|`.  
Se > 0, PnL depende do vencedor (risco direcional). Escape existe para **hedgear mesmo “não ideal”** até avgSum 1,00 — não para travar prejuízo >0 estrutural.

---

## 8. Arquivos-chave

| Arquivo | Conteúdo |
|---|---|
| `data-backtest/labs/sandbox/pair-path-v0/engine.mjs` | Engine offline (open/hedge/clips/escape) |
| `.../mechanics-sweep.mjs` | Sweep amplo 148 variantes |
| `.../presets/clip-path-v1.json` | Preset ops deep3 |
| `.../presets/clip-path-v1-deep4.json` | Preset lab deep4 |
| `.../presets/size-fee-v0-cap2.json` | Base V0 calibrada |
| `.../MACHINE-V0.md` | Contrato Pair-Path V0 |
| `.../MACHINE-CLIP-V1.md` | Contrato Clip (lab) |
| `.../fixtures/phil-session-6-clips.json` | Scorecard Phil 6 TXT |
| `.../MICRO-REAL.md` | Como funciona micro-real |
| `data-robot/scripts/pair-path/micro-live.js` | Dry/live harness (`off|2|3|tight|deep3|deep4`) |
| `data-backtest/.tmp/clip-path-v1-ab/report.json` | Saída A/B |
| `data-backtest/.tmp/clip-path-mechanics-sweep/` | Sweep report + LEADERBOARD |

### Comandos úteis

```powershell
# Lab A/B
cd d:\Projetos\projeto-goldenlens\data-backtest
node labs/sandbox/pair-path-v0/clip-levels-ab.mjs

# Comando dry histórico — NÃO executar enquanto HOLD / PARITY GAP
cd d:\Projetos\projeto-goldenlens\data-robot
node scripts/pair-path/micro-live.js --clip=tight --open-shares=10 --max-events=2 --max-notional=16 --open-cap-cents=2

# Comando live histórico — NÃO executar; HOLD vigente e sem autorização
# docker exec pair-path-micro node scripts/pair-path/micro-live.js --live --clip=tight --max-events=1 --open-shares=10 ...
```

---

## 9. Encerramento do plano anterior

1. ~~Documentar matriz / sweep~~ — ver §4.1 + `LEADERBOARD.md`.
2. ~~Preset deep3/deep4 + escape 2-stage no micro-live~~ — `CLIP_PRESETS`.
3. ~~Dry/live deep3/deep4~~ — suspenso até fechar a lacuna de paridade.
4. Gravar `orderId`, VWAP e maker/taker no ledger permanece útil somente para
   fechar a contabilidade dos trades históricos.
5. Não existe etapa live autorizada; a etapa pendente é reconstruir o filtro
   que selecionou os quatro resultados reais.

Fora de escopo: Phil Python live; EQ com avgSum >1; caça ao “+$300” sem TXT.

---

## 10. Armadilhas para a IA auxiliar

1. **Não** copiar Phil full (MULT/escada) — lab e live mostram avgSum mediano >1 no path longo.
2. **Não** tratar “equalizou shares” como sucesso — olhar **avgSum**.
3. **Não** reativar hedge-ready/pair≤1 sem A/B novo — matou 261 opens.
4. **Não** usar PnL do harness antigo sem cruzar CLOB (orderId faltando).
5. Fee API `0` ≠ fee zero; usar modelo ou ledger real.
6. O ganho pequeno dos paths equalizados não compensa a cauda residual; não escalar.
7. O harness histórico fica em Giovanna / data-robot, mas não deve ser iniciado.
8. Nunca rodar `npm run test:order` / `--live` enquanto o status for HOLD e sem
   aprovação explícita do operador.
9. Path do coletor é `data-colector` (um `l`).
10. Preferências PowerShell: separar comandos com `;`, não `&`.

---

## 11. Glossário rápido

| Termo | Significado |
|---|---|
| avgSum | Média de custo UP + média DOWN (em $ / share) |
| residual | \|shUP − shDOWN\| |
| clip | Hedge fracionado em níveis de preço decrescentes |
| escape | Completar residual a preço pior (até teto avgSum) |
| V0 | 1 open + 1 hedge cheio |
| MULT | Multiplicador de size a cada virada (Phil) — proibido aqui |
| τ | Segundos restantes do evento BTC 5m |
| GTC settle | Posta marketable, espera N ms, cancela resto |

---

## 12. Resumo executivo atualizado

Os quatro complete-sets live são resultados reais: investimento US$ 46,95,
gross +US$ 3,05 e net estimado +US$ 1,36. O replay de 95 dias terminou antes
desses trades e aplicou o open a 64%–68% dos eventos; ele rejeita essa
generalização contínua, não a execução observada. Pair/Clip-Path continua sendo
momentum direcional com hedge condicional, mas existe uma lacuna essencial:
qual filtro/regime selecionou os quatro paths reais? A decisão atual é
**HOLD / PARITY GAP**. O próximo passo é reconstruir ledger, skips e contexto
pré-open; não há nova operação live autorizada.
