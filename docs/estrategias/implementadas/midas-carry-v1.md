# MIDAS Carry V1 — Tiered High-Ask Terminal Carry

**Status:** campeã Estúdio **v11** (`btc-gold-v1` · **$10/$30**) · canário micro v9 · ETH Gold **v12** · **Lab:** `labs/strategies/terminal/midas-carry-v1/` · **Studio slug:** `midas-carry-v1` · **Atualizado:** 2026-07-26

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

### Presets Gold (produção) e micro (canário)

| Preset | Base / teto | Envelope | Uso |
|---|---|---|---|
| **`btc-gold-v1`** | **US$ 10 / US$ 30** | g3-os · tier high-ask **1.5×** · settle 0.995 | Estúdio **v11** · **campeão BTC produção** |
| **`eth-gold-v1`** | **US$ 10 / US$ 30** | mesmo pacote | Estúdio **v12** · candidato ETH |
| **`sol-gold-v1`** | **US$ 10 / US$ 30** | mesmo pacote | Estúdio **v13** |
| **`xrp-gold-v1`** | **US$ 10 / US$ 30** | mesmo pacote | Estúdio **v14** |
| **`doge-gold-v1`** | **US$ 10 / US$ 30** | mesmo pacote | Estúdio **v15** |
| **`hype-gold-v1`** | **US$ 10 / US$ 30** | mesmo pacote | Estúdio **v16** |
| BNB | — | g3-os jul | **reprovado** (PnL−95) |
| `btc-micro-guardian-v3-os` | US$ 2 / US$ 4 | g3-os idêntico | Estúdio **v9** · canário micro |
| `eth-micro-gold-v1` | US$ 2 / US$ 4 | g3-os | Estúdio **v10** · micro ETH |
| `btc-micro-aggressive-v1` | US$ 2 / US$ 4 | Aggressive (sem OS) | Estúdio **v5** · histórico |

#### Política de ordem (data-robot) — FAK vs GTC

| Perna | Tipo | Motivo |
|---|---|---|
| Entrada | **FAK** | Evita ordem resting adversa (fill tarde contra o gate). Não usar GTC na entrada sem lab novo. |
| Saída protetora / REVERSE EXIT / odds-shock | **GTC** | Book fino aos 3–8s: FAK exit morria sem retry (`REVERSE_EXIT_INCOMPLETE`). GTC marketable + retry preenche. |

Lab simula entrada taker (depth 25 ≈ FAK). Saída GTC é política só do robot.

#### Campeão v11 — o que muda vs canário live (v5)

| Peça | Canário v5 | Campeão v11 (Gold) |
|---|---|---|
| `entryBudget` / `maxEntryBudget` | 2 / 4 | **10 / 30** |
| `minSecondsLeft` | 5 | **9** |
| `tierMinZ` | 0 | **2.0** |
| `oddsShock*` | off | **on** (Δ0,15/2s, opp≥0,50, bid≥0,55×entry, vende 50%) |
| `settleWinnerPrice` | 1.0 (legado) | **0.995** (honesto) |
| dist / tier | 40 / 2.0 | **igual** |
| Ordem (robot) | FAK / GTC | **FAK / GTC** (igual; sizing sobe) |

Micro package-final (jul 01–25 / jun 01–08): PnL 433 / 112 · PF 1,65 / 1,67 · pior dia −0,22 / −6,22. Escala $10/$30: sweet spot (PF estável até ~2–4×; teto liquidez ~$40/evento). Relatório: `labs/sandbox/midas-package-final-aprovacao.md` · plano §10–12.

```powershell
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/gold-size-july.json
npm run lab:run-preset -- --preset btc-gold-v1 --strategy midas-carry-v1 --strategy-family terminal --from 2026-07-01 --to 2026-07-25 --daily-metrics
npm run lab:seed-presets
```

No Estúdio: estratégia `midas-carry-v1` → versão **v11** (default).

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

## Mundo `hold` — a configuração que a conta real executa (2026-07-28)

O live não roda a MIDAS validada; roda a versão **sem proteção**. A prova é o
perfil de payoff: razão ganho/perda de 0,294 (live 24–25/07) e 0,325 (live BTC
dedup) contra 0,304 do lab `base-hold` e 0,427 do `base-protect`. Os 8 losses
live foram todos `exitKind: SETTLEMENT`.

Custo (julho 01–25, $10/$30, settle 0,995): `protect` 1.933,6 / PF 1,577 / pior
dia −2,04 · `hold` 1.201,0 / PF 1,325 / pior dia −27,45. **A proteção vale 38% do
PnL e 13× o pior dia.**

Otimizando **para o mundo hold** (só alavancas que não exigem vender numa perna
colapsando), o vencedor é `cushionDecay` + `oddsVelGate`:

| Janela | Config | PnL | PF | razão G/P | Pior dia |
|---|---|--:|--:|--:|--:|
| Jul 01–25 | `hold-os` (o live) | 1.201,0 | 1,325 | 0,358 | −27,45 |
| Jul 01–25 | **`hold-cushion-oddsvel`** | **1.406,5** | **1,456** | **0,424** | **−13,91** |
| Jun 01–09 | `hold-os` | 304,1 | 1,231 | 0,385 | −86,42 |
| Jun 01–09 | **`hold-cushion-oddsvel`** | **373,1** | **1,340** | **0,528** | **−56,09** |

Princípio que unifica o que funciona e o que falhou: **sair cedo e somente
enquanto o mercado ainda paga** (`bid >= 0,55 × entrada`). O `cushionDecay` é o
cruzamento do late-flip com janela 20→4s e piso de bid. As proteções que agem
tarde, ou sem exigir bid, todas falharam.

Preset: `btc-gold-cushion-v1` (Estúdio v17, **candidato**, não campeão).
Ressalva: `protect-cushion` (1.425,8) < `ceiling-protect` (1.933,6) — o cushion é
**substituto** da proteção tardia, não complemento. Reavaliar em A/B depois do
fix GTC per-leg. Relatório: `reports/research/midas-execucao-vs-envelope-2026-07-28.md`.

## Mecanismos testados e rejeitados (mantidos como params desativados no GLS)

| Mecanismo | Resultado | Por quê |
|---|---|---|
| Complete-set lock (comprar o oposto para travar) | −52% do EV | Existe em 84% dos eventos, mas o book é eficiente: fechar cedo paga spread+fee. Ferramenta de variância, não de lucro (2026-07-28) |
| Entrada maker (`placeLimitBuy` role entry) | Negativo em todas as bandas | Seleção adversa integral: WR cai 6–12pp, preço melhora só ~1,3c (2026-07-28) |
| Cortar banda `ask >= 0,82` | −13% PnL, pior dia −2,04 → −6,87 | Edge da banda é ~zero em 5 ativos × 3 janelas, mas ela paga seu lugar via proteção, não via carry (2026-07-28) |
| Envelope barato `ask < 0,55` | Pior dia −54 a −60, DD ~100 | Confirma a rejeição do scoop por caminho novo (2026-07-28) |
| `hedgeStop` (stop-buy no lado oposto) | Pior dia −35 → −87 | Whipsaw: o oposto dispara, o hedge compra, o favorito vence assim mesmo. Params ficam no GLS desligados (2026-07-28) |
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
