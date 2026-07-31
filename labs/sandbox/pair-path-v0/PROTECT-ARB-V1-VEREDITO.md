# Protect + Arb V1 — veredito discovery

**Rodado:** 2026-07-30  
**Janela:** 2026-04-23 → 2026-06-30 · 17.848 eventos elegíveis  
**Artefato:** `.tmp/protect-arb-v1-discovery/report.json`

## Tabela

| Variant | Opens | Resid% | PnL | Worst | PF | Notas |
|---------|------:|-------:|----:|------:|---:|------|
| v0-naked | 6258 | 14.1 | −1619 | −2.94 | 0.32 | igual ao live: residual dói |
| prot-sell | 6258 | **0** | −1471 | **−1.36** | 0.01 | corta cauda; PnL ainda negativo |
| prot-hedge | 6258 | 0 | −1692 | −2.94 | 0.06 | pior que naked |
| **prot-min** | 6258 | **0** | **−1471** | **−1.36** | 0.01 | ≈ sell (escolhe SELL quase sempre) |
| prot-min-ready | 1 | 0 | −0.47 | −0.47 | 0 | hedge-ready esteriliza opens |
| arb-atomic | 10 | 0 | **+8.31** | +0.13 | ∞ | raro; edge real quando existe |
| arb-pair-gate | 0 | — | 0 | — | — | I1 default vazio (HOLD conhecido) |

## Validação (2026-07-01 → 2026-07-28, 7.231 evt)

Mesmo padrão: `prot-min` ≈ `prot-sell`, residual 0%, worst melhor (−1,51 vs −2,94), PnL ainda negativo (−611 vs naked −644). Atomic: 2 trades +0,75. Pair-Gate: 0.

## Gates proteção

- `prot-min`: **PASS** (residual 0%, worst ≥ −openNotional, PnL ≥ floor vs naked) — discovery e validation
- `prot-min-ready`: **PASS** técnico discovery / **FAIL** validation (0 opens) — **não operacional**

## Leitura

1. **Proteção funciona como seguro, não como edge:** zera residual e melhora worst (~−1,36 vs −2,94), mas a política V0 contínua continua perdedora.
2. **min ≈ sell** no lake L1: o bid do open quase sempre perde menos que completar par caro.
3. **Arb atômico** é a única variante com PnL positivo, com **n=10** discovery (+8,31) — confirma “par barato simultâneo é raro”.
4. **Pair-Gate default** (ε=2, hedge≤42) → 0 opens — alinhado a `PAIR-GATE-V1-ETAPA-A.md`.

## Calibração gatilhos (2026-07-30)

Gatilhos compostos implementados (live + engine): timeout **45s**, adverse fav **4¢**,
opp além de `hedgeAskMax` desde open, force-τ **≤20s**. Proteção só dispara se
**≥1** gatilho ativo (hedge barato ainda bloqueia, exceto force-τ).

| Suite | Resultado |
|-------|-----------|
| `pair-path-protect-policy.test.js` | 9/9 pass |
| `protect-arb-engine.test.mjs` | 12/12 pass |

**Journal smoke** (14 eventos, `.tmp/poly-baliza/`):

| Variant | Opens | PnL | ProtS/H |
|---------|------:|----:|--------:|
| v0-naked | 10 | **+0,71** | 0/0 |
| prot-min (calibrado) | 10 | −0,71 | **3/0** |

Leitura: calibração evita flatten imediato (caso dry DOWN@0,58→SELL@0,57 não
dispara mais). Apenas **3** flattens no journal vs proteção instantânea em quase
todo open. Neste conjunto o naked ainda equalizou naturalmente e ficou melhor —
proteção calibrada é seguro, não edge.

## Próximo passo

| Ação | Status |
|------|--------|
| Dry `--protect=min` no micro-live | **CONCLUÍDO** em 2026-07-30 |
| Calibração timeout/adverse/force-τ | **CONCLUÍDO** em 2026-07-30 |
| Dry Giovanna com gatilhos calibrados | **CONCLUÍDO** em 2026-07-30 |
| Live proteção | **HOLD econômico** — seguro ok, edge não comprovado |
| Live arb | **não** — n atômico insuficiente; Pair-Gate HOLD |

## Dry Giovanna (pós-calibração, 2026-07-30)

Comando: `--clip=off --protect=min --open-shares=5 --max-events=2 --open-cap-cents=2`
(defaults: timeout=45s, adverse=4¢, force-τ≤20).

| Evento | Resultado | ProtS/H | PnL |
|--------|-----------|--------:|----:|
| 1 (`…8900`) | 0 opens (`OPEN_MISS_CAP`×3) | 0/0 | 0 |
| 2 (`…9200`) | OPEN UP@0,55 + HEDGE DN@0,41, avgSum=0,96 | **0/0** | **+0,03** |

**Leitura:** gatilhos calibrados não dispararam flatten prematuro. O evento 2 seguiu
o caminho bom (open + hedge barato) sem proteção. Evento 1 não abriu por cap+2¢
(mercado fora da faixa favorito). **HOLD live** mantido — mecânica validada, edge
ainda não comprovado em escala.

## Dry Giovanna (pré-calibração)

- Campanha-alvo, cap+2¢, 2 eventos: **0 opens**, `OPEN_MISS_CAP` em ambos.
- Smoke mecânico, cap+7¢, 1 evento:
  `OPEN DOWN@0,58×5 → PROTECT SELL DOWN@0,57×5`.
- Resultado simulado: residual **0**, realized **−US$ 0,221**.
- Esse caso **não** ocorre com gatilhos calibrados (queda 1¢ < 4¢, timeout não
  atingido). Repetir dry na Giovanna com flags default antes de reconsiderar live.
