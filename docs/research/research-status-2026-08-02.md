# Research status — descoberta de teoria (2026-08-02)

## Objetivo

Inventar teoria matemática **nova e válida** para BTC Up/Down 5m (e alts) na Polymarket, com caminho até vantagem líquida.

## O que foi feito nesta sequência

| Etapa | Artefato | Resultado |
|---|---|---|
| Charter OJD | `docs/research/ojd-v0-research-charter.md` | Programa formal |
| Fase I jump-share | `labs/sandbox/ojd/phase1-anomaly*.json` | **KILL** |
| Pós-jump residual | `phase1b-postjump.json` | **KILL** |
| Mapa do lake | `docs/research/lake-data-map.md` | Inventário ~14GB, 7 assets |
| Screen cubo | `cube-residual-screen.json` | Book calibrado; 0 seeds estáveis |
| Pivot C odds-path | `phase1c-odds-path-*-*.json` + multi | **KILL** BTC/ETH/SOL |
| **Pivot D Binance lead** | `phase1d-binance-lead-2026-05-04_2026-06-05.json` | **PROCEED Phase II** |

## Conclusão científica intermediária

### Morto: física do oráculo vs book

O **ask da Polymarket é um estimador de probabilidade terminal muito forte** quando só se usa o lake (oráculo + book):

- Brier do book ~0.13–0.14
- Modelos físicos (RV/BV, path digital, elasticidade) **sistematicamente piores**
- Padrão **replica em ETH e SOL**

### Vivo: lead Binance (Pivot D) — Phase II

Com Binance 1s real (não o `underlying_price` do lake):

| Janela | n | strong_up resid | strong_down resid | valid | Decisão |
|---|---:|---:|---:|---|---|
| 05-15→05-22 (piloto) | 6.4k | +7.3 pp | −10.7 pp | PASS | PROCEED |
| **05-04→06-05** | **25.0k** | **+6.6 pp** | **−6.9 pp** | **PASS** | **PROCEED** |

- Stale book (impulso forte + odds paradas): gap up−dn **~12–13 pp** no valid
- corr(impulse → Δask 2s) **~0.27** (path)
- Brier **global** quase igual ao book → edge é **nos impulsos**, não em média

## Mapa de estado do programa

| ID | Teoria | Status |
|---|---|---|
| A | OJD jump-share | KILL |
| B | Pós-jump residual (oracle) | KILL |
| C | Odds-path elasticity (oracle) | KILL BTC/ETH/SOL |
| **D** | **Binance lead residual** | **PROCEED Phase II** |
| Lake map | inventário | feito |

## Comandos úteis

```bash
node labs/sandbox/ojd/map-lake-inventory.mjs
node --max-old-space-size=8192 labs/sandbox/ojd/phase1c-odds-path.mjs --multi
node --max-old-space-size=8192 labs/sandbox/ojd/phase1d-binance-lead.mjs --from 2026-05-04 --to 2026-06-05
```

## Phase II LADM — executada

| Métrica holdout | Valor |
|---|---|
| Ψ | \(a\approx0.081\), \(s=2.5\) |
| Brier \|Z\|≥1.5 | LADM 0.151 vs mkt 0.156 |
| Trades LADM | 368 |
| Net pós-fees (stake $10) | **+$796** |
| PF | **1.36** |
| MaxDD | $169 |
| vs impulse-only | idêntico (policy) |
| vs hyperion-like | LADM bem melhor no net |
| Verdict | **GO-CANDIDATE** |

Artefatos: `phase2-ladm-2026-05-04_2026-06-05.*`, `docs/estrategias/nao-implementadas/ladm-v0.md`

### Phase II+ executada (2026-05-04 → 07-15)

| Item | Valor |
|---|---|
| Range | 73 dias, ~75k snaps |
| Ψ | a≈0.081, s=3, ψ(1.5)≈0.037 |
| Legacy impulse holdout | n=819, net **+$1318**, PF **1.28** |
| **ladm_edge** (z≥1.25, minEdge=0.05, ask≤0.55) | n=423 vs imp 772; net **+$1013** vs +$533; PF **1.35** vs 1.10 |
| **ladm_combo** | net **+$1247**, PF **1.35** |
| Best combo askMax=0.7 | n=554, net **+$1519**, PF **1.39** |
| sets_differ | **true** |
| Verdict | **GO-CANDIDATE** (diferenciado) |

Artefatos: `phase2b-ladm-diff-2026-05-04_2026-07-15.*`

### Próximo

1. Runner SOA + join Binance em tempo real  
2. Shadow/dry-run com latência  
3. (Opcional) Kelly fracionário sobre size∝‖Ψ‖
