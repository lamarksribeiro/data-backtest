# Manual Do Backtest Studio

## Visao Geral

O `data-backtest` e dividido em duas partes:

- Lakehouse: prepara e consulta dados historicos em Parquet/DuckDB.
- Backtest Studio: cria, versiona, executa e analisa estrategias GLS sobre esses dados.

O sistema nao executa backtest direto no Postgres. Primeiro os dados precisam existir no lakehouse como `backtest_ticks` validos no `lake_manifest`.

## Fluxo Normal De Uso

1. Abra `http://localhost:3100` (sem sessao, redireciona para `/login`).
2. Entre com o usuario configurado em `INITIAL_ADMIN_USERNAME` e `INITIAL_ADMIN_PASSWORD` (`SESSION_SECRET` obrigatorio em producao).
3. Ajuste o contexto global no topo da UI: ativo, intervalo, datas, book depth e batch size.
4. Va em **Dados** e confira se o periodo esta disponivel.
5. Se faltar dado, crie um job de prepare/sync antes do backtest.
6. Va em **Estrategias** para criar ou editar uma estrategia GLS.
7. Valide o codigo.
8. Salve uma nova versao.
9. Execute o backtest pela aba **Estrategias** ou pela aba **Backtests**.
10. Abra o run gerado para ver desempenho, equity, eventos e detalhe grafico de cada evento.

## O Que E Uma Estrategia

Uma estrategia tem duas camadas:

- Definicao: nome, slug, descricao, tags e status.
- Versoes: snapshots imutaveis do codigo GLS salvo.

Quando voce salva, o sistema cria uma nova versao. Runs antigos continuam apontando para o snapshot executado, mesmo que a estrategia seja editada ou apagada depois.

## Editor GLS

A linguagem GLS e uma linguagem pequena e controlada. Ela parece JavaScript, mas nao permite acesso a rede, arquivos, variaveis de ambiente, imports arbitrarios, async ou `eval`.

Hooks principais:

```js
strategy "Minha Estrategia" {
  param minDistanceAbs = 50
  param maxAsk = 0.58
  param budget = 15

  onEventStart(event) {
    state.entered = false
  }

  onTick(tick, event) {
    let dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
    let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
    let ask = book.ask(side, tick)

    if (!state.entered && dist >= params.minDistanceAbs && ask <= params.maxAsk) {
      enter(side, { price: ask, budget: params.budget, reason: "entry" })
      state.entered = true
      mark("entry")
    }
  }

  onEventEnd(event) {
    closeOpenPosition({ reason: "event_end" })
  }
}
```

Conceitos importantes:

- `params`: parametros declarados com `param`; podem ser sobrescritos no backtest via JSON.
- `state`: estado local do evento atual.
- `runState`: estado compartilhado durante o run inteiro.
- `tick`: snapshot atual do mercado.
- `event`: mercado de 5 minutos atual, incluindo `priceToBeat`.
- `enter`, `exit`, `reverse`, `closeOpenPosition`: API controlada de ordens simuladas.
- `mark`, `log`, `metric`: trilhas de explicabilidade que aparecem no explorador de evento.

## Como Executar Um Backtest

Na aba **Backtests**:

1. Escolha uma estrategia versionada.
2. Defina `Params JSON` se quiser sobrescrever parametros, por exemplo:

```json
{"minDistanceAbs":40,"budget":10}
```

3. Clique em **Executar**.
4. Se aparecer `DATA_NOT_READY`, va para **Dados** e prepare o periodo.

Na aba **Estrategias**:

1. Abra a estrategia.
2. Valide o codigo.
3. Salve uma versao.
4. Clique em **Executar backtest**.

## Como Ler O Resultado

Na tela do run:

- `Ticks`: linhas de `backtest_ticks` processadas.
- `Eventos`: mercados/eventos simulados.
- `Entradas`: eventos em que a estrategia abriu posicao.
- `PnL`: resultado acumulado do run.
- `Win rate`: proporcao de entradas vencedoras.
- `Drawdown`: queda maxima registrada quando a estrategia fornece essa metrica.
- `Profit factor`: lucro bruto dividido por perda bruta quando disponivel.
- `Curva de desempenho`: PnL acumulado ao fim de cada evento.
- `Eventos`: tabela para abrir cada evento individual.

Na tela do evento:

- Grafico BTC vs PTB mostra preco do ativo e price-to-beat.
- Series de bid/ask do lado negociado aparecem no eixo direito.
- Markers indicam entradas, saidas e `mark()` da estrategia.
- `Ordens & marks` mostra o JSON de execucao.
- `Logs` mostra mensagens emitidas por `log()` ou logs normalizados do runner.
- `Summary` mostra dados do evento, como lado, entrada, quantidade, custo, resultado e diagnosticos.

## Apagar Estrategias

Na aba **Estrategias**, abra uma estrategia e clique em **Apagar**.

Isso remove a definicao e todas as versoes salvas. Runs antigos nao sao apagados porque `backtest_runs` guarda o snapshot executado.

## Comandos Uteis

```bash
npm run api
npm run health
npm run query:availability -- --dataset backtest_ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10
npm run sync:backfill-backtest-ticks -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --dry-run
npm run backtest:run -- --strategy-id 1 --strategy-version-id 1 --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10
npm test
```

## O Que Ainda Falta

- Validar deploy, backup e restore em producao/Coolify.
- Implementar `PostgresTickProvider`, `HybridTickProvider` e `streamEvents` se o sistema precisar de providers alem do DuckDB/lakehouse.
- Melhorar o editor com autocomplete rico, diff entre versoes e comparacao visual entre runs.
- Criar otimizador/tuning de parametros dentro ou ao lado do Backtest Studio.
