# MIDAS — virada abrupta UP/DOWN (odds shock)

**Data:** 2026-07-26  
**Lake:** BTC 5m depth=25 atualizado até 2026-07-25  
**Scan:** `labs/sandbox/midas-odds-flip-scan.mjs` → `midas-odds-flip-scan.md`  
**Labs:**
- Holdout: `reports/labs/midas-carry-v1/2026-07-26T03-53-55-234Z-odds-shock-july/`
- Treino: `reports/labs/midas-carry-v1/2026-07-26T04-27-11-640Z-odds-shock-train-focus/`

## Hipótese

Em alguns eventos o spot cruza o PTB só nos últimos segundos (ex.: 25/07 20:20–20:25 BRT, PTB ≈ 64341), e o gráfico UP/DOWN mostra um **X-cross violento**: um lado dominante (~0,75–0,80) por minutos e depois colapso para ~0 no fim. A MIDAS compra o favorito nos últimos 30s; nesses casos o late-flip por spot chega tarde demais ou o book já sumiu.

## Scan (julho 01–25)

| Path de odds | Eventos | Trades MIDAS | PnL | WR | Loss PnL |
|---|---:|---:|---:|---:|---:|
| stable | 5351 | 1399 | **+3683** | **96,1%** | −424 |
| high_odds_velocity | 805 | 636 | +530 | 76,4% | −1373 |
| violent_odds_cross | 244 | 205 | **−1546** | **20,5%** | −1748 |
| settlement_surprise | 126 | 70 | −155 | 31,4% | −549 |
| soft_odds_cross | 64 | 52 | −95 | 48,1% | −223 |

- **90% do loss PnL** da MIDAS em julho está em paths flip-related.
- Fora de flip: WR 96% e quase todo o lucro.
- Evento da imagem: `0xff816def4c` (2026-07-25T23:20Z = 20:20 BRT, PTB 64341,04).

## Mecanismo testado: `oddsShock`

Novo bloco no `strategy.gls` (default **OFF**):

- Detecta **velocidade** de ask: `oppAsk` sobe ≥ Δ e/ou ask próprio cai ≥ Δ no lookback (2s), com `oppAsk ≥ minOppAsk`.
- Usa `signals.upAskAgo` / `downAskAgo` (não é nível estático — diferente do `earlyWarn` já rejeitado).
- Modos: exit total · partial (`pct`) · reverse · `onlyIfLosing` (só com spot já contra).

## Lab julho (holdout)

| Variante | PnL | ΔPnL | WR | Max DD | ΔDD | Worst day |
|---|---:|---:|---:|---:|---:|---:|
| **baseline-aggressive** | **2416** | — | 81,3% | 95,6 | — | −18,6 |
| **os-exit-d15-losing** | 2311 | **−4%** | 80,6% | **72,4** | **−24%** | −22,2 |
| os-partial50-d15 | 2146 | −11% | 76,1% | 72,8 | −24% | −21,3 |
| os-exit-d15-minopp55 | 2120 | −12% | 75,6% | 79,8 | −17% | **−5,2** |
| os-exit-d20 | 1943 | −20% | 73,9% | 79,0 | −17% | **+3,2** |
| os-exit-d15 (full) | 1741 | −28% | 71,6% | 82,2 | −14% | −15,5 |
| ew-045-ref | 1558 | −36% | 69,8% | 76,0 | −20% | −45,0 |
| os-reverse-d15 | 1032 | −57% | 78,2% | **136** | +42% | −122 |

## Lab treino (05-04 → 07-01)

| Variante | PnL | ΔPnL | WR | Max DD |
|---|---:|---:|---:|---:|
| **baseline-aggressive** | **5557** | — | 80,5% | **105** |
| os-exit-d15-losing | 5152 | **−7%** | 79,5% | 104 (≈0) |
| os-partial50-d15 | 4370 | −21% | 75,5% | **142** (pior) |
| os-exit-d15-minopp55 | 3576 | −36% | 73,4% | 117 |
| os-exit-d15 | 2965 | −47% | 69,1% | 117 |
| ew-045-ref | 2845 | −49% | 67,8% | 114 |

## Veredito

1. **O padrão é real e dominante nas perdas.** Detectável pelo gráfico UP/DOWN; concentra ~90% do prejuízo.
2. **Stop/saída por velocidade de odds funciona, mas corta winners demais.** Exit full e earlyWarn estático destroem treino (−47%/−49% PnL) — mesmo perfil de whipsaw já visto em labs anteriores.
3. **Partial e reverse: rejeitados.** Partial piora DD no treino; reverse explode DD no holdout.
4. **Única candidata frágil: `oddsShockOnlyIfLosing` + Δ0,15.** Holdout −4% PnL / −24% DD; treino −7% PnL / DD inalterado. Não promove ganho de acerto líquido — só hedge de cauda no holdout, sem confirmação no treino.
5. **Não ligar no live / presets.** Manter `oddsShockEnabled: false` (como earlyWarn/bookCollapse). Se quiser A/B defensivo no robot, só `onlyIfLosing` — nunca exit full nem reverse.

## Reproduzir

```powershell
npm run lake:update-btc-5m
node --max-old-space-size=8192 labs/sandbox/midas-odds-flip-scan.mjs --from 2026-07-01 --to 2026-07-26
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/odds-shock-july.json --variant-workers 6
npm run lab:run -- --experiment labs/strategies/terminal/midas-carry-v1/experiments/odds-shock-train-focus.json --variant-workers 4
```

## Próximos passos (se continuar)

- Filtro de **entrada** (não exit): evitar entrar quando `maxOddsVel` recente já está alto, ou quando o favorito tem edge frágil com τ curto — ataca a causa sem whipsaw de saída.
- Combinar com `minSecondsLeft: 10` (já candidato frágil em loss-mitigation) em A/B micro.
- Não usar odds X-cross pós-facto como label de treino para exits — o sinal útil chega tarde demais para salvar sem matar o carry.
