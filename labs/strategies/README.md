# Catalogo De Estrategias

Organize estrategias por familia de comportamento, nao por ativo.

Exemplos de familias:

- `edge`: estrategias baseadas em discrepancia entre preco, PTB e book.
- `momentum`: estrategias baseadas em direcao e aceleracao do underlying.
- `mean-reversion`: estrategias baseadas em retorno ao PTB ou preco medio.
- `market-making`: estrategias baseadas em spread, liquidez e inventario.
- `risk`: variantes focadas em saida, stop, reverse e sizing.

Cada estrategia deve seguir o formato:

```text
labs/strategies/<family>/<strategy-id>/
  strategy.json
  README.md
  defaults.json
  params.schema.json
  search-spaces/
  baselines/
  experiments/
```

O codigo GLS pode viver dentro do pacote como `strategy.gls` ou apontar para uma fonte canonica existente em `strategy.json`.
