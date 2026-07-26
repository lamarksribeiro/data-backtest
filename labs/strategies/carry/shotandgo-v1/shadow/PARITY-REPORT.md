# Relatório de paridade — shadow → runner Shotandgo

**Atualizado:** 2026-07-26

## Protocolo atual

- Phil: `DESC_DRY_RESTING=True` + `SHADOW_TICK_STRIDE=1` + `SHADOW_EXIT_AFTER=1`
- Replay: `config.desc_dry_resting` → `executionMode=honest`
- Critério: seq `(lado|tipo)` idêntica; |ΔPnL| &lt; max($0,50, 5% notional)

## Evento C — gate (DESC resting + stride=1) ✅

| | |
|---|---|
| Pacote | `polymarket-fm/logs/shadow/btc-updown-5m-1785098100.json` |
| Ticks / fills | 2935 / 20 |
| Modo | **honest** |
| Seq | idêntica |
| Shares | 142/147 = 142/147 |
| Equalizou / viradas | true / 2 |
| PnL | $10.78 vs $10.72 (Δ **$0.06**) |
| **Veredito** | **PASS** |

## Evento A — legado (DESC otimista)

| | |
|---|---|
| Pacote | `btc-updown-5m-1785096300.json` |
| `optimistic` | PASS (Δ $0.01) |
| `honest` | FAIL (DESC imediato ≠ resting) |

## Evento B — inválido (stride=5)

`btc-updown-5m-1785097500.json` — FAIL. Stride&gt;1 omite ticks de decisão; não usar como gate.

## Próximos passos

1. Opcional: 2º evento stride=1 confirmando PASS
2. Micro-real (`DRY_RUN=False`) quando houver conector + `.env`
3. Lab mai–jun em `honest`

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node labs/sandbox/shotandgo-shadow-replay.mjs --shadow ..\polymarket-fm\logs\shadow\btc-updown-5m-1785098100.json
```
