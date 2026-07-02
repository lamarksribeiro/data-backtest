# labs/mining — mineração de padrões sobre o cubo de features

Implementação da camada de descoberta descrita em
`docs/analise-quantitativa/guia-sistema-descoberta-padroes.md` (fases D1–D2).
Resultados registrados no `docs/analise-quantitativa/catalogo-anomalias.md` (Ciclo 11).

## Scripts

| Script | Função |
|---|---|
| `build-cube.js` | Constrói o cubo: 1 linha por tick de decisão (cadência 5s), features sem look-ahead + labels de PnL líquido (varredura depth 25 + fee 0.07, $10, hold-to-settlement). Saída em `cube/dt=*.csv` (resume automático; delete o CSV para refazer o dia) |
| `lib/cube.js` | Loader do cubo em TypedArrays + `evalRule` (1 entrada/evento) + `summarize`/`maxDrawdown` |
| `champions.js` | Revalida os padrões do catálogo (whipsaw, SBRI, TAT, LIM, ANOM-15/26/34) com splits train/holdout/fresh |
| `mine-grid.js <family>` | Grid miner por família (`lim`, `postflip`, `lag`, `terminal`) |
| `evaluate-candidates.js` | Métricas completas + sensibilidade ±20% dos candidatos finais |
| `sensitivity-core.js` | Sensibilidade e consistência semanal da perna TFC-core |
| `portfolio.js` | Portfólio final TFC-core + LAG-strong + LIM-prime (correlação, equity, DD) |
| `bias-check.js` | Impacto do filtro `mkt_agree` (validação de label) nos candidatos |
| `check-manifest.js` / `audit-day.js` / `inspect.js` | Diagnóstico de partições, ticks brutos e trades individuais |

## Uso

```powershell
node --max-old-space-size=6144 labs/mining/build-cube.js --from 2026-04-23 --to 2026-06-27
node --max-old-space-size=8192 labs/mining/champions.js
node --max-old-space-size=8192 labs/mining/mine-grid.js terminal
node --max-old-space-size=8192 labs/mining/portfolio.js
```

## Port GLS (validação oficial — 2026-07-02)

As pernas do ciclo 11 foram portadas para labs GLS (motor `compiled-soa`, fills e fees oficiais):

| Perna | Lab | Resultado GLS (62d) | Veredito |
|---|---|---|---|
| TFC (ANOM-37) | `labs/strategies/terminal/tfc-v1` | +$1.874, exp +$0,46, fresh +$0,56, 45/62 dias positivos | **Campeão** (preset `btc-champion`) |
| LIM Prime (ANOM-39) | `labs/strategies/structural/lim-prime-v1` | +$266, PF 1,17, positivo em todos os splits | Candidate (perna complementar) |
| LAG Strong (ANOM-38) | `labs/strategies/microstructure/lag-strong-v1` | holdout −$16, fresh −$36 | **Rejeitado** (artefato da cadência 5s) |

Lição: sempre validar no lab GLS antes de promover — a avaliação por tick do motor oficial
gera 4–6× mais entradas que a cadência de 5s do cubo e pode diluir ou destruir o edge.

## Convenções do ciclo (não alterar durante mineração)

- Split temporal: train `< 2026-06-01`, holdout `>= 2026-06-01`, fresh `>= 2026-06-15`.
- Filtros de qualidade: `coverage >= 0.9`, `degraded = 0`, `mkt_agree != 0`
  (label do vencedor confirmado pelo mid do book no fim do evento).
- Ticks sem book não alimentam janelas de features (protege contra feed de spot stale
  intercalado — ver auditoria de 2026-05-29 12:52 no catálogo, Ciclo 11).
- `cube/*.csv` é derivado (não versionar; regenerável do lake).
