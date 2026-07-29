# Micro-real Pair-Path V0 — como funciona

## 1. Ideia em uma frase

No **mesmo host Giovanna**, com **book WS**, a máquina V0 decide open/hedge; em vez de só journal, **envia ordens mínimas** no CLOB e reconcilia fill/cancel — 1 evento, size micro, freios duros.

```text
WS book → regras size-fee-v0 (size ↓) → ordem real limitada → fill? → hedge? → settlement
```

---

## 2. O que **não** é

| Não | Sim |
|---|---|
| Escada Phil / MULT / re-arme | 1 open + 1 hedge (+ EQ se der) |
| Size 20 de cara | **5 shares** default (micro) |
| MIDAS/TFC engine armada | Script dedicado, engine só para env/client se precisar |
| Campanha 20 eventos | **1 evento** (depois 2–3 se ok) |
| Fill no preço fantasma | limit/FOK no **cap** (trigger+1¢) ou miss |

---

## 3. Parâmetros micro (default)

| Param | Micro | size-fee-v0 lab |
|---|---:|---:|
| openShares | **5** | 20 |
| maxEventNotional | **8** | 27 |
| avgSumMax | 0.96 | 0.96 |
| hedgeAskMax | 0.42 | 0.42 |
| open banda | 52–62¢ | igual |
| openCap | +1¢ | igual |
| maxEvents | **1** | — |
| fee model | real CLOB | 0.07 estimado |

Notional pior caso ~ open 5×0.62 + hedge 5×0.42 ≈ **$5.2** (mais fee).

---

## 4. Fluxo por evento

```text
0. Preflight
   - geoblock / saldo / open orders
   - evento BTC 5m com τ ≥ 40s
   - ARMED só neste script (--live)

1. Subscribe Market WS (UP+DOWN tokens)

2. Loop (até τ=0 ou done/blocked)
   a. Atualiza best ask/bid do WS
   b. Motor V0: idle → tenta OPEN
      - chase favorito em [0.52, 0.62], ask ≥ 0.55
      - preço ordem = min(ask, 0.55+0.01)  # cap
      - se ask > 0.56 → MISS (não manda / ou FOK que falha)
      - LIVE: createAndPostOrder BUY size=5
      - DRY: assume fill @ ask se cap ok
   c. Se opened: tenta HEDGE
      - oposto ask ≤ 0.42 e proj avgSum ≤ 0.96
      - LIVE: BUY oposto size = residual
      - se timeout maker/taker: aceita residual (não martingale)
   d. EQ se residual e ask ≤ 5¢ e avgSum ok

3. Fim do evento
   - cancela resting se houver
   - report: fills reais, fees, pnl settlement proxy, órfãs
```

---

## 5. Tipos de ordem

| Perna | Tipo | Preço | postOnly |
|---|---|---|---|
| Open | **GTC** marketable + settle ~1.2s + cancel | ≤ trigger+cap | false |
| Hedge | **GTC** (mesmo path) | ≤ hedgeAskMax | false |
| Legacy live #2 | FOK | ≤ cap | false — **kill sem liquidez** |
| Latency test antigo | GTC postOnly 1¢ | 0.01 | true (não fill) |

Micro-real **quer fill** controlado. FOK no nível falhou no live #2 (`couldn't be fully filled`).  
CLI: `--order-type=GTC|FAK|FOK` (default **GTC**), `--settle-ms=1200`.

---

## 6. Kill switches

| Condição | Ação |
|---|---|
| openOrders órfãs no start | abort |
| notional > maxEventNotional | bloqueia |
| 1 fill open + sem hedge e τ &lt; 15 | tenta EQ; senão para |
| erro CLOB / circuit | cancela tudo, exit |
| Ctrl+C | cancel best-effort |
| `--live` ausente | **só dry** (default) |

---

## 7. Dois modos

### Dry (default) — **obrigatório antes do live**
- Mesmo WS + mesmas regras  
- Fills **simulados** no ask se cap ok (como shadow)  
- **Zero** createAndPostOrder  
- Serve para validar wiring do harness no container  

```bash
node scripts/pair-path/micro-live.js --max-events=1 --open-shares=5
```

### Live
```bash
node scripts/pair-path/micro-live.js --live --max-events=1 --open-shares=5
```

Exige `--live`. Dinheiro real.

---

## 8. Onde roda

1. Start **só** `data-robot-engine-btc` (env/secrets)  
2. Confirmar `ENGINE_START_ARMED=0` (MIDAS não arma)  
3. `docker exec` o harness Pair-Path  
4. Stop engine ao terminar  

Não liga ETH/SOL/XRP/DOGE.

---

## 9. Critério de sucesso do 1º micro

| | |
|---|---|
| Harness dry | 1 evento completa sem crash |
| Live | se abrir: fill reconciliado; se hedge: par ou residual documentado |
| Sem órfã | open order cancelada ou filled |
| PnL | irrelevante no n=1; importa **path de execução** |

---

## 10. Sequência de execução (ops)

1. Dry 1 evento na Giovanna  
2. Revisar log/report  
3. Live 1 evento size 5  
4. Se ok: 2–3 micros em dias/eventos distintos  
5. Só então discutir size 10–20  
