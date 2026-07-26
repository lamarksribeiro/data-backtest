# Relatório de paridade — shadow → runner Shotandgo

**Data:** 2026-07-26  
**Pacote Phil live:** `polymarket-fm/logs/shadow/btc-updown-5m-1785096300.json`  
**Fonte:** `Phil_Hopper_Real.py` simulação (sem conector; DRY walk-the-book) · evento BTC 5m 2026-07-26 16:05–16:10 ET  
**Replay:** `node labs/sandbox/shotandgo-shadow-replay.mjs --shadow ..\polymarket-fm\logs\shadow\btc-updown-5m-1785096300.json`

## Resultado — Phil live vs runner `optimistic`

| Métrica | Shadow (Phil) | Runner | |
|---|---|---|---|
| Fills | 17 | 17 | OK |
| Seq (lado\|tipo) | idêntica | idêntica | PASS |
| Shares UP/DOWN | 67/67 | 67/67 | OK |
| Equalizou | true | true | OK |
| Viradas | 1 | 1 | OK |
| PnL | $2.51 | $2.50 | Δ=$0.01 |

**Veredito:** PASS (critério do plano: mesma sequência; |ΔPnL| ≪ $0,50).

`executionMode=optimistic` alinha ao dry do Phil (DESC preenche no nível na hora; SUB usa book do tick).

## Runner `honest` no mesmo pacote

FAIL esperado: 17 vs 14 fills, sequência DESC diverge (resting vs fill imediato dry), |ΔPnL|≈$3,99. Confirma que lab em massa em `honest` **não** é o mesmo modo do dry shadow — próximo passo é micro-real ou calibrar DESC resting no Phil.

## Plumbing (lake / synth)

| Pacote | Modo | Resultado |
|---|---|---|
| `btc-updown-5m-1780272600` lake-bootstrap | optimistic | PASS self-check |
| `btc-updown-5m-1781532000` synth | optimistic | PASS self-check |

## Comandos

```powershell
cd d:\Projetos\projeto-goldenlens\polymarket-fm
python Phil_Hopper_Real.py   # SHADOW_CAPTURE + SHADOW_EXIT_AFTER=1

cd d:\Projetos\projeto-goldenlens\data-backtest
node labs/sandbox/shotandgo-shadow-replay.mjs --shadow ..\polymarket-fm\logs\shadow\btc-updown-5m-1785096300.json
```
