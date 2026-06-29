# Edge Snipper

**Edge Snipper** é a evolução compilada (hot path colunar / `compiled-soa`) da teoria documentada em [`edge-sniper-v2.md`](edge-sniper-v2.md). No `data-backtest` ela **substitui** o runner legado V2 e a nomenclatura anterior Edge Sniper V3 no Backtest Studio.

* **Studio slug:** `edge-snipper`
* **Kind:** compiled-native (modelos embutidos em Strategy JS, sem `strategyLibrary()`)
* **Teoria base:** [`edge-sniper-v2.md`](edge-sniper-v2.md)
* **Paridade V2:** [`../../referencia/paridade-edge-sniper-v2.md`](../../referencia/paridade-edge-sniper-v2.md)

---

## 1. Perfis versionados por ativo

| Studio v | Preset | Ativo | GLS | Notas |
|---|---|---|---|---|
| 1 | `btc-obi` | BTC | `edgeSnipper_v2.gls` | OBI no score; minEdge 0.09, minDistanceAbs 60 |
| 2 | `eth-obi` | ETH | `edgeSnipper_v2.gls` | Escalas ETH (minDistanceAbs 2.0, minSigma 0.25) |
| 3 | `sol-obi` | SOL | `edgeSnipper_v2.gls` | Escala ETH (minDistanceAbs 0.15, minSigma 0.10) |

O ativo (BTC/ETH/SOL) é escolhido no backtest; cada versão carrega apenas params/toggles.

---

## 2. Hipótese (resumo)

Compra taker quando o ask do lado favorável está **abaixo** da probabilidade estimada de vitória, explorando hesitação de reprecificação do book em eventos de 5 minutos. Operação contínua ao longo do evento com filtros de distância ao PTB, spread, liquidez e gestão de saída (incluindo stop-reverse opcional).

Detalhamento completo: [`edge-sniper-v2.md`](edge-sniper-v2.md).

---

## 3. Onde está no código

- Manifest: `labs/strategies/edge/edge-snipper/strategy.json`
- GLS: `src/backtestStudio/gls/strategies/edgeSnipper_v2.gls`
- Presets: `labs/strategies/edge/edge-snipper/presets/`
- Modelos compilados: seeds em `src/backtestStudio/gls/` e versões Strategy JS no SQLite

---

## 4. Validação

Antes de confiar em novos parâmetros:

1. Rodar golden test de paridade contra polymarket-test no mesmo recorte Parquet.
2. Comparar entradas, PnL e traces evento a evento.
3. Documentar divergências em `docs/referencia/paridade-edge-sniper-v2.md`.

Sweep SOL: `npm run lab:es:sol-optimization`