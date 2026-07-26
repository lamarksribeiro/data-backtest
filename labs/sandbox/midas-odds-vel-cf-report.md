# MIDAS — auditoria contrafactual #1 (oddsVelGate)

**Data:** 2026-07-26  
**Gate auditado:** `oddsVelMaxDelta=0.10`, lookback 2s  
**Artefatos:**
- `midas-odds-vel-cf-july-d10.md` / `train-d10.md` / `compare.md`
- `midas-odds-vel-cf-july-defer-d10.md` (+ train-defer quando pronto)

## Pergunta

Os trades que o gate remove são losses (TP) ou wins (FP)? O ganho de julho (+118) vem de pular ou de entrar diferente?

## Julho — skip puro (baseline entrou, gated não)

| | n | PnL se tivesse entrado |
|---|---:|---:|
| TP (evitou loss) | 14 | −106.57 |
| FP (perdeu win) | 39 | +147.38 |
| Total skipped | 53 | **+40.82** |

- Precisão TP/n = **26%**
- Net de só bloquear = **−40.82** (bloquear sozinho **prejudica**)
- TP concentra em ask **&lt;0.70** e dist **30–40**
- FP concentra em ask **0.70–0.82** (27 dos 39)

## Julho — decomposição do +118 (skip vs defer)

| componente | n | efeito no ΔPnL |
|---|---:|---:|
| SKIP | 53 | **−40.82** |
| **DEFER** (mesmo evento, entrada depois) | **248** | **+159.14** |
| identical | 2061 | 0 |
| **Δ total** | — | **+118.33** |

O gate **adia** a entrada (~3,6s mais tarde, ask +0,04 em média). Isso explica todo o alfa de julho — não o bloqueio.

## Treino — skip

| | n | PnL se entrasse |
|---|---:|---:|
| TP | 20 | −189.92 |
| FP | 79 | +336.06 |
| Total | 99 | **+146.14** |

- Precisão **20%**
- Net de bloquear = **−146**
- ΔPnL gated−base = **−364**

## Treino — decomposição skip vs defer (maio–junho completo)

| componente | n | efeito no ΔPnL |
|---|---:|---:|
| SKIP | 99 | **−146** |
| **DEFER** | **432** | **−217** |
| **Δ total** | — | **−364** |

Contraste com julho: no treino o **DEFER também prejudica** (improved 108 vs worsened 287). Adiar entrada não é alfa universal — só ajudou no regime de julho.

## Slices de SKIP com net positivo (sementes do item 2)

Só nos 53 skipped de julho — candidatos a **gate condicional**:

| condição | n | TP | FP | net se skip |
|---|---:|---:|---:|---:|
| ask&lt;0.70 **ou** dist≥30 | 21 | 12 | 9 | **+29.23** |
| dist≥30 | 6 | 3 | 3 | **+22.78** |
| ask&lt;0.70 e τ≥12s | 12 | 8 | 4 | **+16.54** |
| ask&lt;0.70 | 15 | 9 | 6 | **+6.45** |
| ask 0.70–0.82 | 31 | 4 | 27 | **−49.45** |

## Conclusões para a fila de testes

1. **Não promover block genérico** — precisão baixa; FP &gt; TP em volume de PnL.
2. **O valor real em julho é DEFER** (esperar o book acalmar) — investigar se dá para capturar defer sem o skip caro (ex.: “pause entry while velocity high, allow retry” explícito).
3. **Próximo (item 2):** gates condicionais `ask&lt;0.70 | dist≥30` e variantes — validar no lab, não só no subset skipped.
4. **Item 3 (size-halve)** continua atrativo: nos FP de ask 0.70–0.82 o block é o pior.

## Reproduzir

```powershell
node --max-old-space-size=12288 labs/sandbox/midas-odds-vel-counterfactual.mjs --delta 0.10 --only both
node --max-old-space-size=8192 labs/sandbox/midas-odds-vel-cf-defer.mjs --from 2026-07-01 --to 2026-07-26 --delta 0.10 --tag july-defer-d10
node --max-old-space-size=12288 labs/sandbox/midas-odds-vel-cf-defer.mjs --from 2026-05-04 --to 2026-07-01 --delta 0.10 --tag train-defer-d10
```
