# Relatório MIDAS — live × backtest

**Preset:** `midas-carry-v1` / `btc-micro-aggressive-v1` ($2/$4)  
**Período:** 2026-07-24 → 2026-07-25 (UTC)  
**Gerado:** 2026-07-25T17:05Z  
**Fontes:** `robot.fracta.online` `/trades` + audit JSONL · lab Brutus `run-preset` + `compare-all-live.js`

Canvas interativo: abrir `midas-relatorio-completo.canvas.tsx` no Cursor.  
Complementar (causa raiz A2 + correção): `RELATORIO-COMPLEMENTAR-CORRECAO-FAK-EXIT.md`.

---

## Veredito

O edge **direcional** está vivo (WR live **80%** ≈ BT **79,2%**). O gap de PnL (**+$2,67** live vs **+$24,22** BT no dia) vem de:

1. **Cobertura** — 40 entradas live vs 125 no BT  
2. **Path de saída / modelo de execução** — BT assume fill garantido (`ignoreConsumed`); live usava **FAK na saída protetora** (late-flip / REVERSE EXIT), que morre sem retry no book fino dos últimos segundos  
3. **Dados / telemetria** — FAK miss na entrada, fill drift, 17 eventos ausentes no lake, 1 winner divergente; audit **não grava** decisões “quietas” (A1 estava subprovado)

Nos **23** eventos presentes no lake (mesmo universo): live **+$1,03** vs BT **+$4,01**.

### Correção complementar (código, pendente deploy)

Causa raiz de **A2** identificada e corrigida em código: `MICRO_AGGRESSIVE` / `MICRO_ROBUST` tinham `exitOrderType: 'FAK'`. Isso alimenta danger/early-warn/late-flip-exit **e** a perna EXIT da saga REVERSE. No book fino (4–8s), FAK → `REVERSE_EXIT_INCOMPLETE` sem retry.

**Fix:** `exitOrderType: 'GTC'` (entrada continua FAK). Arquivos: `data-robot/src/tfc/preset-midas.js`, teste `midas-micro-live.test.js`. **Ainda não deployado.**

---

## Agregados

| Métrica | Live | Backtest |
|--------|------|----------|
| Entradas | 40 | 125 |
| Wins / Losses | 32 / 8 | 99 / 26 |
| Win rate | 80,0% | 79,2% |
| PnL líquido (reportado) | +$2,67 | +$24,22 (c/ $5,35 fees) |
| Profit factor | 1,19 | 1,68 |
| Avg win / avg loss | $0,53 / −$1,80 | ~$0,60 / ~−$1,37 |
| Fee entrada (est. live) | ~$1,02 → net ~+$1,64 | incluída |

### Paridade nos 40 markets live

| Classe | N | Significado |
|--------|---|------------|
| near_parity (≈) | 13 | mesmo lado, \|ΔPnL\| < $0,15 |
| pnl_gap | 7 | mesmo lado, PnL diverge |
| exit_path_diff | 2 | BT reverteu; live hold |
| bt_no_entry | 1 | live entrou; BT não |
| bt_missing | 17 | evento fora do lake |

---

## Catálogo de achados

| ID | Sev | Achado | Evidência | Status |
|----|-----|--------|-----------|--------|
| A1 | P0 | Late-flip / losses — **interpretação revisada** | 8/8 losses sem linha `decision` no audit; 2 exitΔ com BT reverse | **Subprovado:** audit só grava se houve accept/stateChange/deny (ver A11). Não distingue “nunca cruzou” vs “avaliou e não elegível” vs “não rodou” |
| A2 | P0 | Saída protetora em FAK → REVERSE incompleto | `exitOrderType:'FAK'` em MICRO_*; `REVERSE_EXIT_INCOMPLETE` em 1784953500; lab `ignoreConsumed:true` | **Causa raiz + fix GTC no código** (pendente deploy) |
| A3 | P0 | Winner live ≠ lake | 1784963700: live Up/−1,35 · BT Down/+0,66 | Aberto (dados/settlement) |
| A4 | P1 | Cobertura baixa + FAK na **entrada** | 40/125; FAK miss×23; restarts×35 | Aberto — **não** mudar entry para GTC sem lab (adverse selection) |
| A5 | P1 | Fill/price drift | ex. 0,89 live vs 0,62 BT; retries FAK elevam preço | Aberto (ligado a A4) |
| A6 | P1 | PnL sem fee / settle 0,995 | métrica otimista | Aberto |
| A7 | P1 | Journal multi-leg / settle duplicado no audit | multi-ENTER/SETTLEMENT; audit 4× mesmo loss | Aberto — preferir `/trades` dedupado vs audit bruto |
| A8 | P2 | Lake incompleto | 17/40 missing | Aberto |
| A9 | P2 | Janela late-flip 4–8s | flip <4s = loss cheia | Aberto (lab antes de alargar) |
| A10 | P2 | Seleção ≠ execução | 1 no_entry BT; 125 vs 40 | Aberto |
| A11 | P0* | Audit omite ticks quietos | `shouldAuditDecision` em `engineApp.js:813` | **Novo** — bloqueia diagnóstico confiável de A1; priorizar breadcrumb lateFlip (S3) **antes** de mais replay (S1) |

\*P0 de telemetria: não é bug de PnL por si, mas torna A1 não acionável até existir evidência.

### Deep-dive (Δ material)

| Market | Live | BT | ΔPnL | Causa |
|--------|------|-----|------|-------|
| 1784933100 | DOWN hold −1,59 | reverse −0,89 | −0,70 | exit path |
| 1784951400 | DOWN hold −1,61 | reverse −0,34 | −1,27 | exit path |
| 1784963700 | DOWN→Up −1,35 | DOWN win +0,66 | −2,01 | **winner divergente** |
| 1784953500 | UP +0,63 (rev?) | reverse −1,52 | +2,15 | reverse incompleto |
| 1784965200 | @0,89 +0,35 | @0,62 +1,14 | −0,80 | fill pior |
| 1784947200 | @0,77 +1,07 | @0,84 +0,64 | +0,43 | fill melhor |
| 1784958000 | +0,41 | no_entry | +0,41 | só live |

JSON completo trade-a-trade: `full-parity-report.json`.

---

## Propostas de solução (atualizadas com o complementar)

### Já feito (código local, falta deploy)

| # | Ação | Aceite pós-deploy |
|---|------|-------------------|
| **S2a** | `exitOrderType` FAK→**GTC** em MICRO_AGGRESSIVE/ROBUST | `REVERSE_EXIT_INCOMPLETE` ↓; monitorar `orphanOrders` (GTC residual pós-settlement) |

### P0 (antes de subir budget)

| # | Ação | Onde | Aceite | Nota |
|---|------|------|--------|------|
| **S0** | Deploy S2a + 24h observação | Giovanna | taxa reverse incompleto ↓; orphanOrders≈0 | Risco: GTC EXIT órfã após binary settle |
| **S3↑** | Breadcrumb: auditar quando `lateFlip.active` (throttle 250–500ms) | `engineApp.js` shouldAuditDecision | perdas com trilha lateFlip | **Antes de S1** — A11 |
| S1 | Replay PG dos 8 losses + 2 exitΔ | scratch | causa raiz/market | Só depois de S3 |
| S2b | Retry/fallback na saga se GTC ainda falhar | reverseSaga.js | 0 incompleto residual | Complementa S2a |
| S4 | Lab: janela late-flip / earlyWarn | presets | PF lab ok; losses ↓ | |
| S5 | Investigar winner 1784963700 | settlement + lake | regra canônica | |

### P1

| # | Ação |
|---|------|
| S6 | Modelar FAK miss **na entrada** no lab (BT hoje assume fill garantido) |
| S7 | Deduplicar journal + fee no PnL |
| S8 | Harness diário live×BT (`compare-all-live.js`) |
| S9 | Reduzir restarts com posição aberta |
| S10 | Normalizar ΔPnL por notional |
| S14 | **Não** trocar `entryOrderType` para GTC sem experimento (adverse selection) |

### P2

| # | Ação |
|---|------|
| S11 | Lake: não omitir eventos live / flag omit |
| S12 | Settlement 0/1 canônico |
| S13 | Shadow fill-sim paralelo |

**Ordem revisada:** **S0 (deploy GTC)** → **S3 (breadcrumb)** → S1 replay → S2b se necessário → S8 → S6/S7 → reavaliar budget.

### Lab de validação da correção GTC (2026-07-25)

Ablação proxy no micro-aggressive (`fak-exit-gtc-*-*.json`):

| | Holdout jul (2101 trades) PnL | PF | Max DD |
|--|--:|--:|--:|
| gtc-full-protect (proxy GTC ok) | **417,9** | 1,58 | 15,6 |
| fak-miss-hold (proxy FAK kill) | **246,9** | 1,33 | 17,1 |
| Δ | **+$171 (+69%)** | +0,25 | melhor |

Relatório: `LAB-FAK-EXIT-GTC.md`. **Conclusão:** deploy GTC justificado; reverse é a peça cara (+$119 vs exit-only).

---

## Artefatos

- `scratch/live-vs-backtest/full-parity-report.json`
- `scratch/live-vs-backtest/compare-all-live.js`
- `scratch/live-vs-backtest/live-markets.json`
- `scratch/live-vs-backtest/prod-trades.json`
- `scratch/live-vs-backtest/prod-audit-2026-07-24.jsonl` / `…-25.jsonl`
- `scratch/live-vs-backtest/RELATORIO-COMPLEMENTAR-CORRECAO-FAK-EXIT.md`
- `data-robot/src/tfc/preset-midas.js` (`exitOrderType: 'GTC'`)
