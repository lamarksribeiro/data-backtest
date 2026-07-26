# Pair Ladder Complete-Set V1

Status: **research** · BTC Up/Down 5m · library-runner

## Pergaminho Doggy (Iteração G)

1. **Taker** + fee crypto + **taker rebate** de volume  
2. Open **1 lado** ~50sh @~51¢ nos primeiros segundos  
3. Hedge oposto **~18s depois** (não same-tick)  
4. Depois do dual: compra quase só **underweight**/chase barato  
5. Vacuum late ≤15¢; continua mesmo com avgSum já &lt;0,95  
6. Fill efetivo ~**1¢ melhor** que o ask do lake  

Stack no lake (pré-fee path+ask−1 → fees → rebate~76%): edge path existe; fees comem; rebate aproxima flat. Sem live.

## Comandos

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
npm run package:strategy-library -- --source labs/legacy/strategy-runners/portable/pair-ladder-complete-set-runner.js --slug pair-ladder-complete-set-runner --name "Pair Ladder Complete-Set Runner" --version 1
npm run embed:strategy-libraries
node --test tests/pairLadderCompleteSet.test.js
node labs/sandbox/doggy-deep-rules.mjs
npm run lab:run -- --experiment labs/strategies/carry/pair-ladder-complete-set-v1/experiments/doggy-rules-g.json
```

Preset: `presets/btc-doggy-parity-taker.json`  
Spec: [`docs/estrategias/nao-implementadas/pair-ladder-complete-set-v1.md`](../../../../docs/estrategias/nao-implementadas/pair-ladder-complete-set-v1.md)
