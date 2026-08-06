# Auditoria causal — Causal Lead Settlement V1

**Data:** 06/08/2026  
**Decisão:** `CANDIDATE / HOLD`  
**Escopo:** research/backtest; nenhuma ordem real, credencial ou `.env` foi usada.

## Resultado executivo

Foi encontrada uma hipótese nova que permanece positiva depois das correções que reprovaram a Early Favorite Rush: ordem temporal causal, rótulo resolvido Gamma, preço real no instante de entrada, taxa taker oficial, profundidade total no best ask, um trade por evento e bankroll finito.

O candidato congelado gerou, em 96 dias e 6.239 trades, PnL bruto pré-taxa de **+US$4.239,64**, taxas de **US$1.005,93**, PnL líquido de **+US$3.233,71**, PF líquido **1,243** e MaxDD **US$125,01**. Os três blocos temporais ficaram positivos. Ainda não há OOS virgem nem fill FAK medido; por isso o veredito não é `validated` nem autoriza live.

## Falha encontrada no lab anterior

Os CSVs Binance 1s contêm `open_time`, OHLC e `close_time`. O lab indexava o `close` por `open_time`, disponibilizando até quase 1 segundo de informação futura. No smoke de 04/08, corrigir somente esse ponto reduziu o scalp taker de +US$94,85/PF 2,97 para +US$57,74/PF 2,14; adicionar 1 segundo de atraso reduziu para +US$13,47/PF 1,30, e 2 segundos para +US$2,92/PF 1,07.

O runner agora usa `close_time`, arredonda a disponibilidade para o segundo seguinte e oferece `open-legacy` apenas para reproduzir o artefato.

## Metodologia congelada

- Treino: 01/05–15/06.
- Validação: 16/06–15/07.
- Desafio temporal sem retuning: 16/07–04/08.
- O vencedor resolvido veio do journal Gamma `scratch/canonical-outcomes-v1.csv`, com 28.077/28.077 eventos do lake cobertos e zero conflitos na sincronização de 06/08.
- Ticks exigem `coverage >= 0.99`, `degraded=false` e deduplicação por `condition_id, ts`.
- Taxa: `shares * 0.07 * p * (1-p)`; somente entrada taker.
- Entrada: full top-of-book, `askSz >= shares`; uma por evento; custo <= US$5 e <=10 shares.
- Saída: settlement do rótulo resolvido, sem proxy maker.

## Resultados por bloco

| Bloco | Trades | WR | Bruto | Taxas | Líquido | PF | MaxDD |
|---|---:|---:|---:|---:|---:|---:|---:|
| Treino | 3.730 | 46,43% | +US$2.926,93 | US$602,92 | +US$2.324,01 | 1,296 | US$108,70 |
| Validação | 1.632 | 42,95% | +US$757,01 | US$263,05 | +US$493,96 | 1,137 | US$125,01 |
| Desafio | 877 | 43,67% | +US$555,71 | US$139,96 | +US$415,75 | 1,221 | US$65,55 |
| Total descritivo | 6.239 | 45,14% | +US$4.239,64 | US$1.005,93 | +US$3.233,71 | 1,243 | US$125,01 |

Por mês no lag de 1 segundo: maio +US$1.921,82; junho +US$408,98; julho +US$767,37; agosto 01–04 +US$135,54. O resultado não depende de win rate acima de 50%: o preço de entrada abaixo de 0,50 torna a vitória maior que a perda unitária.

## Cauda e capital

- Pior trade: -US$5,17; melhor: +US$7,37.
- Maior streak de perdas: 12.
- Pior dia: 29/06, -US$86,38; 68/96 dias positivos.
- Exposição máxima por evento incluindo fee: US$5,18.
- Capital mínimo exato para não interromper este path: US$36,42. Replay com US$25 teve shortfall no trade 100; US$50 concluiu. Isso não é margem de segurança nem recomendação de capital.
- Um stop diário de US$15 pulou 2.248/6.239 trades, reteve apenas 75,5% do lucro e piorou o DD total para US$140,42. Nenhum stop diário testado foi estável em treino, validação e desafio.

## Stress

O atraso de 2 segundos ainda foi positivo no agregado (5.214 trades, bruto +US$2.224,43, líquido +US$1.383,81, PF 1,119), mas julho ficou -US$23,37 e o DD subiu para US$291,32. Slippage de +2 centavos preservou PnL +US$1.964,96/PF 1,141, mas levou o DD a US$305,51. Esses resultados sustentam pesquisa, não validação de execução.

## O que está medido, inferido e desconhecido

**Medido no replay:** sinal causal em grain de 1s; asks/bids e top depth observados; taxas; vencedores Gamma; splits temporais; cauda e bankroll.

**Inferência conservadora:** `signalLagSec=1` representa aproximadamente 1–2 segundos entre disponibilidade da kline e snapshot de entrada. O stress de 2 segundos representa aproximadamente 2–3 segundos.

**Desconhecido:** taxa real de fill FAK, slippage entre snapshot e match, latência ponta a ponta atual, diferenças entre Gamma e finalidade on-chain/CLOB e desempenho em dados posteriores a 04/08.

## Gate e veredito

`CANDIDATE / HOLD`. A próxima ação correta é shadow read-only, não micro-live: registrar pelo menos 7 dias e 500 sinais com snapshot, limite FAK teórico, fillability, latência e resolução. Exigir PF líquido >=1,10, resultado não negativo no bucket de latência p90 e zero orphan. Depois disso, um novo bloco OOS deve ser executado uma única vez com a configuração congelada.

Artefatos principais:

- `labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs`
- `src/research/causalLeadSettle.js`
- `tests/causalLeadSettle.test.js`
- `.tmp/causal-lead-settle-v1/analysis.json`
- `labs/sandbox/binance-lead-scalp/reports/scalp-2026-05-01_2026-08-04_settle_causal-settle-a2550-full-final.json`
- `labs/sandbox/binance-lead-scalp/reports/scalp-2026-05-01_2026-08-04_settle_causal-settle-a2550-lag2-stress.json`

