# Late Underdog Blast V1 — rejeitada

**Status:** rejeitada (lab) · **Lab:** `labs/strategies/terminal/late-underdog-blast-v1/` · **GLS:** `src/backtestStudio/gls/strategies/LateUnderdogBlastV1.gls` · **Data:** 2026-07-26

## Tese testada

Detectar explosão de odds/spot no fim do evento e comprar o **azarão** ainda “barato” (ask ≤ ~0.42), hold settlement.

Sinais: mom→PTB, colapso de distância, `favAskRise` + `dogAskDrop`, memória do ask mínimo do favorito no mid-late.

## Resultado

Train 35d: todas as variantes com amostra útil com PF &lt; 1. Melhor “positiva” (`violent`) teve **1 trade**. Smoke: WR 0% nas entradas.

Hipótese de “azarão barato na explosão” **não sobrevive** ao harness. Ver README do lab para tabela completa.

## Relação com Late Cheap Flip

| Estratégia | Lado | Lab |
|---|---|---|
| Late Cheap Flip mode3 | favorito barato | campeã holdout |
| Late Underdog Blast | azarão na explosão | rejeitada |

Não promover ao Studio até nova evidência (outro filtro / janela / asset).
