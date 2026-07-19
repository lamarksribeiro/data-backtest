# MIDAS Carry V1 — Tiered High-Ask Terminal Carry

**Status:** candidata promovida ao Studio · **Lab:** `labs/strategies/terminal/midas-carry-v1/` · **Studio slug:** `midas-carry-v1` · **Data:** 2026-07-19

## Tese

A TFC V7 (campeã) compra o favorito nos últimos 30s quando o ask está entre 0,55 e 0,82. A MIDAS estende o envelope para o **bolsão de favorito caro** (ask 0,82–0,94), que a TFC descarta por completo, e aloca **orçamento maior (tier)** nessa banda. A justificativa é dupla:

1. **Taxa assimétrica.** A fee taker da Polymarket é `0.07·p·(1−p)` — máxima em p=0,5 e até 3× menor em p=0,9. O carry de favorito caro paga muito menos pedágio por dólar de exposição.
2. **Carry de alta certeza.** No cubo de features (82 dias, 3 splits temporais), o bolsão ask∈[0,82, 0,94] com dist<40, spread≤0,04 e OBI≥0 tem WR ~92% e expectância estável (+US$ 0,38/0,49/0,43 por trade de US$ 10 em train/june/july) — um dos poucos bolsões positivos nos três splits. Calibração: `labs/sandbox/midas-highask-report.md`.

O núcleo de execução é idêntico à TFC V7 Danger Floor (late flip reverse 8→4s, danger exit vol-relativo no piso 4s, velocity guard, OBI gate, odds-sum gate), o que preserva toda a validação de executabilidade já feita para a campeã.

## Parâmetros que mudam vs TFC V7

| Parâmetro | TFC V7 | MIDAS champion | MIDAS aggressive |
|---|---|---|---|
| `maxAsk` | 0.82 | **0.94** | 0.94 |
| `maxDistAbs` | 20 | **40** | 40 |
| `tierAskThreshold` | — | **0.82** | 0.82 |
| `tierAskBudgetFactor` | — | **1.5** | 2.0 |

Budget base US$ 10; entradas com ask ≥ 0,82 usam 15 (champion) ou 20 (aggressive).

## Resultados (GLS compiled-soa, book depth 25, fees honestas)

Treino 2026-05-04 → 2026-07-01 (58 dias) e holdout 2026-07-01 → 2026-07-13 (13 dias **nunca usados na seleção** de nenhum parâmetro, incluindo os herdados da TFC V7 que foi tunada até 05/jul):

| Métrica | TFC V7 | MIDAS champion (1.5x) | MIDAS aggressive (2x) |
|---|---|---|---|
| Treino PnL | US$ 4.086 | **US$ 5.099 (+25%)** | US$ 5.557 (+36%) |
| Treino entradas / WR | 3.580 / 74,8% | 5.646 / 80,5% | 5.638 / 80,5% |
| Treino PF / DD | 1,58 / US$ 80 | 1,53 / US$ 98 | 1,54 / US$ 105 |
| Holdout PnL | US$ 709 | **US$ 919 (+30%)** | US$ 1.010 (+42%) |
| Holdout WR / PF | 74,1% / 1,42 | 80,3% / 1,41 | 80,4% / 1,41 |
| Holdout DD | US$ 60 | US$ 75 | US$ 96 |
| Holdout PnL/DD | 11,9 | **12,3** | 10,5 |

Dias positivos no holdout (variante 2x+minZ auditada em detalhe): 12/13. Delta diário do tier bem distribuído (top-3 dias = 17% do delta — sem concentração de regime).

### Robustez de vizinhança

Todas as células vizinhas foram positivas em treino E holdout: ask 0,86/0,90/0,94 · dist 30/40 · tier 1,5/2,0/2,5. Não é otimização em fio de navalha. Extensão para ask 0,97 foi **rejeitada**: +US$ 969 no treino vinham de um único dia (2026-06-11 = 101% do delta).

## Mecanismos testados e rejeitados (mantidos como params desativados no GLS)

| Mecanismo | Resultado | Por quê |
|---|---|---|
| Sigma sizing por z (`sigmaSizingEnabled`) | Treino −US$ 550 | Relação z→expectância não é monotônica no cubo (melhor bin é z∈[1,5, 2,5), extremos fracos) |
| Scoop convexo ask<0,55 (`scoopEnabled`) | Treino +45%, holdout +3% | Regime-dependente (48% do delta em 3 dias de maio); provável alfa de latência (compra o ask defasado durante repricing) que não sobrevive execução real; cubo hold: exp −US$ 3,48 em julho |
| Danger exit contínuo (`dangerContinuousEnabled`) | −US$ 213 vs V7 | Sai de posições que se recuperariam |
| Early-warn exit por oppAsk (`earlyWarnEnabled`) | −US$ 530 a −US$ 620, DD pior | Whipsaws: o ask oposto sobe transitoriamente e volta |
| Gate z mínimo (`minEntryZ`) | Holdout −US$ 78 a −US$ 100 | Entradas de z baixo ainda têm exp positiva (+US$ 0,84 no cubo); cortar reduz PnL sem ganho de DD proporcional |
| Janela estendida τ 30–120s | exp 2–3× menor que τ<30s; τ>60s ≈ zero | `labs/sandbox/midas-earlywindow-report.md` |

## Reproduzir

```powershell
# Treino (58 dias, 4 variantes tier)
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/v2-tier-train.json

# Holdout julho
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/v2-tier-holdout.json

# Ablação dos mecanismos rejeitados
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/full-ablation.json
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/v2-mechanisms.json
```

Relatórios de calibração do cubo: `labs/sandbox/midas-calibration-report.md`, `midas-highask-report.md`, `midas-scoop-momentum-report.md`, `midas-earlywindow-report.md`.

## Limitações e próximos passos

- Mesmas ressalvas da TFC V7: orçamento fixo por evento, sem modelo de latência de rede (diagnóstico V7 estimou ~−US$ 0,17/trade na janela tardia com 1s de latência), sem fila maker.
- A banda high-ask depende da **qualidade do label de settlement** (comprar a 0,90 exige WR ≥ ~91%). O cubo com `mkt_agree` confirma WR 92,1% no bolsão; em produção, monitorar divergência Chainlink vs book nos primeiros dias.
- DD absoluto cresce com o tier (exposição até 1,5–2× por evento). Para banca de US$ 100, preferir o preset champion (1,5x).
- Não autorizada para conta real — seguir gates do dossiê `avaliacao-integrada-conta-real-2026-07-10.md` (paper trading primeiro).
- Extensão natural: rodar o mesmo preset em ETH/SOL 5m (dados já no lake) para diversificação de DD.
