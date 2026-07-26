# MIDAS Probe V1 — Probe → Confirm (anti-wipeout)

**Status:** candidata Estúdio (`midas-probe-v1` v2) · **Lab:** `labs/strategies/terminal/midas-probe-v1/` · **2026-07-26**

## Tese

O acerto no **fim real** do evento é alto; as quedas bruscas vêm de **tamanho cheio** em path que depois vira. Em vez de zonas mid-event (rejeitadas no smoke Zone), esta variante:

1. Entra **probe** barato cedo na janela terminal (τ 30–22s)
2. Se o colchão morrer / oppAsk disparar → **mata o probe** e aborta o evento (perda ~probeBudget)
3. Se em τ 18–9s o path ainda confirma → **exit probe + reentrada cheia** até settlement
4. Fallback: se o probe não disparou, `allowDirectFull` permite MIDAS clássico após a janela de probe

## Como rodar

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/midas-probe-v1/experiments/smoke-probe-july20-22.json
npm run lab:seed-presets
```

### Smoke 20–22/07

| Variante | PnL | WR | DD |
|---|---:|---:|---:|
| baseline-full | **+91** | **79%** | 26,5 |
| probe-confirm | +40 | 66% | **17,7** |
| probe-dist-kill | +45 | 73% | 25,0 |

### Validação (jun stress + jul holdout)

| Janela | baseline PnL / pior dia | probe-confirm PnL / pior dia | Δ pior dia |
|---|---|---|---|
| Jun 01–08 | +294 / **−32** | +108 / **−14** | −57% |
| Jul 01–25 | +1147 / −14 | +555 / **−7** | −50% |

Probe-confirm **reduz a cauda** (~metade do pior dia) e mantém PF ≥ 1,35; custa ~50% do PnL. Relatório completo: `labs/sandbox/midas-probe-validation-report.md`.
