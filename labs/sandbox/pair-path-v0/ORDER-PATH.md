# Order path (fase pós-WS)

## Objetivo

Medir na Giovanna o round-trip real de ordem CLOB, sem campanha size-fee:

1. ping CLOB  
2. `createAndPostOrder` postOnly @ 1¢ (não deve fill)  
3. `getOpenOrders`  
4. `cancelOrder`  

Script canônico (data-robot):

```bash
npm run tfc:latency -- --live --label=giovanna-pairpath --repeat=3 --json
```

## Política

- Requer `--live` (envia ordem real mínima)  
- postOnly 1¢ / size 5 — cancela em followed  
- Rodar **só** engine BTC, `ENGINE_START_ARMED=0` se possível  
- Parar engine após a medição  

## Gate para micro-real

- p50 total (create+get+cancel) documentado  
- cancel sempre OK  
- sem fill acidental no postOnly 1¢  

## Resultado 2026-07-28 Giovanna (engine BTC, ARMED=0)

| | cold | warm (mediana 3×) |
|---|---:|---:|
| ping | 99 ms | 67 ms |
| create | 766 ms | **144 ms** |
| getOpen | 125 ms | 116 ms |
| cancel | 134 ms | 131 ms |
| **total** | 1025 ms | **384 ms** |

- 3/3 cancel OK · open orders viu a ordem · sem fill  
- Engine **stop** após o teste  
- Gate: **PASS**  

Próximo: micro-real mínimo Pair-Path V0 (não size cheio de cara).  

