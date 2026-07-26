# Shotandgo V1 — port Phil_Hopper_Real → data-backtest

Status: **research** · BTC Up/Down 5m · library-runner `shotandgo-runner@1`

Port fiel da Escada Dupla do [`polymarket-fm/Phil_Hopper_Real.py`](../../../../../polymarket-fm/Phil_Hopper_Real.py).  
O post-mortem de `escada-dupla-v1` (`ascent_hedge`) **não cobre** esta variante.

## Baseline (Python live)

- Grade SUB 55…90 / DESC 45…10 com shares `[20,15,10,10,5,5,1,1]` / `[5×8]`
- `MULT=[2,3,4,5,6,6]`, `contagio=global`, `contagioMin=5`
- STOP @ virada 4, PISO viradas {4,5}, MAX_VIRADAS=6
- `DESC_MODO=gatilho` após virada 5
- EQ limite maker (arma 10¢ / cancela 40¢ / fill @ 5¢)
- Default lab: `executionMode=honest` (`taker_limit` + DESC resting)

## Comandos

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
npm run package:strategy-library -- --source labs/legacy/strategy-runners/portable/shotandgo-runner.js --slug shotandgo-runner --name "Shotandgo Runner" --version 1 --description "Shotandgo / Phil Escada Dupla — dual ladder + reality surface"
npm run embed:strategy-libraries
node --test tests/shotandgoParity.test.js

# Smoke 2 dias
npm run lab:run -- --experiment labs/strategies/carry/shotandgo-v1/experiments/parity-smoke.json --variant-workers 2

# Decisivo mai–jun (Brutus recomendado)
npm run lab:run -- --experiment labs/strategies/carry/shotandgo-v1/experiments/live-honest-may-june.json --variant-workers 4
```

Gate pré-declarado (candidato robô): **PF ≥ 1,2 e PnL > 0** em execução honesta na janela limpa mai–jun.

Preset: `presets/btc-shotandgo-python-live.json`  
Doc: [`docs/estrategias/nao-implementadas/shotandgo-v1.md`](../../../../docs/estrategias/nao-implementadas/shotandgo-v1.md)
