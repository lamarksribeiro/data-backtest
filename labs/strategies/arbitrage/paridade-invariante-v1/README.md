# Paridade Invariante V1

Status: **research** · mercado: Polymarket BTC Up/Down 5m · direção: **nenhuma**

## Tese

Um mercado binário padrão tem dois tokens complementares. Quantidades iguais de
UP e DOWN formam um conjunto completo: qualquer que seja o vencedor, o payout do
par é US$ 1. A estratégia não estima probabilidade e não escolhe lado; ela compra
as duas pernas somente quando o payout supera o custo executável total.

Para `q` pares:

```text
custo(q) = walkAskUP(q) + walkAskDOWN(q)
fee(q)   = Σ [qtyFill × 0,07 × preçoFill × (1 − preçoFill)]
net(q)   = q − custo(q) − fee(q)
guard(q) = net(q) − q × reservaOperacional
```

Há entrada apenas quando:

```text
guard(q) / q >= minNetEdgePerShare
guard(q)     >= minNetProfitUsd
custo(q)    <= maxEventNotional
```

Se UP vencer, `q` UP pagam `q`. Se DOWN vencer, `q` DOWN pagam `q`. O PnL do
conjunto completo é idêntico nos dois cenários.

## Por que não é a Escada Dupla

A Escada compra as pernas em momentos diferentes e pode terminar desequilibrada.
A Paridade Invariante:

- não inicia uma posição direcional deliberadamente;
- exige a mesma quantidade nas duas pernas;
- calcula o preço varrendo os 25 níveis reais dos dois asks;
- inclui taxa taker em cada fill;
- descarta gaps de um tick;
- reavalia tudo depois da latência simulada;
- executa no máximo um conjunto por evento no preset conservador.

## Resultado da sonda do lake

Janela: 2026-04-23 a 2026-07-25, 94 dias.

Filtros: evento não degradado, cobertura ≥ 99%, 15–285 segundos restantes,
spread ≤ 3¢ em ambos os lados, fee crypto 0,07, edge líquido mínimo 0,5¢ e
reserva operacional de 0,2¢ por par.

| Etapa | Ticks | Eventos |
|---|---:|---:|
| Book válido | 12.629.072 | 24.657 |
| Edge top-of-book ≥ 0,7¢ | 29 | 23 |
| 2 confirmações + 1 tick de latência | 2 | **1** |

Também foi sondada a direção reversa — criar pares via split e vender
UP+DOWN quando a soma dos bids líquidos supera US$ 1. Houve 27 ticks aparentes
em 21 eventos, mas **nenhum** sobreviveu às confirmações e à latência. Ela foi
excluída do runner por falta de uma oportunidade persistente no lake.

Os maiores “edges” de um único tick desapareceram em ~0,5 s. Eles são tratados
como descoordenação de snapshots, não como lucro.

O único evento persistente ocorreu em 2026-07-02:

- UP ask 0,15 e DOWN ask 0,81;
- janela observada de aproximadamente 2 segundos;
- profundidade no melhor ask: 86,04 UP e 377,92 DOWN;
- 20 pares: líquido teórico US$ 0,40604; após reserva: US$ 0,36604;
- 80 pares: líquido teórico US$ 1,62416; após reserva: US$ 1,46416.

Isso prova que o invariante existe, mas também que a frequência taker observada
é baixa demais para sustentar uma tese de enriquecimento.

Validação do dia candidato no runner completo, incluindo 25 níveis e taxas:

| Variante | Pares | Notional | PnL líquido | Entradas |
|---|---:|---:|---:|---:|
| `guarded-default` | 80 | US$ 76,80 | US$ 1,62416 | 1 |
| `fixed-20` | 20 | US$ 19,20 | US$ 0,40604 | 1 |
| `latency-3ticks` | — | — | US$ 0,00 | 0 |

O “100% de acerto” das duas primeiras linhas representa **uma única operação**
completa e não é uma estimativa confiável de taxa de acerto futura.

Reprodução da sonda:

```powershell
npm run analyze:paridade-invariante
```

Backtest do lake completo:

```powershell
npm run lab:run -- --experiment labs/strategies/arbitrage/paridade-invariante-v1/experiments/full-lake-guarded.json
```

Reprodução exata das três variantes no dia candidato:

```powershell
npm run lab:run -- --experiment labs/strategies/arbitrage/paridade-invariante-v1/experiments/candidate-day-validation.json
```

O experimento usa blocos de 7 dias. A tentativa monolítica de carregar os
aproximadamente 16 milhões de ticks excedeu a memória disponível; o modo
particionado mantém o universo integral sem exigir que todo o lake caiba em
memória ao mesmo tempo.

## Limite decisivo: as pernas não são atômicas entre outcomes

FOK torna cada ordem individual “tudo ou nada”, mas não transforma duas ordens
UP/DOWN em uma transação atômica. Até a segunda perna confirmar, existe risco de
legging. Por isso o modelo histórico é identificado explicitamente como
`paired_fok_snapshot_non_atomic`: ele mede o teto executável do snapshot, não
autoriza operação real.

Um executor live seguro precisaria da máquina de estados:

```text
OBSERVE
  -> CONFIRM
  -> PLAN_BOTH_FOK
  -> FIRST_LEG_CONFIRMED
  -> SECOND_LEG_CONFIRMED
  -> RECONCILE_EQUAL_QTY
  -> MERGE_COMPLETE_SET
```

Se a segunda perna falhar, o executor deve reconciliar fills e aplicar uma única
política previamente aprovada: completar dentro de um preço-resgate limitado ou
desfazer a primeira perna e travar o evento. Repetir cegamente a ordem é proibido.

## Gates antes de qualquer capital

1. Validar ao vivo em shadow a simultaneidade dos dois books e a duração das
   janelas por pelo menos 30 dias.
2. Medir latência `snapshot → assinatura → ACK → fill` e rejeitar se o p95 não
   couber na persistência observada.
3. Implementar reconciliação por fills confirmados, não por ACK de API.
4. Demonstrar, em replay com leg failure, perda máxima limitada e kill switch.
5. Só então propor um micro-canário, sempre mediante aprovação explícita.

## Referências de protocolo

- CTF / conjunto completo: https://docs.polymarket.com/trading/ctf/overview
- Merge de posições: https://docs.polymarket.com/trading/ctf/merge
- Taxas: https://docs.polymarket.com/trading/fees
- FOK, FAK e batch: https://docs.polymarket.com/trading/orders/create
