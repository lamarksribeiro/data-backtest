# Manual Do Backtest Studio

## Visao Geral

O `data-backtest` e dividido em duas partes:

- Lakehouse: prepara e consulta dados historicos em Parquet/DuckDB.
- Backtest Studio: cria, versiona, executa e analisa estrategias GLS sobre esses dados.

O sistema nao executa backtest direto no Postgres. Primeiro os dados precisam existir no lakehouse como `backtest_ticks` validos no `lake_manifest`.

## Fluxo Normal De Uso (V3 — Estudio-first)

1. Abra `http://localhost:3100` (sem sessao, redireciona para `/login`).
2. Entre com `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`.
3. **Estudio** e a unica tela de backtest: configure estrategia (com versao), janela e rode com **Rodar backtest** ou `Ctrl+Enter`.
4. O indicador de cobertura no painel CONFIG mostra se a janela esta pronta (verde), sincronizando (azul) ou precisa de atencao (ambar). Use **Corrigir dados** para enfileirar preparacao em um clique.
5. **Dados** mostra calendario de cobertura, preparar periodo e jobs ativos (a rota `#/jobs` redireciona para aqui).
6. **Estrategias** abre na **Biblioteca** com cards, sparkline e stats; abra uma estrategia para editar GLS, salvar versao com notas, diff e evolucao por versao.
7. Clique em um evento na tabela para abrir o drawer: grafico com markers, timeline, diagnostico e logs — sem sair do Estudio (`j`/`k` percorre eventos).
8. **Visao Geral** mostra apenas saude do sistema; cobertura detalhada fica em **Dados**.

## O Que E Uma Estrategia

Uma estrategia tem duas camadas:

- Definicao: nome, slug, descricao, tags e status.
- Versoes: snapshots imutaveis do codigo GLS salvo.

Quando voce salva uma alteracao real, o sistema cria uma nova versao. Se o codigo final for igual ao snapshot atual, nenhuma versao nova e gravada. Runs antigos continuam apontando para o snapshot executado, mesmo que a estrategia seja editada ou apagada depois.

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

- `params`: parametros declarados com `param`; edite pela aba **Parametros** da estrategia e salve uma nova versao antes de executar.
- `state`: estado local do evento atual.
- `runState`: estado compartilhado durante o run inteiro.
- `tick`: snapshot atual do mercado.
- `event`: mercado de 5 minutos atual, incluindo `priceToBeat`.
- `enter`, `exit`, `reverse`, `closeOpenPosition`: API controlada de ordens simuladas.
- `mark`, `log`, `metric`: trilhas de explicabilidade que aparecem no explorador de evento.

## Como Executar Um Backtest

No **Estudio**:

1. Selecione estrategia e **versao** (dropdown secundario).
2. Confira datas, ativo, intervalo e book depth; o badge de cobertura indica prontidao.
3. Opcional: expanda **Avancado** para `Batch size`.
4. **Rodar backtest** ou `Ctrl+Enter`. Se os dados nao estiverem prontos, confirme corrigir e enfileirar o run dependente do job.
5. Painel de runs: chips de stats, filtros por status/ordem e sublinha `vN · periodo`.
6. Deep-links: `#/studio?run=ID`, `#/studio?strategy=5&version=12`, `#/backtests/ID` (redirect legado).

Na **Biblioteca de Estrategias**: botao **Rodar** abre o Estudio com a estrategia pre-selecionada.

## Como Ler O Resultado

No **Estudio** (painel central + drawer de evento):

- `Ticks`: linhas de `backtest_ticks` processadas.
- `Eventos`: mercados/eventos simulados.
- `Entradas`: eventos em que a estrategia abriu posicao.
- `PnL`: resultado acumulado do run.
- `Win rate`: proporcao de entradas vencedoras.
- `Drawdown`: queda maxima registrada quando a estrategia fornece essa metrica.
- `Profit factor`: lucro bruto dividido por perda bruta quando disponivel.
- `Curva de desempenho`: PnL acumulado ao fim de cada evento.
- Metricas agrupadas (Visao Geral / Assertividade / Medias) com toggle JSON.
- Tab **Analise**: piores eventos e timing de execucao (DuckDB, processamento, ticks/s).
- `Eventos`: tabela virtual com paginacao; clique abre o drawer.

No drawer do evento:

- **Grafico**: BTC vs PTB com markers tipados (entrada, saida, parcial, reversao, mark).
- **Timeline**: ordens e marcas em ordem cronologica.
- **Diagnostico** e **Logs** enriquecidos; resumo inclui breakdown de taxas.
- Atalhos `j` / `k` para navegar entre eventos sem fechar o drawer.

## Apagar Estrategias

Na aba **Estrategias**, abra uma estrategia e clique em **Apagar**.

Isso remove a definicao e todas as versoes salvas. Runs antigos nao sao apagados porque `backtest_runs` guarda o snapshot executado.

## Excluir Versoes

Versoes sao snapshots de reproducibilidade. Por isso, a exclusao e limitada:

- nao e permitido excluir a ultima versao de uma estrategia;
- nao e permitido excluir uma versao ja usada por backtests;
- versoes nao usadas podem ser excluidas para limpar rascunhos ou salvamentos acidentais.

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

- Validar deploy, backup e restore em producao/Coolify (ver `docs/implementacao/implementacao-v3.md`).
- Implementar `PostgresTickProvider`, `HybridTickProvider` e `streamEvents` se necessario.
- Autocomplete GLS mais rico e otimizador de parametros.
