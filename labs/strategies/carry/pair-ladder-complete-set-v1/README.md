# Pair Ladder Complete-Set V1

Status: **research** · BTC Up/Down 5m · library-runner · **proibido conta real**

## Documentação canônica

Passo a passo + configs + desempenho:  
[`docs/estrategias/nao-implementadas/doggy-momentum-pair-ladder-canonico.md`](../../../../docs/estrategias/nao-implementadas/doggy-momentum-pair-ladder-canonico.md)

Log de RE (Etapas 1–17):  
[`docs/estrategias/nao-implementadas/pair-ladder-complete-set-v1.md`](../../../../docs/estrategias/nao-implementadas/pair-ladder-complete-set-v1.md)

## Resumo operacional

1. **Taker** + fee crypto + rebate **Diamond 44%** (não 76%)  
2. Open **1 lado** ~50sh @45–55¢ ≤30s  
3. Hedge oposto ~100sh após ≥5s (med Doggy ~18s)  
4. Build = **chase MOMO** (`dAsk15 ≥ +2¢`, banda 20–70¢) · bloquear FADE mid  
5. Vacuum late ≤15¢ no underweight; soft lock não encerra  
6. Só redeem · zero SELL/MERGE mid-evento  

Preset research: `presets/btc-doggy-parity-momo.json`  
(`legChoice=chase_momo` · `momoBlockFade=true` · `slippageCents=-1`)

## Comandos

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
npm run package:strategy-library -- --source labs/legacy/strategy-runners/portable/pair-ladder-complete-set-runner.js --slug pair-ladder-complete-set-runner --name "Pair Ladder Complete-Set Runner" --version 1
npm run embed:strategy-libraries
node --test tests/pairLadderCompleteSet.test.js
npm run lab:run -- --experiment labs/strategies/carry/pair-ladder-complete-set-v1/experiments/doggy-rules-g.json
```

## Desempenho (cohort both 24–25/07)

| | PnL |
|---|---:|
| Doggy | +$83 |
| Melhor lab (`chase_momo` + no-fade + vac) | −$1.276 |

Paridade no lake 2 Hz **não** fecha. Detalhe na doc canônica.
