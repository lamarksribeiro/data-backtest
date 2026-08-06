# Causal Lead Settlement V1 (CLS-v1)

**Status em 06/08/2026:** `CANDIDATE / HOLD` para pesquisa e shadow read-only. Não está autorizada para conta real.

## Ideia central

Comprar uma única vez o lado indicado por um impulso causal da Binance, somente quando o book da Polymarket ainda oferece o token entre 0,25 e 0,50, e manter até a resolução. A estratégia troca a alta taxa de acerto da Early Favorite Rush por uma assimetria melhor: cada perda pode consumir todo o custo da entrada, mas uma vitória comprada abaixo de 0,50 paga mais que a perda unitária.

O sinal usa o **close realmente disponível** da kline Binance de 1 segundo. Indexar esse close pelo horário de abertura antecipava quase 1 segundo de informação e foi proibido no runner.

## Regra congelada

1. BTC 5m, ticks com `coverage >= 0.99`, `degraded=false` e timestamps deduplicados.
2. Retorno Binance em 2 segundos na direção UP/DOWN.
3. Limiar adaptativo `clamp(2.5 * sigma_300s, US$5, US$20)`.
4. Usar a kline somente depois de seu close e esperar mais 1 segundo inteiro no replay (`signalLagSec=1`).
5. `tau` restante entre 20 e 280 segundos.
6. Ask executável do lado entre 0,25 e 0,50; spread no máximo 0,04.
7. Mudança absoluta do mid desde o início da janela do impulso no máximo 0,03.
8. Profundidade no best ask suficiente para 100% das shares.
9. `shares = min(US$5 / ask, 10)`, mínimo de 5 shares.
10. Uma entrada taker/FAK por evento, sem reentrada, martingale ou hedge.
11. Manter até a resolução. O replay usa o vencedor resolvido na Gamma; isso não equivale a prova on-chain/CLOB de finalidade.

## Evidência medida

| Bloco | Dias | Trades | PnL bruto pré-taxa | Taxas | PnL líquido | PF líquido | MaxDD |
|---|---:|---:|---:|---:|---:|---:|---:|
| Treino 01/05–15/06 | 46 | 3.730 | +US$2.926,93 | US$602,92 | +US$2.324,01 | 1,296 | US$108,70 |
| Validação 16/06–15/07 | 30 | 1.632 | +US$757,01 | US$263,05 | +US$493,96 | 1,137 | US$125,01 |
| Desafio temporal 16/07–04/08 | 20 | 877 | +US$555,71 | US$139,96 | +US$415,75 | 1,221 | US$65,55 |
| Total descritivo | 96 | 6.239 | +US$4.239,64 | US$1.005,93 | +US$3.233,71 | 1,243 | US$125,01 |

O desafio não é chamado de OOS virgem: 04/08 foi visto no smoke causal e partes de julho/agosto já apareceram em outras pesquisas do projeto. A tentativa de obter 05/08 depois do congelamento falhou porque a partição ainda não existia no Brutus.

## Defesa e cauda

- Risco máximo observado por entrada, com taxa: US$5,18.
- Pior trade: -US$5,17; maior sequência de perdas: 12.
- 68 de 96 dias positivos (70,83%); pior dia: -US$86,38.
- Capital inicial mínimo para atravessar exatamente este replay: US$36,42. US$25 ficou sem caixa; US$50 atravessou. Isso é dependente da ordem histórica, não recomendação de banca.
- Stops diários entre -US$10 e -US$40 e limites de trades cortaram retorno sem reduzir o DD de modo estável. O stop de -US$15, por exemplo, capturou apenas 75,5% do PnL total e elevou o DD total de US$125,01 para US$140,42. Rejeitado.

## Stress sem retuning

| Stress | PnL líquido | PF | MaxDD | Observação |
|---|---:|---:|---:|---|
| Atraso de 2s | +US$1.383,81 | 1,119 | US$291,32 | julho -US$23,37 |
| +1 centavo na entrada | +US$2.597,42 | 1,190 | US$186,12 | ainda positivo |
| +2 centavos na entrada | +US$1.964,96 | 1,141 | US$305,51 | cauda cresce muito |
| Taxa 2x | +US$2.227,75 | 1,161 | US$249,03 | ainda positivo |
| +1c e taxa 1,25x | +US$2.343,84 | 1,170 | US$222,99 | ainda positivo |

## Gate seguinte

Permanece `HOLD` até existir um bloco novo não usado na seleção e shadow read-only medindo sinal → tentativa FAK → fill real, latência e slippage. Gate mínimo sugerido: pelo menos 7 dias e 500 sinais, PF líquido >= 1,10 no ledger de fills, nenhum orphan e resultado não negativo no stress de latência p90. Falhar qualquer item rejeita a promoção.

## Reprodução

```powershell
node --max-old-space-size=8192 labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs `
  --from 2026-05-01 --to 2026-08-04 `
  --binance-time close --signal-lag-sec 1 --lead-sec 2 `
  --impulse-usd 8 --impulse-vol-mult 2.5 --impulse-floor 5 --impulse-cap 20 `
  --stale-mid 0.03 --min-tau 20 --max-tau 280 `
  --min-ask 0.25 --max-ask 0.50 --exit-mode settle `
  --budget 5 --sizing sharesCap --shares-cap-ask 0.5 `
  --ask-size-mult 1 --max-trades 1 --dump-trades `
  --tag causal-settle-a2550-full-final

node scratch/analyze-causal-lead-settle.mjs
```

Relatório de auditoria: [`../../../reports/research/causal-lead-settlement-audit-2026-08-06.md`](../../../reports/research/causal-lead-settlement-audit-2026-08-06.md).

