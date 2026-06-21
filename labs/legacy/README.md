# Legacy Bridges

Pontes **somente para migração**: comparar comportamento documentado no `polymarket-test` (código antigo, não executado em produção) com runs no lakehouse do `data-backtest`.

O `polymarket-test` não é mais ambiente operacional. Toda pesquisa e backtest vivem no `data-backtest`.

Novos laboratórios devem nascer em `labs/strategies/` e usar o motor nativo do `data-backtest`.

Use esta pasta apenas enquanto o port estiver em andamento:

- Paridade numérica durante a conversão de uma estratégia.
- Documentar divergências conhecidas antes de promover ao Studio.
- Remover a ponte quando a estratégia estiver portada e validada.
