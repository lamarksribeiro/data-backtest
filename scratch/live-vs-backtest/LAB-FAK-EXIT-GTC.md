# Lab — correção FAK-exit → GTC (proxy de proteção)

**Data:** 2026-07-25  
**Motivação:** validar no lab o valor da correção `exitOrderType: FAK → GTC` (`RELATORIO-COMPLEMENTAR-CORRECAO-FAK-EXIT.md`).  
**Limitação:** o motor GLS não simula FAK/GTC CLOB. Ablatamos o **resultado** da saída protetora:

| Variante | Proxy | Params |
|----------|--------|--------|
| `gtc-full-protect` | GTC ok (canário atual no BT) | reverse + exit + danger ON |
| `gtc-reverse-no-danger` | GTC ok, só late-flip | reverse + exit ON, danger OFF |
| `fak-miss-exit-only` | SELL ok, BUY reverse falha | reverse OFF, exit + danger ON |
| `fak-miss-hold` | FAK kill total sem retry | reverse/exit/danger OFF → hold expiry |

Budget: micro canário `$2/$4`, dist 40, tier 2.0×, maxAsk 0.94.

**Experimentos:**
- `labs/.../experiments/fak-exit-gtc-live-window.json` (2026-07-24→25)
- `labs/.../experiments/fak-exit-gtc-holdout.json` (2026-07-01→22)

**Reports Brutus:**
- `reports/labs/midas-carry-v1/2026-07-25T17-35-01-307Z-fak-exit-gtc-live-window`
- `reports/labs/midas-carry-v1/2026-07-25T17-37-49-097Z-fak-exit-gtc-holdout`

---

## Resultados — janela live (24–25/07, 125 entries)

| Rank | Variante | PnL | WR% | PF | Max DD |
|---:|---|---:|---:|---:|---:|
| 1 | gtc-reverse-no-danger | **25,54** | 80,8 | 1,73 | **4,11** |
| 2 | fak-miss-exit-only | 25,56 | 80,0 | **1,83** | 5,12 |
| 3 | gtc-full-protect | 24,22 | 79,2 | 1,68 | **4,11** |
| 4 | fak-miss-hold | **21,77** | 83,2 | 1,59 | **7,86** |

Δ **full-protect − hold** = **+$2,45** (+11%) · DD quase **metade** (4,1 vs 7,9).

Amostra curta: exit-only ≈ full-protect em PnL (reverse às vezes erra neste par de dias — alinhado ao caso live `1784953500`).

---

## Resultados — holdout julho (01–22/07, 2101 entries)

| Rank | Variante | PnL | WR% | PF | Max DD |
|---:|---|---:|---:|---:|---:|
| 1 | gtc-reverse-no-danger | **431,43** | 81,9 | **1,60** | 15,78 |
| 2 | gtc-full-protect | **417,86** | 81,4 | 1,58 | 15,60 |
| 3 | fak-miss-exit-only | 298,59 | 79,9 | 1,45 | **13,17** |
| 4 | fak-miss-hold | **246,89** | 81,8 | 1,33 | **17,15** |

### Deltas vs `fak-miss-hold` (pior caso FAK)

| Variante | ΔPnL | ΔPnL% | ΔPF |
|----------|-----:|------:|----:|
| gtc-full-protect | **+$171** | **+69%** | +0,25 |
| fak-miss-exit-only | +$52 | +21% | +0,12 |
| gtc-reverse-no-danger | **+$185** | **+75%** | +0,27 |

**Valor do reverse** (full-protect − exit-only) ≈ **+$119** no holdout — a perna que a saga REVERSE precisa completar após o SELL.

---

## Veredito lab → correção GTC

1. **A correção FAK→GTC na saída é suportada pelo lab.** Perder a proteção (proxy FAK miss → hold) custa ~**40% do PnL** do canário micro no holdout e piora DD.
2. **Só EXIT (sem reverse)** recupera pouco (~21%); o grosso do edge protetor está no **reverse bem-sucedido** — exatamente o caminho que `REVERSE_EXIT_INCOMPLETE` quebrava no live com FAK.
3. **Danger exit** no holdout é neutro/ligeiramente negativo vs reverse-only (417 vs 431) — manter ligado no canário é ok; não é o driver.
4. **Limite do proxy:** lab assume fill quando há book; GTC real ainda pode ficar residual. O lab mede o **teto** do ganho se a saída protetora voltar a completar; não substitui observação pós-deploy (`orphanOrders`, taxa `REVERSE_EXIT_INCOMPLETE`).

### Recomendação operacional

1. **Deploy** `exitOrderType: GTC` (já no código).  
2. 24h monitor: `REVERSE_EXIT_INCOMPLETE` ↓ e `orphanOrders≈0`.  
3. Manter breadcrumb lateFlip (S3) para fechar A1.  
4. Não desligar reverse no canário — lab mostra que é a peça cara.

## Reproduzir

```powershell
# no container Brutus (após docker cp dos experiments)
node labs/cli/run.js --experiment labs/strategies/terminal/midas-carry-v1/experiments/fak-exit-gtc-live-window.json --variant-workers 4
node labs/cli/run.js --experiment labs/strategies/terminal/midas-carry-v1/experiments/fak-exit-gtc-holdout.json --variant-workers 4
```
