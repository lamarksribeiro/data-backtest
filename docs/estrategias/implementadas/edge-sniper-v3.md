# Edge Sniper V3

**Edge Sniper V3** é a evolução compilada (hot path colunar / `compiled-soa`) da teoria documentada em [`edge-sniper-v2.md`](edge-sniper-v2.md). No `data-backtest` ela **substitui** o runner legado V2 no Backtest Studio.

* **Studio slug:** `edge-sniper-v3`
* **Kind:** compiled-native (modelos embutidos em Strategy JS, sem `strategyLibrary()`)
* **Teoria base:** [`edge-sniper-v2.md`](edge-sniper-v2.md)
* **Paridade V2:** [`../../referencia/paridade-edge-sniper-v2.md`](../../referencia/paridade-edge-sniper-v2.md)

---

## 1. O que mudou da V2 para a V3

| Aspecto | V2 (polymarket-test) | V3 (data-backtest) |
|---|---|---|
| Runtime | `edgeSniperBacktest.js` interpretado | Compilado SoA / Strategy JS nativo |
| Deploy | Acoplado ao serviço monolítico | Versão no Studio, checksum reprodutível |
| Performance | Loop objeto-por-tick | Hot path colunar (V4) |
| API de estratégia | `EDGE_SNIPER_V2` | `edge-sniper-v3` slug |

A lógica de negócio (distorção de edge, janelas, stops, stop-reverse) permanece alinhada à especificação V2; mudanças são de **plataforma e performance**, não de tese nova.

---

## 2. Hipótese (resumo)

Compra taker quando o ask do lado favorável está **abaixo** da probabilidade estimada de vitória, explorando hesitação de reprecificação do book em eventos de 5 minutos. Operação contínua ao longo do evento com filtros de distância ao PTB, spread, liquidez e gestão de saída (incluindo stop-reverse opcional).

Detalhamento completo: [`edge-sniper-v2.md`](edge-sniper-v2.md).

---

## 3. Onde está no código

- Manifest: `labs/strategies/edge/edge-sniper-v3/strategy.json`
- Modelos compilados: seeds em `src/backtestStudio/gls/` e versões Strategy JS no SQLite
- Runner módulo (portfolios): `edge-sniper-runner` em `data/strategy-libraries/`

---

## 4. Validação

Antes de confiar em novos parâmetros:

1. Rodar golden test de paridade contra polymarket-test no mesmo recorte Parquet.
2. Comparar entradas, PnL e traces evento a evento.
3. Documentar divergências em `docs/referencia/paridade-edge-sniper-v2.md`.