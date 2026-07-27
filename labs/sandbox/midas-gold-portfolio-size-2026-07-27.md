# MIDAS Gold — sizing portfolio live $2.5/$4 (2026-07-27)

**Núcleo:** g3-os · `tierAskBudgetFactor 1.5` · settle 0.995 · depth25 · FAK/GTC  
**Janela:** 2026-07-01 → 2026-07-25  
**Lab:** Brutus · `gold-portfolio-size-{btc,eth,sol,xrp,doge,hype}-july`  
**Pergunta:** o sizing live ($2.5/$4) preserva edge vs hold, comparando com Gold lab ($10/$30)?

## Tabela — variante `portfolio` ($2.5/$4)

| Ativo | PnL | WR | PF | n | MaxDD | Hold PnL | protect−hold | Veredito |
|-------|----:|---:|---:|--:|------:|---------:|-------------:|----------|
| **BTC** | **544.6** | 80.1% | **1.67** | 2144 | 14.6 | 288.9 | **+256** | **MANTER** |
| **ETH** | **279.4** | 76.9% | 1.35 | 1890 | 15.0 | 152.8 | **+127** | **MANTER** |
| **XRP** | **140.5** | 76.1% | **1.41** | 788 | 11.8 | 86.3 | **+54** | **MANTER** |
| **SOL** | **141.7** | 75.7% | 1.30 | 1060 | 12.5 | 128.5 | **+13** | **MANTER** (proteções finas) |
| **DOGE** | **112.5** | 78.3% | **1.40** | 723 | 10.4 | 31.3 | **+81** | **MANTER** |
| HYPE | 36.2 | 82.9% | 1.39 | 252 | 8.4 | 32.6 | **+3.6** | **NÃO promover** |

Referência `gold-10-30` na mesma janela: BTC 1934 · ETH 872 · SOL 497 · XRP 360 · DOGE 293 · HYPE 85.

## Achados

1. **Sizing live valida** — em todos os 5 ativos live, `portfolio` ≥ hold e PF ≥ 1.30.
2. **PF sobe no sizing menor** (BTC 1.58→1.67; ETH 1.26→1.35; XRP 1.28→1.41; DOGE 1.31→1.40) — cauda/DD escala quase linear; edge relativo melhora.
3. **DOGE não é o elo fraco no $2.5/$4** — protect−hold = +81 (melhor que SOL). No $10/$30 o hold era quase flat; no portfolio o hold sobe pouco e as proteções continuam valendo.
4. **SOL** é o mais frágil em valor das proteções (+13 vs hold). Ainda aprovado.
5. **HYPE** não entra no portfolio: poucas entradas e protect≈hold.
6. Soma PnL 5 ativos live (jul): **≈ 1219** em $2.5/$4; sem DOGE ≈ 1106.

## Critérios usados

- Aprovar: `portfolio.pnl >= portfolio-hold.pnl` e `PF >= 1.15`
- Preferir não promover: protect−hold &lt; +10 **e** n &lt; 400

## Experiments / reports

```
labs/strategies/terminal/midas-carry-v1/experiments/gold-portfolio-size-*-july.json
labs/strategies/terminal/midas-carry-v1/queues/portfolio-size-july.txt
labs/ops/brutus/run-portfolio-size-lab.sh
```

Reports no Brutus container `/app/reports/labs/midas-carry-v1/*-gold-portfolio-size-*-july`.

## Revisão portfolio (pós-lab)

| Decisão | Motivo |
|---------|--------|
| Manter BTC/ETH/SOL/XRP/DOGE | Todos passam protect≥hold no sizing live |
| Não adicionar HYPE | protect−hold irrisório |
| Priorizar monitor live em SOL | Menor delta de proteção |
| Corrigir account book / exposure | 5 engines com SHARE=0 e teto $16 “4×$4” desatualizado |
