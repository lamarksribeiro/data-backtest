# Hopper 4 — estudo de otimização e risco (2026-07-14)

## Veredito executivo

A versão `v2 · BTC Champion (Stop-Reverse)` não é segura para capital real. O resultado usado para promovê-la foi superajustado à janela de 2026-06-01..14 e foi medido em modo diário, que reinicia a banca entre os dias. Na execução contínua de 2026-07-01..13, a versão perdeu **US$ 5.155,14**, teve **PF 0,921** e **drawdown de US$ 9.356,48** com uma banca configurada em US$ 100.

A melhor candidata encontrada mantém o stake base fixo e só começa a monitorar nos últimos 120 segundos:

```json
{
  "walletMaxCap": 100,
  "monitoringWindowSec": 120
}
```

Os demais parâmetros permanecem iguais aos do preset atual. Essa candidata fez **+US$ 4.535,84**, com **PF combinado 1,148**, em 82 dias (2026-04-23..2026-07-13), incluindo taxas taker e book top 25. Ela permaneceu positiva nos quatro blocos temporais analisados.

Mesmo assim, ela ainda não deve ser promovida sem controles duros de capital. Com lote mínimo de 10 shares, o drawdown observado é incompatível com uma banca de US$ 100.

## Diagnóstico da execução desastrosa

Fonte: Backtest Studio `#161`, BTC 5m, 2026-07-01..13.

| Métrica | Resultado |
|---|---:|
| PnL líquido | -US$ 5.155,14 |
| Drawdown máximo | US$ 9.356,48 |
| Profit factor | 0,921 |
| Acerto | 80,54% |
| Média vencedora | US$ 21,78 |
| Média perdedora | US$ 97,86 |
| Maior perda | US$ 1.292,50 |
| Taxas | US$ 12.961,24 |
| Volume | US$ 569.158,89 |

O acerto alto é enganoso. Com ganho/perda médio de aproximadamente 0,22, o ponto de equilíbrio exige cerca de 81,8% de acerto; a execução entregou 80,5%.

Antes das taxas, a execução teria aproximadamente +US$ 7.806. As taxas taker de US$ 12.961 consumiram todo esse resultado e mais US$ 5.155.

### Cauda criada pelas viradas

| Viradas no evento | Eventos | Acerto | PnL líquido | Taxas | PnL médio |
|---:|---:|---:|---:|---:|---:|
| 0 | 1.782 | 97,6% | +US$ 24.471,16 | US$ 1.251,75 | +US$ 13,73 |
| 1 | 1.040 | 74,3% | +US$ 14.298,70 | US$ 3.345,76 | +US$ 13,75 |
| 2 | 411 | 46,5% | -US$ 8.151,75 | US$ 3.699,46 | -US$ 19,83 |
| 3 | 194 | 29,4% | -US$ 35.773,25 | US$ 4.664,26 | -US$ 184,40 |

No pior evento, a estratégia começou com 73 shares e escalou para 219, 438 e 876 shares. A perda de US$ 1.292,50 ocorreu com `walletSize = 100` porque o runner:

- usa `walletMaxCap = 1000` para aumentar o lote conforme o PnL acumulado;
- não reserva saldo para ordens abertas;
- não limita exposição por evento;
- continua operando depois de a equity ficar negativa;
- força `minShares = 10` mesmo quando a banca já não suporta o risco.

## Problema no processo que escolheu o campeão

O sweep original de 2026-06-01..14 reportou +US$ 2.832,43, PF 1,06 e DD US$ 2.748,07, mas teve apenas 4 de 14 dias positivos. O melhor dia foi +US$ 3.326,16; sem esse dia, o agregado teria sido -US$ 493,74.

Além disso, `dailyMetrics: true` reinicia o runner e a banca em cada dia. Isso é inválido para a versão com sizing dependente da equity. Na mesma janela de julho:

- laboratório diário: +US$ 282,14;
- execução contínua (`single-pass`): -US$ 5.155,14.

Sweeps diários só são equivalentes quando o lote é realmente fixo e não depende da equity acumulada.

## Testes de otimização

Foram testadas 22 configurações de viradas, multiplicadores, FOK, trigger e janela de entrada. Depois, os finalistas foram repetidos em `single-pass`.

As versões sem virada e com apenas uma ou duas viradas ficaram negativas em julho. O ganho veio de duas mudanças simples:

1. travar `walletMaxCap` em 100, mantendo a entrada base em 10 shares;
2. evitar os primeiros minutos do evento e iniciar o monitoramento mais tarde.

### Sensibilidade da janela

| Janela | PnL 23/04–30/06 | PF | PnL 01/07–13/07 | PF | PnL combinado | PF combinado |
|---:|---:|---:|---:|---:|---:|---:|
| 120 s | +US$ 3.661,03 | 1,139 | +US$ 874,81 | 1,205 | +US$ 4.535,84 | 1,148 |
| 150 s | +US$ 3.097,04 | 1,093 | +US$ 1.153,12 | 1,228 | +US$ 4.250,15 | 1,110 |
| 180 s | +US$ 1.888,12 | 1,045 | +US$ 907,30 | 1,142 | +US$ 2.795,42 | 1,058 |
| 210 s | -US$ 562,14 | 0,989 | +US$ 837,24 | 1,108 | +US$ 275,10 | 1,005 |
| 240 s | -US$ 1.467,91 | 0,976 | +US$ 1.201,79 | 1,136 | -US$ 266,11 | 0,996 |

A faixa 120–180 segundos funciona nos dois períodos; acima de 210 segundos o histórico anterior a julho deixa de ter edge. A janela de 120 segundos foi escolhida por ter maior PnL combinado, melhor PF combinado e menor volume/taxas.

### Splits da candidata de 120 segundos

| Split | Dias | PnL | Dias positivos | PF diário | PnL sem o melhor dia |
|---|---:|---:|---:|---:|---:|
| 23/04–31/05 | 39 | +US$ 1.450,33 | 25 | 1,659 | +US$ 1.108,69 |
| 01/06–14/06 | 14 | +US$ 1.043,47 | 10 | 7,541 | +US$ 760,39 |
| 15/06–30/06 | 16 | +US$ 1.167,24 | 12 | 5,621 | +US$ 888,00 |
| 01/07–13/07 | 13 | +US$ 874,81 | — | PF por trade 1,205 | — |

O teste de julho foi contínuo e teve DD de US$ 253,61, maior perda de US$ 166,54 e recovery factor 3,45. A tentativa de executar os 82 dias completos em `single-pass` excedeu o limite de ArrayBuffer do loader. Nos fechamentos diários, o drawdown acumulado já chegou a pelo menos US$ 645,86 no primeiro split; portanto, US$ 100 não é capital suficiente.

## O que deve ser feito

### 1. Retirar o campeão atual de produção

Não usar a versão v2 com `walletMaxCap = 1000` em paper ou real. Ela pode continuar apenas como referência histórica.

### 2. Manter a candidata como pesquisa

Parâmetros centrais:

```json
{
  "walletMaxCap": 100,
  "monitoringWindowSec": 120,
  "triggerCents": 55,
  "cooldownFlipSec": 35,
  "multVirada": "3,6,12,24,36",
  "maxViradas": 3,
  "fokEnabled": false
}
```

O cap fixo impede o compounding, mas não impede perda maior que a banca.

### 3. Implementar controles obrigatórios no runner

- `maxEventLossUsd` ou `maxEventLossPct`, incluindo perdas já realizadas nas viradas;
- `maxOrderShares` e `maxOpenNotionalUsd`;
- não abrir ordem quando o saldo livre não cobre o pior caso;
- `haltEquityUsd`/circuit breaker diário e global;
- nunca permitir nova entrada depois de `equity <= 0`;
- rejeitar execução quando o book não comportar todo o lote, em vez de preencher o restante no último preço disponível;
- registrar exposição máxima e risco máximo por evento nas métricas.

### 4. Corrigir a validação

- proibir promoção de estratégias equity-dependent a partir de `dailyMetrics: true`;
- exigir replay contínuo final ou runner stateful entre chunks;
- ranquear por robustez, não só PnL: PF mínimo por split, recovery, concentração por dia, taxas e DD/capital;
- corrigir `expectancy` e `riskOfRuin` para refletirem o PnL pós-taxa;
- corrigir `eventsWithEntries`/`avgPnl` nos relatórios do laboratório.

### 5. Capital e forward test

Com lote base de 10 shares, uma banca de US$ 100 é inviável: uma única perda observada foi US$ 166,54. Pelo drawdown de fechamentos já observado, seriam necessários pelo menos cerca de US$ 3.300 para que o DD ficasse abaixo de 20%; como o DD contínuo integral não foi medido, usar margem conservadora e não testar com menos de aproximadamente US$ 5.000 em paper.

Depois dos controles de risco, rodar ao menos 14–30 dias em paper com execução realista de fila, latência, rejeições e partial fills. Promover somente se PF pós-taxa permanecer acima de 1,10 e DD ficar dentro do limite definido sobre capital real.

## Artefatos reproduzíveis

- `labs/strategies/carry/hopper-4/experiments/optimization-oos-july.json`
- `labs/strategies/carry/hopper-4/experiments/optimization-oos-july-single-pass.json`
- `labs/strategies/carry/hopper-4/experiments/optimization-oos-july-refine-single-pass.json`
- `labs/strategies/carry/hopper-4/experiments/validation-pre-july-window.json`
- `labs/strategies/carry/hopper-4/experiments/validation-july-window-single-pass.json`
- `labs/strategies/carry/hopper-4/experiments/candidate-window120-full-single-pass.json`

