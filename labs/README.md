# GoldenLens Research Labs

Laboratorio oficial de pesquisa do `data-backtest`.

O objetivo dos labs e criar estrategias novas, otimizar estrategias antigas e validar ideias rapidamente usando o mesmo lakehouse Parquet/DuckDB e o mesmo motor de backtest do Studio.

## Principios

- Estrategias sao pacotes organizados, nao scripts soltos.
- Experimentos devem ser reproduziveis por configuracao.
- Resultados gerados ficam fora do catalogo da estrategia.
- `polymarket-test` e referencia de paridade, nao o motor principal.
- Otimizacao usa `BACKTEST_ENGINE=soa`, `GLS_EXECUTION=compiled-soa` e `fastRun` sempre que possivel.

## Estrutura

```text
labs/
  strategies/        Catalogo de estrategias de pesquisa
  shared/            Infraestrutura comum dos labs
  legacy/            Pontes temporarias com polymarket-test
```

Resultados de execucao devem ser gravados em:

```text
reports/labs/<strategy-id>/<timestamp>-<experiment-name>/
```

## Fluxo

1. Criar ou escolher uma estrategia em `labs/strategies/<family>/<strategy-id>/`.
2. Definir `defaults.json`, `params.schema.json` e um search space.
3. Criar um experimento em `experiments/`.
4. Rodar sweep rapido em modo colunar.
5. Validar os melhores candidatos em run completo.
6. Promover para Backtest Studio quando a estrategia estiver madura.

## Status De Estrategia

- `draft`: ideia nova, ainda instavel.
- `candidate`: pronta para otimizacao seria.
- `validated`: passou por janelas multiplas e out-of-sample.
- `studio`: promovida para Backtest Studio.
- `production-reference`: referencia usada contra producao ou robo real.
- `archived`: mantida para historico, sem desenvolvimento ativo.
