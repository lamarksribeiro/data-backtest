# MIDAS Carry V1 — Tiered High-Ask Terminal Carry

**Status:** candidata promovida ao Studio · **Lab:** `labs/strategies/terminal/midas-carry-v1/` · **Studio slug:** `midas-carry-v1` · **Data:** 2026-07-19

## Tese

A TFC V7 (campeã) compra o favorito nos últimos 30s quando o ask está entre 0,55 e 0,82. A MIDAS estende o envelope para o **bolsão de favorito caro** (ask 0,82–0,94), que a TFC descarta por completo, e aloca **orçamento maior (tier)** nessa banda. A justificativa é dupla:

1. **Taxa assimétrica.** A fee taker da Polymarket é `0.07·p·(1−p)` — máxima em p=0,5 e até 3× menor em p=0,9. O carry de favorito caro paga muito menos pedágio por dólar de exposição.
2. **Carry de alta certeza.** No cubo de features (82 dias, 3 splits temporais), o bolsão ask∈[0,82, 0,94] com dist<40, spread≤0,04 e OBI≥0 tem WR ~92% e expectância estável (+US$ 0,38/0,49/0,43 por trade de US$ 10 em train/june/july) — um dos poucos bolsões positivos nos três splits. Calibração: `labs/sandbox/midas-highask-report.md`.

O núcleo de execução é idêntico à TFC V7 Danger Floor (late flip reverse 8→4s, danger exit vol-relativo no piso 4s, velocity guard, OBI gate, odds-sum gate), o que preserva toda a validação de executabilidade já feita para a campeã.

## Parâmetros que mudam vs TFC V7

| Parâmetro | TFC V7 | MIDAS champion (v1) | MIDAS aggressive (v2) | MIDAS robust (v3) |
|---|---|---|---|---|
| `maxAsk` | 0.82 | **0.94** | 0.94 | 0.94 |
| `maxDistAbs` | 20 | **40** | 40 | **30** |
| `tierAskThreshold` | — | **0.82** | 0.82 | 0.82 |
| `tierAskBudgetFactor` | — | **1.5** | **2.0** | **1.5** |

Budget base US$ 10; entradas com ask ≥ 0,82 usam 15 (champion/robust) ou 20 (aggressive).

### Presets micro (paridade data-robot)

| Preset | Base / teto | Envelope | Uso |
|---|---|---|---|
| `btc-micro-robust-v1` | US$ 2 / US$ 3 | Robust (dist 30, tier 1.5×) | Estúdio **v4** · canário conservador |
| `btc-micro-aggressive-v1` | US$ 2 / US$ 4 | Aggressive (dist 40, tier 2.0×) | Estúdio **v5** · **igual ao canário do data-robot** |

Núcleo vencedor nos dois micros: late flip exit/reverse + danger exit no piso 4s + gates TFC (velocity, OBI, odds-sum, spread). Mecanismos rejeitados permanecem **OFF** (sigma sizing, scoop, danger contínuo, early-warn, `minEntryZ`, equity scale).

```powershell
npm run lab:run-preset -- --preset btc-micro-aggressive-v1 --strategy midas-carry-v1 --strategy-family terminal --from 2026-07-01 --to 2026-07-07 --daily-metrics
```

## Resultados (GLS compiled-soa, book depth 25, fees honestas)

Treino 2026-05-04 → 2026-07-01 e holdout de referência (champion/aggressive: 01–13/07; robust: 01–18/07 no lab de robustez):

| Métrica | TFC V7 | Champion (v1) | Aggressive (v2) | Robust (v3) |
|---|---|---|---|---|
| Treino PnL | US$ 4.086 | **US$ 5.099** | US$ 5.557 | US$ 4.969 |
| Treino PF / DD | 1,58 / US$ 80 | 1,53 / US$ 98 | 1,54 / US$ 105 | **1,55 / US$ 81** |
| Holdout PnL | US$ 709* | US$ 919* | US$ 1.010* | US$ 1.397† |
| Holdout DD | US$ 60* | US$ 75* | US$ 96* | **US$ 68†** |

\* holdout 01–13/07 (doc original). † holdout 01–18/07 do lab `robustness-mitigations` (champion na mesma janela: PnL US$ 1.460 / DD US$ 75).

### Robust (v3) vs Champion — lab de robustez 2026-07-21

| Janela | ΔPnL | ΔDD | Leitura |
|---|---:|---:|---|
| Treino 59d | −2,6% | **−17%** | Pouco PnL a menos, DD bem menor |
| Holdout 18d | −4,3% | **−9%** | Mesmo padrão |
| Stress 01–07/06 | **+US$ 20** | ≈0 | Única variante acima do champion nessa semana |

Exit-only / desligar reverse foi **rejeitado**: melhora o dia 02/06 mas custa −US$ 829 no treino (−US$ 221 no holdout).

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

## Equity scale (experimental, desligado nos presets)

Parâmetros opcionais para **aumentar o orçamento conforme a banca cresce** (compound), com piso em `entryBudget` e teto em `maxEntryBudget`:

| Parâmetro | Default | Papel |
|---|---|---|
| `equityScaleEnabled` | `false` | Liga o compound |
| `equityScalePct` | `0.10` | Fração da equity corrente (10% → US$ 10 em banca US$ 100) |
| `maxEntryBudget` | `30` | Teto absoluto por entrada |

```text
equity = max(0, walletSize + totalPnl)
raw    = equityScaleEnabled ? max(entryBudget, equity × equityScalePct) : entryBudget
budget = min(raw × budgetFactor, maxEntryBudget, equity)
```

- **Desligado** (`equityScaleEnabled: false`): comportamento idêntico ao sizing fixo validado.
- **Ligado**: aposta sobe com lucro acumulado; cai automaticamente quando a equity não cobre.
- O tier high-ask (`tierAskBudgetFactor`) continua multiplicando depois do `raw`.
- Late flip reverse herda `entryBudgetUsed` da entrada real.

**Importante:** experimentos com equity scale exigem `dailyMetrics: false` (single-pass contínuo). O modo chunked reinicia a banca por dia e invalida o compound (lição Hopper).

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/equity-scale-train.json
```

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

- Presets promovidos usam orçamento fixo por evento (`equityScaleEnabled: false`). O equity scale é mecanismo experimental a validar em single-pass.
- A banda high-ask depende da **qualidade do label de settlement** (comprar a 0,90 exige WR ≥ ~91%). O cubo com `mkt_agree` confirma WR 92,1% no bolsão; em produção, monitorar divergência Chainlink vs book nos primeiros dias.
- DD absoluto cresce com o tier (exposição até 1,5–2× por evento). Para banca de US$ 100, preferir champion (v1) ou robust (v3); aggressive (v2) só com banca folgada.
- Robust (v3, `maxDistAbs=30`) é a melhor candidata risco/retorno do lab de mitigations 2026-07-21 — não desligar late flip reverse.
- Não autorizada para conta real — seguir gates do dossiê `avaliacao-integrada-conta-real-2026-07-10.md` (paper trading primeiro).
- Extensão natural: rodar o mesmo preset em ETH/SOL 5m (dados já no lake) para diversificação de DD.
