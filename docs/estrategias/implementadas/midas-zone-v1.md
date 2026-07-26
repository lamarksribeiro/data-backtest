# MIDAS Zone V1 — Mini-terminais artificiais no mesmo evento

**Status:** experimental (lab) · **Lab:** `labs/strategies/terminal/midas-zone-v1/` · **Studio slug:** `midas-zone-v1` · **Data:** 2026-07-26

## Tese

A MIDAS clássica opera só no **fim real** do evento 5m (últimos ~30s). Esta variante testa se o mesmo envelope de carry (favorito, ask, z, OBI, late-flip) continua rentável quando o evento é fatiado em **zonas artificiais** com início/fim marcados — cada zona vira um mini-terminal.

Hipótese: há mais de uma janela de carry utilizável por evento; o custo é o exit mark-to-market nas fronteiras (spread + fee) antes do settlement.

## Dois modos

| Modo | `zoneMode` | Como define as zonas |
|---|---|---|
| **Fixo** | `0` | `zoneCount` partições iguais de `eventDurationSecs` (ex.: 3×100s) |
| **Adaptativo** | `1` | Após `zoneWarmupSecs`, mede σ; σ alta → zonas mais longas (menos mini-terminais); σ baixa → zonas mais curtas |

Em ambos, o **z-score** e a janela de entrada usam `zoneSecsLeft` (τ artificial), não só o tempo até o fim real.

## Por que exit na fronteira

O simulador GLS só permite **1 posição aberta**. Sem `zone_boundary_exit` ao trocar de zona, a 2ª+ `enter()` falha em silêncio. A última zona pode segurar até o settlement (`holdLastZoneToSettle`).

## Parâmetros-chave

| Parâmetro | Default | Papel |
|---|---|---|
| `zoneCount` | 3 | Nº de zonas (modo fixo; máx. 5) |
| `zoneMode` | 0 | 0=fixo · 1=adaptativo |
| `zoneWarmupSecs` | 45 | Espera antes do plano adaptativo |
| `zoneExitEnabled` | true | Fecha na fronteira |
| `holdLastZoneToSettle` | true | Última zona não força exit |
| `maxEventBudget` | 20 | Teto de USD alocado no evento |
| Envelope MIDAS | ask 0.55–0.94, dist 40, tier 1.5× | Igual espírito do carry |

`zoneCount=1` + `zoneExitEnabled=false` ≈ baseline MIDAS (só terminal real).

## Como rodar

```powershell
# Smoke 20–22/07 (5 variantes)
npm run lab:run -- --experiment labs/strategies/terminal/midas-zone-v1/experiments/smoke-zone-july20-22.json

# Holdout 01–18/07
npm run lab:run -- --experiment labs/strategies/terminal/midas-zone-v1/experiments/holdout-zone-july.json

# Preset único
npm run lab:run-preset -- --preset btc-zone-3-fixed --strategy midas-zone-v1 --strategy-family terminal --from 2026-07-20 --to 2026-07-22 --daily-metrics

# Seed no Estúdio
npm run lab:seed-presets
```

## Leitura dos resultados

- **Entries ≫ baseline** com PnL/PF estáveis → zonas agregam edge.
- **Entries sobem e PF cai** → overtrading / custo de exit na fronteira.
- **Adaptativo vs fixo-3** → se σ no warmup prevê bem o nº de zonas úteis.

### Smoke 20–22/07 (lab operacional)

| Variante | PnL | WR | PF |
|---|---:|---:|---:|
| zone-1-baseline | **+91** | **79%** | **1,41** |
| zone-2/3/4 + adaptive | −136 a −212 | ~38–45% | ~0,43–0,61 |

Conclusão preliminar: multi-zona com exit na fronteira **não** replica o edge do terminal real. Relatório: `labs/sandbox/midas-zone-smoke-report.md`.
