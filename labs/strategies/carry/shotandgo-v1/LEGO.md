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

Lição Doggy transferida: gate de avgSum ajuda em path ruim; em path bom o sizing clássico + DESC barato pode ganhar — não misturar sem o refine.

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

## Próximos tijolos

1. ~~Live-pair + freios + gates Doggy~~ (feitos; refuse refinado).
2. Re-captura 1 evento com refuse “só se piora”.
3. DESC: fill maker live vs resting honest.
4. Lab curto v4 + freios + gates refinados.
