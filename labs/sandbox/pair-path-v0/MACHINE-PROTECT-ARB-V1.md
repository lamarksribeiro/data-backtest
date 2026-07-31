# Protect + Arb V1 — laboratório unificado

**Status:** research / Fase 1 (lake)  
**Data:** 2026-07-30  
**Lab:** `labs/sandbox/pair-path-v0/`  
**Motivação:** live V0 sh5 (2026-07-30) abriu DOWN@0,57 e carregou residual até settlement (−$2,85). Proteção e arb precisam ser medidas no mesmo harness.

## 0. Pipeline

```text
lake Parquet BTC 5m d25  →  protect-arb-lab  →  report
                              ↓ GO proteção
                         micro-live DRY --protect=
                              ↓ GO dry
                         micro-live LIVE size5 / 1 evento
```

Arb (atomic / Pair-Gate) **não** sobe a live se o lake repetir FAIL/HOLD.

## 1. Duas teses

| Família | Tese | Risco |
|---------|------|-------|
| **Proteção** | Path V0 (open favorito) + flatten residual por SELL e/ou HEDGE caro | Momentum; proteção corta cauda |
| **Arb** | Só entra se par fecha com `proj ≤ 1−ε` (atômico ou Pair-Gate) | Residual = falha de execução → abort |

## 2. Matriz

Baseline: size **5**, fee **0,07**, open 52–62 / trigger 55 / cap+2¢, BTC 5m.

| ID | Família | Comportamento |
|----|---------|---------------|
| `v0-naked` | controle | open→hedge barato; residual até fim |
| `prot-sell` | proteção | residual → SELL no bid |
| `prot-hedge` | proteção | residual → BUY oposto (escape até avgSum 1,00) |
| `prot-min` | proteção | **min(custo_SELL, custo_HEDGE)** + force τ≤20 |
| `prot-min-ready` | proteção | `prot-min` + `openRequireHedgeReady` |
| `arb-atomic` | arb | só se `askU+askD+fees ≤ 1−ε` no mesmo tick |
| `arb-pair-gate` | arb | Pair-Gate I1 + abort SELL (`pair-gate-engine.mjs`) |

### Proteção — custo por tick

```text
custo_sell  = openAvg − bid_open + fee_sell
custo_hedge = openAvg + ask_opp − 1 + fee_buy
prot-min: executar o menor
τ ≤ tauForceProtect (20): forçar flatten mesmo se avgSum > 1
proibido terminar com residual > 0 (exceto v0-naked / miss de liquidez)
```

### Gatilhos compostos (prot-* desde 2026-07-30)

Proteção **não** dispara no tick imediato após open (`skipProtectThisTick`). Depois, flatten só se **≥1** gatilho:

| Gatilho | Parâmetro | Default | Condição |
|---------|-----------|---------|----------|
| **Timeout** | `protectTimeoutSec` | 45s | residual sem hedge barato por N segundos |
| **Adverse fav** | `protectAdverseCents` | 4¢ | `bid_open ≤ openAvg − N¢` |
| **Adverse opp** | `protectOppBeyondHedge` | `true` | `ask_opp > hedgeAskMax` **e** subiu desde o open |
| **Force τ** | `tauForceProtect` | 20s | override final (rede de segurança) |

Hedge barato ainda disponível → não proteger (exceto force-τ).

Bid ausente no journal → proxy `ask − 0,01` (flag `bidProxy=true` no report).

## 3. Métricas e gates (descoberta)

Métricas: `nOpen`, `nEqualized`, `nProtectSell`, `nProtectHedge`, `nResidualEnd`, `pnl`, `worst`, `PF`, `avgSumMed`, `abortDrag`, `feeTotal`.

**Gate promoção proteção** (`prot-min` / `prot-min-ready`):

1. `nResidualEnd / nOpen ≤ 5%` (liquidez miss permitido)
2. `worst ≥ −openNotional` (size×0,62)
3. `pnl` não pior que `v0-naked_pnl − 0.5 × |v0-naked_pnl|` (se v0≠0)

**Arb:** reusa gates Pair-Gate; atomic esperado ~0 opens.

## 4. Janelas

| Janela | Datas | Uso |
|--------|-------|-----|
| Discovery | 2026-04-23 → 2026-06-30 | ranking |
| Validation | 2026-07-01 → 2026-07-28 | não ranqueia |
| Smoke journals | `.tmp/poly-baliza/` + shadows | regressão rápida |

Veredito discovery+validation: [`PROTECT-ARB-V1-VEREDITO.md`](./PROTECT-ARB-V1-VEREDITO.md).

## 5. Como rodar (lake)

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node --test labs/sandbox/pair-path-v0/protect-arb-engine.test.mjs
node labs/sandbox/pair-path-v0/protect-arb-lab.mjs --from=2026-04-23 --to=2026-06-30 --tag=discovery
node labs/sandbox/pair-path-v0/protect-arb-lab.mjs --from=2026-07-01 --to=2026-07-28 --tag=validation
node labs/sandbox/pair-path-v0/protect-arb-lab.mjs --journals --tag=journal-smoke
```

Saída: `.tmp/protect-arb-v1-{tag}/report.json` + `SUMMARY.md`.

## 6. Fase 2 — dry (Giovanna) — NÃO ARMAR LIVE

Após GO do lake em `prot-min`:

```powershell
cd d:\Projetos\projeto-goldenlens\data-robot
# DRY — zero ordens CLOB
node scripts/pair-path/micro-live.js --clip=off --protect=min --open-shares=5 --max-events=2 --open-cap-cents=2 --max-notional=8 --min-tau-start=150
```

| Flag | Valores | Default |
|------|---------|---------|
| `--protect` | `off` \| `sell` \| `hedge` \| `min` | `off` (comportamento V0 atual) |
| `--protect-timeout` | segundos | `45` |
| `--protect-adverse-cents` | centavos | `4` |
| `--protect-opp-beyond-hedge` | `true` \| `false` \| `<cents>` | `true` |
| `--tau-force-protect` | segundos | `20` |

Implementado no harness: SELL FAK no bid do open **ou** BUY FAK no oposto conforme `min(custo)`; gatilhos timeout/adverse/force antes do flatten. A primeira campanha deve ser **sem `--live`**.

## 7. Fase 3 — live micro

Só com aprovação explícita + GO econômico do dry:

```text
--live --protect=min --open-shares=5 --max-events=1 --max-notional=8
```

Arb (`atomic` / Pair-Gate) **fora** do live nesta fase.

### Resultado dry 2026-07-30

O caminho foi implementado e exercitado na Giovanna sem `--live`:

- cap+2¢ / 2 eventos: zero opens (`OPEN_MISS_CAP`);
- smoke cap+7¢: DOWN@0,58 → SELL@0,57, residual 0,
  realized −US$ 0,221.

**Decisão:** HOLD live. A proteção imediata funciona mecanicamente, mas vende no
tick seguinte quando o hedge barato não existe e cristaliza spread + fees.
**Calibração aplicada:** gatilhos timeout (45s) + adverse (4¢ / opp↑ desde open)
+ force-τ≤20 — ver seção gatilhos compostos.

## 8. Arquivos

| Path | Papel |
|------|-------|
| `protect-arb-engine.mjs` | Motor journal (V0 + protect + atomic) |
| `protect-arb-engine.test.mjs` | Unitários |
| `protect-arb-lab.mjs` | Sweep lake + journals + Pair-Gate arm |
| `pair-gate-engine.mjs` | Braço `arb-pair-gate` |

## 9. Fora de escopo

- Escada Phil / MULT  
- Maker dual-bid resting completo (pesquisa futura)  
- Conta real nesta entrega do lab
