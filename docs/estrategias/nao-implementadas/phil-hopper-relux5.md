# Phil Hopper Relux5

**Status:** `research` (promovida ao Studio)  
**ID / slug Studio:** `phil-hopper-relux5`  
**Nome na UI:** **Phil Hopper Relux5**  
**Family:** `carry`  
**Runner:** `phil-hopper-relux5-runner@1` · [`labs/legacy/strategy-runners/portable/phil-hopper-relux5-runner.js`](../../../labs/legacy/strategy-runners/portable/phil-hopper-relux5-runner.js)  
**Lab:** [`labs/strategies/carry/phil-hopper-relux5/`](../../../labs/strategies/carry/phil-hopper-relux5/)  
**Fonte live:** [`polymarket-fm/Phil_Hopper_Real_Redux_Relux5.py`](../../../../polymarket-fm/Phil_Hopper_Real_Redux_Relux5.py)  
**Doc live:** [`polymarket-fm/docs/ESTRATEGIA_SHOTANDGO_PHIL_HOPPER_RELUX5.md`](../../../../polymarket-fm/docs/ESTRATEGIA_SHOTANDGO_PHIL_HOPPER_RELUX5.md)

---

## Não confundir com ShotandGo V1

| | `shotandgo-v1` | `phil-hopper-relux5` |
|---|---|---|
| Fonte | `Phil_Hopper_Real.py` | `Phil_Hopper_Real_Redux_Relux5.py` |
| Escada | SUB 55–90 · DESC 45–10 (8+8) | SUB 55–65 · DESC 36–10 (**5+5**) |
| MULT | `[2,3,4,5,6,6]` + contagio global | lista longa Relux5 · contagio **off** |
| Geração | não | **sim** — reset da escada a cada reversão |
| Saída | STOP mark-to-bid / venda | **TRAVA** + ExtraTrava · **não vende** |
| Proteções | PISO, MAX_VIRADAS, DESC_MODO | + VIRADA_SO_ATRAS, PAUSA_LIDER, TETO_INVEST, MULT_CALC, espera abertura |

Labs e runners são **independentes**. Não editar `shotandgo-v1` / `shotandgo-runner` para calibrar a Relux5.

---

## Mecânica (resumo)

1. Grade dual UP/DOWN: SUB 55…65¢ e DESC 36…10¢ · 10sh base.
2. Disparo + re-arme do par complementar (mesmo idx).
3. Virada registra entrada/reversão; com `geracaoAtiva` a reversão cancela e remonta a escada.
4. MULT por virada do nível; MULT_DESC no lado barato; MULT_CALC a partir da 6ª virada.
5. TRAVA: lado barato alcança o caro + soma médias &lt; 100c + pior caso ≥ $0 → encerra.
6. EQUALIZE a 5c (taker) ou limite maker antecipada (arma ≤10c / cancela ≥40c).
7. Settlement: payout = shares do vencedor − investido (sem venda).

Flags off no default (params existem): EQ-STOP, BLOCO27, SUB35, EXTRA.

---

## Superfície de execução

| Modo | SUB / EQ | DESC / ExtraTrava |
|---|---|---|
| `honest` (default) | walk + FOK + slip | resting até atravessar |
| `optimistic` | fill no ask | fill imediato no nível |

Fees: somente via `applyPolymarketFees` no pós-processador do lab.

---

## Smoke

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
npm run package:strategy-library -- --source labs/legacy/strategy-runners/portable/phil-hopper-relux5-runner.js --slug phil-hopper-relux5-runner --name "Phil Hopper Relux5" --version 1
npm run embed:strategy-libraries
npm run lab:run -- --experiment labs/strategies/carry/phil-hopper-relux5/experiments/smoke.json
```

---

## Status de port

- [x] Runner portable + library pack
- [x] Lab scaffold (defaults = config Python atual)
- [ ] Sweep mai–jun honest + holdout
- [ ] Paridade fill-a-fill com shadow Relux5 (opcional)
