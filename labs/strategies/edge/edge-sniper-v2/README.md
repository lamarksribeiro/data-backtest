# Edge Sniper V2

Estrategia de edge baseada em distancia do BTC para o price-to-beat, direcao estimada, spread, liquidez e regras de saida com stop, trail e stop-reverse.

Esta entrada registra a estrategia seed atual no laboratorio sem duplicar a fonte GLS canonica.

Fonte canonica atual:

```text
src/backtestStudio/gls/strategies/edgeSniperV2.gls
```

Quando uma variante experimental mudar a logica GLS, crie um `strategy.gls` dentro deste pacote ou um novo pacote com outro `strategy-id`.

## Maturidade

- Status: `candidate`
- Paridade nativa com referencia legada: validada para `2026-05-29`, BTC 5m, book depth 10.
- Paridade GLS completa de PnL com parametros relaxados ainda depende de melhorias no simulador GLS, conforme `docs/referencia/paridade-edge-sniper-v2.md`.

## Uso No Laboratorio

Use `defaults.json` como ponto de partida e escolha um search space em `search-spaces/`.

O primeiro objetivo e encontrar candidatos melhores que o baseline usando sweep rapido sobre BTC 5m.
