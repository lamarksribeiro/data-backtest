# Hopper 3 — maker realista (`executionMode`)

## Problema

O antigo `simulateMaker: true` comprava **no bid no mesmo tick** e marcava `liquidity: maker`. Isso dava melhor preço + fill 100% + fee $0 — irreal no CLOB da Polymarket.

## Modos

| `executionMode` | Compras | Vendas | Compat |
|-----------------|---------|--------|--------|
| `optimistic_maker` | fill imediato no bid | imediato no ask | `simulateMaker: true` (legado) |
| `resting_maker` | LIMIT resting; fill se ask atravessar | **sempre taker** | candidata honesta |
| `taker` | walk asks | walk bids | `simulateMaker: false` |

Se `executionMode` for omitido, deriva de `simulateMaker`.

### Params novos

- `makerFillEpsilon` (default `0.01`) — ask precisa cair até `limit - epsilon`
- `makerTimeoutSec` (default `15`) — cancela resting sem fill

### Regra de fill (igual ao GLS `orderSimulator`)

1. Coloca no **bid** somente se `bid < ask` (senão rejeita marketable)
2. Em ticks seguintes: fill se `prevAsk >= price` e `currAsk <= price - epsilon`
3. Timeout / fim de evento → cancel
4. Uma resting aberta; mesmo lado+tipo mantém; tipo diferente substitui

Flags de estado (`entradaFeita`, viradas) só aplicam **no fill** (callback `onFill`).

## Arquivos

- Runner: `labs/legacy/strategy-runners/portable/hopper-3-runner.js`
- Library: `data/strategy-libraries/hopper-3-runner.v1.json` (sincronizar após editar o portable)
- Defaults: `executionMode: resting_maker`
- Preset `btc-champion`: `optimistic_maker` (baseline legado)
- Testes: `tests/hopper3RestingMaker.test.js`
- A/B: `labs/sandbox/hopper-3-maker-execution-ab.mjs`

## Como rodar o A/B

```bash
cd data-backtest
node --test tests/hopper3RestingMaker.test.js
node labs/sandbox/hopper-3-maker-execution-ab.mjs
```

Resultado esperado (sintético):

- `optimistic_maker`: entra em todos os sinais
- `resting_maker`: fill rate &lt; 100% (timeouts viram `no_entry`)
- `taker`: entra sempre, mas paga fee

Relatório: `labs/sandbox/hopper-3-maker-execution-ab-report.md`

## Sincronizar library JSON

```bash
node -e "import fs from 'fs'; const s=fs.readFileSync('labs/legacy/strategy-runners/portable/hopper-3-runner.js','utf8'); const j=JSON.parse(fs.readFileSync('data/strategy-libraries/hopper-3-runner.v1.json','utf8')); j.source_code=s; fs.writeFileSync('data/strategy-libraries/hopper-3-runner.v1.json', JSON.stringify(j,null,2)+'\n');"
```

## Fora de escopo (ainda)

- Fila / adverse selection fina
- Exit maker resting
- Cap de reversão e correção do `0.0007` no sizing
