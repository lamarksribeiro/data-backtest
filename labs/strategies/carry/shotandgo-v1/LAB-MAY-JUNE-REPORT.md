# Lab Shotandgo — mai–jun 2026 (pós-paridade)

**Rodado:** 2026-07-26  
**Report:** `reports/labs/shotandgo-v1/2026-07-26T21-10-37-330Z-shotandgo-live-honest-may-june`  
**Pré-condição:** shadow Phil → runner `honest` PASS (1 evento). Fees só no pós-processador.

## Gate pré-declarado

PF ≥ 1,2 **e** PnL > 0 em `executionMode=honest` na janela limpa.

**Resultado: NÃO PASSOU** — todas as 8 variantes com PnL ≪ 0 e PF &lt; 0,52.

## Ranking (mai–jun, sizeScale=1)

| Rank | Variante | PnL | Entries | Win% | PF | Max DD |
|------|----------|-----|---------|------|-----|--------|
| 1 | mult-flat1-honest | −72 586 | 16 934 | 46,1 | 0,51 | 2 698 |
| 2 | contagio-off-honest | −127 789 | 16 934 | 58,6 | 0,44 | 4 795 |
| 3 | no-stop-honest | −129 082 | 16 934 | 65,2 | 0,50 | 5 626 |
| 4 | optimistic-control | −129 663 | 16 935 | 61,3 | 0,38 | 5 169 |
| 5 | no-piso-honest | −130 276 | 16 934 | 58,8 | 0,44 | 4 906 |
| 6 | **python-live-honest** (baseline) | **−134 492** | 16 934 | 58,8 | **0,43** | 4 942 |
| 7 | desc-comprar-honest | −135 476 | 16 934 | 58,7 | 0,43 | 4 810 |
| 8 | python-live-honest-lat1 | −141 702 | 16 934 | 57,2 | 0,41 | 4 812 |

Baseline ≈ **−$7,9 / evento**. Longe da intuição de +$5 quando equaliza bem.

## Leitura

1. **Paridade ≠ edge.** O runner replica o Phil; a máquina em massa perde.
2. **MULT/martingale piora:** flat MULT=1 perde bem menos (−72k vs −134k). Contagio/PISO/STOP não salvam o baseline.
3. **Optimistic também explode** (−130k): não é só DESC resting / FOK.
4. **Win rate ~59% com PF 0,43** → vitórias pequenas, perdas grandes (assimetria típica de escada).
5. Smoke jul/20–21 (size 0,25): honest −1,2k / 469 entries — mesma direção.

## Smoke (plumbing)

`parity-smoke` 2026-07-20..21: OK tecnicamente; PnL negativo (julho congelado para candidatura).

## Implicações

- **Não** portar data-robot agora.
- **Não** micro-real com size cheio.
- Próxima research (se continuar): filtros de entrada / sizing baixo / MULT≤1 / análise de dias ruins — não mais “otimizar” o baseline Phil intacto esperando virar positivo.

## Comandos

```powershell
npm run lab:run -- --experiment labs/strategies/carry/shotandgo-v1/experiments/parity-smoke.json --variant-workers 2
npm run lab:run -- --experiment labs/strategies/carry/shotandgo-v1/experiments/live-honest-may-june.json --variant-workers 4
```
