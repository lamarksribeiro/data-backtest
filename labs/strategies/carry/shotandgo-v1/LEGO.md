# Shotandgo Lego — recomeço sem vícios

## Achado central (por que o lab “mentia”)

O colega opera **`Phil_Hopper_Real_v4.py`**, não o sizing do lab:

| | Lab / Phil “clássico” | **v4 live (ganhou ~$100)** |
|---|---|---|
| `SHARES_SUB` | `[20,15,10,10,5,5,1,1]` | `[4,4,4,5,5,6,8,11]` |
| `SHARES_DESC` | `[5,5,5,5,5,5,5,5]` | `[3,3,3,4,4,5,7,10]` |
| Invariante | **quebra** nos idx 5–8 (SUB ≤ DESC) | **SUB[i] > DESC[i]** sempre |
| Teto | $500 | $250 |
| DRY | — | `DRY_RUN=False` (real) |

Comentário do próprio v4:

> Se DESC ≥ SUB, o lado barato termina com MAIS shares e a EQ compra o lado **caro** — inverte a lógica e destrói o edge.

O lab mai–jun (−$134k) usou o sizing **clássico quebrado**. Paridade shadow OK só prova que o runner copia o Phil; **não** prova a tese econômica do v4.

## Essência em peças (Lego)

1. **EQ edge** — `PnL ≈ shares × (1 − avgUp − avgDn)`; EQ deve comprar o **barato** (menos shares).
2. **Sizing** — `SUB[i] > DESC[i]` em todo degrau.
3. **Grade** — SUB sobe / DESC desce + re-arme do par.
4. **MULT / contagio / PISO / STOP** — só depois do sizing certo.
5. **Execução** — live maker DESC ≠ dry resting lab (próximo).
6. **Live pair** — shadow REST sem parquet (`shotandgo-live-shadow-pair.mjs`).

## Simulações já rodadas

```powershell
node labs/sandbox/shotandgo-lego-sim.mjs --piece all
```

- Peça 2: classic **FALHA** invariante (4 degraus); v4 **PASS**.
- Peça 4: classic com DESC pesado → EQ compra UP caro → destrói.
- Peça 3 (path sintético): ambos podem lucrar num path “bonito”; o veneno é o regime em massa com fundos invertidos.

## Live pareado (sem parquet)

```powershell
node labs/sandbox/shotandgo-live-shadow-pair.mjs --seconds 280
node labs/sandbox/shotandgo-live-shadow-pair.mjs --full-event --min-tau 200
```

Freios ativos no Lego (espelho Phil): teto ($500 / **$250** v4), MAX_VIRADAS=6, STOP@4, PISO@4–5, EQ ignora teto.

### Amostra curta `…1785103500` (últimos ~20s, sem freios)

| | classic | v4 |
|---|---|---|
| Investido | $249 | $107 |
| Soma médias | **127¢** | 119¢ |

### Sem freios `…1785104100` (τ≈227→0)

Ambos EQ com 6 viradas; Lego **sem** teto → v4 investiu $413:

| | classic | v4 |
|---|---|---|
| Investido | $686 | $413 |
| PnL EQ | −$34 | −$36 |

### Com freios `…1785104700` (`*.live-pair-brakes.json`)

| | classic | **v4** |
|---|---|---|
| Investido | (teto $500) | **$168** (teto $250 OK) |
| Viradas / exit | 6 / equalized | 6 / equalized |
| Soma médias | — | 109,1¢ |
| PnL | −$38,89 | **−$14,06** |
| Δ v4−classic | | **+$24,83** |

Teto + sizing v4 cortaram blast radius no mesmo book; ambos ainda negativos neste evento.

### Gates Doggy `…1785105300` (`*.live-pair-gates.json`)

Três motores no mesmo book: classic | v4 | **v4-gates** (`refuseAvgSum=1.02`, MULT só underweight, late vacuum ≤15¢).

| | classic | v4 | v4-gates |
|---|---|---|---|
| Investido | $59,50 | $46,22 | $47,26 |
| Soma médias | **88,8¢** | 98,3¢ | 100,6¢ |
| PnL | **+$7,50** | +$0,78 | +$0,00 |
| Blocks | — | — | REFUSE×295 |

Path **bom** (avgSum&lt;1): classic ganhou; gates absolutas **atrasaram** scoops (Δ gates−v4 = −$0,78). Ajuste: refuse só se `proj` **não melhora** e fica &gt;1,02 (já no código).

### Refuse refinado + DESC honest `…1785107400` (`*.live-pair-desc.json`)

| | classic | v4 | v4-gates | v4-gates-honest |
|---|---|---|---|---|
| Investido | $56,61 | $45,72 | $36,90 | $46,51 |
| avgSum | **84,5¢** | 97,3¢ | 100,6¢ | **95,3¢** |
| Exit | EQ | EQ | aberto 39/36 | aberto 57/47 |
| PnL | **+$10,39** | +$1,28 | ~$0 (sem EQ) | (odds; Δ vs gates ≈0) |
| DESC | opt | opt | opt | placed 8 · fill 6 · miss 1 · TO 1 |
| REFUSE | — | — | ×148 | ×11 |

Achados:
1. Em path bom (1 virada, DESC barato), **classic sizing ainda vence** no Lego optimistic.
2. Refuse refinado ainda corta demais no optimistic-gates (148×) e impede EQ.
3. DESC honest: 6/8 fills reais por atravessamento — avgSum **melhor** que optimistic-gates (95 vs 101), mas residual aberto (sem EQ).
4. Próximo lab deve usar `executionMode=honest` no DESC; optimistic infla edge em paths bons.

## Smoke 2 dias (jun 15–16) — classic vs v4

| Variante | PnL | PF | Win% |
|---|---|---|---|
| **v4-shares** | −$1 181 | 0,48 | 60% |
| classic-shares | −$2 041 | 0,64 | 62% |

## Ablação MULT × sizing v4 (jun 10–16, honest+fees)

| Rank | Variante | PnL | PF | Win% | DD |
|---|---|---|---|---|---|
| 1 | **v4-mult-flat1** | −$3 052 | 0,46 | 52% | $827 |
| 2 | v4-mult-full | −$4 570 | 0,41 | 58% | $1 530 |
| 3 | classic-mult-flat1 | −$4 974 | 0,63 | 48% | $1 710 |

Achado: no sizing v4, **tirar MULT/contagio corta ~$1,5k de prejuízo** em 7d (ainda negativo). Flat no classic quebrado continua pior em PnL absoluto. Gate PF≥1,2 / PnL>0: **FAIL** nas três.

## Lab curto v4 + honest (jun 14–16)

Experimento `v4-honest-short.json` — sizing v4 + freios + DESC honest; ± MULT flat.

| Rank | Variante | PnL | PF | Win% | DD |
|---|---|---|---|---|---|
| 1 | **v4-honest-flat** | −$1 237 | 0,51 | 55% | $466 |
| 2 | classic-honest-flat | −$1 556 | 0,73 | 50% | $782 |
| 3 | v4-honest-mult | −$1 743 | 0,48 | 60% | $678 |

Mesma ordem da ablação anterior: v4+flat melhor, MULT piora, classic flat no meio. **Ainda negativo** sob honest+fees — gate FAIL. Desc honest sozinho não fecha o gap live.

## Fill quality Phil shadow vs Doggy

Script: `labs/sandbox/shotandgo-fill-quality.mjs` → `shadow/FILL-QUALITY.json`  
Fonte: 5 shadows Phil DRY (122 fills), join fill×tick (lag med 0ms).

| Cohort | med fill−ask | ≤ask | ≤ask−1¢ | walk >1¢ | Σ edge vs ask |
|---|---:|---:|---:|---:|---:|
| **Doggy live** (benchmark) | **−0,7¢** | ~high | 46% | 25% | +$ |
| Phil SUB (dry) | **0,0¢** | 79% | 5% | 15% | −$14 |
| Phil DESC (dry optimistic) | **+1,0¢** | 40% | 6% | **59%** | −$6 |
| Phil all | 0,0¢ | 62% | 5% | 34% | −$19 |

Leitura: no dry, SUB cola no ask (sem melhoria Doggy); DESC optimistic **preenche no nível** mesmo com ask já abaixo → paga caro vs book. Isso **infla perda** no Lego optimistic e **não** explica o +$100 live do colega (que seria DESC maker real + talvez fill≤ask). Precisa shadow **real** (wallet do colega / `DRY_RUN=False` mínimo) para fechar.

## Próximos tijolos

1. ~~Fill quality dry~~.
2. Shadow live real: wallet do Phil/colega (activity×book) ou 1 evento `DRY_RUN=False` mínimo.
3. Calibrar refuse/vacuum só depois do fill real.
