# Arquitetura V3 — Consolidação UX: Estúdio único, Dados simples, Biblioteca de estratégias

> Status: **proposta aprovada para implementação** (jun/2026).
> Sucede a [arquitetura-v2-performance-ux.md](arquitetura-v2-performance-ux.md) (R1–R8 implementados).
> A V2 entregou o motor rápido (compilador GLS, SSE, fila, cache) e o Estúdio.
> A V3 resolve as três fricções que sobraram: **duplicidade de telas de backtest**,
> **complexidade exposta na tela de Dados** e **organização pobre das estratégias**.

---

## 1. Problemas a resolver

| # | Problema | Evidência no código |
|---|----------|---------------------|
| 1 | **Duas telas de backtest** coexistem: `studio.js` (~624 linhas) e o trio antigo `backtests.js` (~845) + `run-detail.js` (~635) + `event-detail.js` (~200). A sidebar mostra "Estúdio" **e** "Backtests"; cada uma tem features que a outra não tem. | `public/js/views/`, `public/index.html` (nav l.~44–62), `public/app.js` (rotas l.~148–160) |
| 2 | **Tela de Dados expõe a máquina de estados do backend**: 9 status de partição (`missing, pending, writing, valid, accepted, invalid, needs_review, stale, rebuilding`), aceite manual, frase de confirmação para rebuild, plano em formato CLI, e o fluxo "deixar uma janela pronta" custa 12–20 cliques espalhados por 3 views (`overview.js`, `lakehouse.js`, `jobs.js`). | `src/state/` (lake_manifest), `src/query/availability.js`, `src/sync/qualityPolicy.js`, `public/js/views/lakehouse.js` |
| 3 | **Estratégias sem ciclo de vida prático**: a lista não mostra desempenho (nenhum vínculo visual com runs); o Estúdio só roda a **última** versão; não há fork/duplicar, diff entre versões, changelog, favoritos, nem um endpoint de estatísticas por estratégia/versão. | `public/js/views/strategies.js` (~1100 linhas), `public/js/utils/strategyPicker.js`, `src/backtestStudio/state/strategies.js` |

**Princípio unificador da V3:** *o backend continua robusto e detalhado; a UI passa a
contar uma história simples.* Complexidade vira detalhe progressivo (drawer/tooltip),
nunca o caminho principal.

---

## 2. Frente A — Estúdio único (eliminar a duplicidade)

### 2.1 Decisão

O **Estúdio é a única tela de backtest**. As views `backtests.js`, `run-detail.js` e
`event-detail.js` são **removidas** após a migração das features exclusivas. O item
"Backtests" sai da sidebar; as rotas antigas continuam redirecionando (já existem:
`backtests/:id` → `studio?run=:id`).

### 2.2 O que migra para o Estúdio (inventário fechado)

Da comparação feature a feature, o Estúdio já cobre ~80%. Falta migrar:

| Origem | Feature | Destino no Estúdio |
|--------|---------|--------------------|
| `backtests.js` | Stats agregadas (runs totais, PnL acumulado, win rate global, melhor run) | Cabeçalho do painel de runs (colapsável, 1 linha de chips) |
| `backtests.js` | Filtros da lista de runs (status, sort por PnL/data, "só desta estratégia") | Barra compacta no topo do painel de runs |
| `backtests.js` | Colunas versão + período na lista | Sublinha do item de run (`v3 · 01–07 jun`) |
| `backtests.js` | Card de disponibilidade de dados (bloqueios por data) | Painel CONFIG: indicador inline de prontidão da janela escolhida (ver Frente B §3.4) |
| `backtests.js` | Batch size custom | Seção "Avançado" colapsada no CONFIG |
| `run-detail.js` | Timing detalhado (duckdbRead/process/finish/ticks-s) | Tab "Análise" → bloco "Execução" colapsável |
| `run-detail.js` | Diagnóstico "nenhuma entrada" (breakdown de motivos) | Card automático no resultado quando `entries == 0` |
| `run-detail.js` | Metrics dashboard agrupado (Geral / Assertividade / Médias e Limites) + toggle JSON | Substituir os 4 KPIs simples por grid agrupado expansível |
| `event-detail.js` | **Execution timeline** (entradas, saídas, parciais, reversões, marks em ordem cronológica) | Drawer: tab "Ordens" vira tab "Timeline" (a tabela de ordens é um modo da timeline) |
| `event-detail.js` | Diagnostics detalhados (15+ campos) e logs com nível (info/warn/err) | Drawer: tabs "Diagnóstico" e "Logs" enriquecidas |
| `event-detail.js` | Breakdown de fees (entryFee/exitFee/tradesCharged) | Drawer: resumo do evento |

### 2.3 Limpeza após a migração

- **Deletar:** `public/js/views/backtests.js`, `run-detail.js`, `event-detail.js`,
  `public/js/utils/chart.js` (canvas/Chart.js — uPlot vira o único motor de gráfico).
- **Manter:** redirects em `app.js` (`backtests` e `backtests/:id...` → studio); deep-links salvos não quebram.
- **Sidebar final (4 itens):** Estúdio · Estratégias · Dados · Visão Geral
  ("Jobs" é absorvido por "Dados" — ver Frente B).
- Eliminar o limite fixo de 500 eventos no Estúdio: a tabela virtual pagina sob demanda
  (já há `limit/offset` no endpoint).

### 2.4 A visão holística do analista (north star da tela)

O critério de aceite da frente inteira: *analisar uma estratégia do macro ao micro sem
sair da tela e sem perder contexto*:

```
RODAR (⌘↵) ──► RESULTADO (KPIs agrupados + equity)
                  │
                  ├── tab Análise: piores eventos, perdas por motivo, timing
                  │
                  └── tabela de eventos (filtro/sort/CSV)
                        │ 1 clique
                        ▼
                  EVENT DRAWER: Gráfico (BTC vs PTB + markers de entrada/saída/parcial/reversão)
                                Timeline cronológica · Diagnóstico · Logs
                        │ j/k percorre eventos sem fechar
                        ▼
                  ajustar params no CONFIG (estado preservado) ──► re-rodar
```

O gráfico do evento (drawer) ganha **markers tipados** na série: ▲ entrada, ▼ saída,
◆ parcial, ↻ reversão, ● mark de debug — com tooltip mostrando preço/qty/motivo.
É a peça central do diagnóstico de estratégia citada como fundamental.

---

## 3. Frente B — Dados radicalmente simples

### 3.1 Decisão: 3 estados na UI, 9 no backend

O `lake_manifest` **não muda** (a máquina de 9 estados é correta e auditável). A UI
projeta os 9 status em **3 estados derivados**:

| Estado UI | Status do manifest | Cor | Ação oferecida |
|-----------|--------------------|-----|----------------|
| **Pronto** | `valid`, `accepted` | verde | nenhuma (backtest liberado) |
| **Processando** | `pending`, `writing`, `rebuilding` (ou job ativo na janela) | azul, com progresso | acompanhar (SSE) |
| **Atenção** | `missing`, `invalid`, `needs_review`, `stale` | âmbar | **um botão: "Corrigir"** |

O status bruto continua acessível num drawer de detalhe da partição (modo avançado),
nunca na visão principal.

### 3.2 Uma view "Dados" (funde overview + data + jobs)

`overview.js`, `lakehouse.js` e `jobs.js` viram **uma view** com três zonas:

```
┌──────────────────────────────────────────────────────────────┐
│ COBERTURA  — calendário/heatmap por (underlying, interval)   │
│ ████████████░░██  jun/2026   ● verde ● azul ● âmbar          │
│ (clique numa faixa âmbar → painel de correção)               │
├──────────────────────────────────────────────────────────────┤
│ AÇÕES — [Preparar período…]  janela + dataset → 1 botão      │
│ Jobs ativos inline: ▓▓▓░ 64% · backfill 03–05 jun · ETA 4min │
├──────────────────────────────────────────────────────────────┤
│ DETALHE (drawer) — partição: status bruto, fingerprint,      │
│ quality details, arquivos, ações avançadas (accept/stale)    │
└──────────────────────────────────────────────────────────────┘
```

- O **calendário de cobertura** é a resposta visual à pergunta única que importa:
  *"que janelas posso backtestar?"*. Endpoint novo `GET /api/data/coverage?underlying=&interval=`
  (agregação do manifest por dia → estado derivado).
- **Jobs** deixam de ser página: aparecem como cards inline na zona de ações
  (progresso via SSE `job:progress`, já existente). A rota `#/jobs` redireciona.
- **Visão Geral** (`overview.js`) fica só com saúde do sistema (healthz, fingerprints,
  versões) — sem repetir dados de cobertura.

### 3.3 "Corrigir" — fluxo de 1 clique

Hoje: verificar disponibilidade → interpretar 3 cards → decidir rebuild vs accept →
criar job → 2–3 confirms → ir para Jobs → voltar → re-verificar (12–20 cliques).

V3: o botão **Corrigir** (por faixa âmbar) ou **Preparar período** (janela arbitrária)
executa um pipeline único no backend — endpoint novo `POST /api/data/fix`:

1. Roda o plano (equivalente ao dry-run atual) internamente.
2. Auto-aceita o que a política já permite (`needs_review` com mismatch ≤ 2% — a
   função `acceptEligibleReviewPartitions` já existe; passa a rodar aqui, explícita).
3. Enfileira **um job composto** com as ações de sync necessárias (backfill scalars →
   books/backtest_ticks → ohlc), na ordem certa.
4. Responde com resumo legível: *"3 dias serão re-sincronizados, 2 partições foram
   aceitas automaticamente, 1 dia não tem dados na origem"* — uma única confirmação.
5. Ao concluir (SSE `job:completed`), o calendário atualiza sozinho e notifica
   ("Período 01–07 jun pronto para backtest").

Regras de segurança preservadas: rebuild de partição `valid` (destrutivo) continua
exigindo confirmação explícita — mas **uma** frase no modal, não digitação de texto.

### 3.4 Integração com o Estúdio

No painel CONFIG do Estúdio, ao escolher a janela, um indicador de prontidão
(verde/azul/âmbar) aparece ao lado das datas — consultando `GET /api/data/coverage`.
Se âmbar: botão "Corrigir agora" dispara o mesmo `POST /api/data/fix` sem sair do
Estúdio, e o run pode ser enfileirado como **dependente do job** (roda quando os dados
ficarem prontos — `backtest_runs.status='queued'` já suporta).

### 3.5 Outras simplificações

- **Stale silencioso → notificação**: reconciliação que marca `stale` emite evento SSE
  e badge no sino de notificações.
- **Plano sem CLI**: o resumo do que será feito é descrito em frases ("re-exportar
  scalars de 03/jun"), nunca em comandos `node src/cli.js ...` (que permanecem só no
  runbook [operacao-lakehouse.md](../operacao/operacao-lakehouse.md)).
- **ETA em jobs**: reaproveitar o cálculo de ETA do progress de backtest para as fases
  `fetching_rows`/`writing_parquet` do prepare.

---

## 4. Frente C — Biblioteca de estratégias

### 4.1 Conceito: de "lista com editor" para "biblioteca viva"

A tela Estratégias passa a ter dois modos: **Biblioteca** (default, novo) e
**Editor** (o atual, ao abrir uma estratégia).

```
┌─ BIBLIOTECA ────────────────────────────────────────────────────┐
│ [busca]  [todas|draft|validated|archived]  [tags ▾]  [+ Nova]   │
│                                                                  │
│ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐     │
│ │ ★ Edge Sniper V2│ │ Momentum Fade   │ │ Gap Reverter    │     │
│ │ validated · v7  │ │ draft · v2      │ │ archived · v4   │     │
│ │ ▁▂▄▆▅▇ sparkline│ │ sem runs ainda  │ │ ▇▅▃▂▁▁          │     │
│ │ 42 runs · 58% WR│ │                 │ │ 18 runs · 41% WR│     │
│ │ best +$812      │ │                 │ │ best +$94       │     │
│ │ [▶ Rodar][Abrir]│ │ [▶ Rodar][Abrir]│ │ [Abrir]         │     │
│ └─────────────────┘ └─────────────────┘ └─────────────────┘     │
│  ordenar por: último uso · melhor PnL · win rate · nome          │
└──────────────────────────────────────────────────────────────────┘
```

Cada card responde de imediato: *essa estratégia funciona? está melhorando? vale
testar de novo?* — é isso que torna o ciclo de testes "viciante": o desempenho fica
visível sem nenhum clique.

### 4.2 Endpoint de estatísticas (a lacuna central)

Novo `GET /api/strategies/:id/stats` (e versão agregada `GET /api/strategies?stats=1`
para a biblioteca):

```json
{
  "strategy_id": 5,
  "totals": { "runs": 42, "win_rate": 0.58, "best_pnl": 812.4, "last_run_at": "..." },
  "sparkline": [12.5, -4.2, 88.1, ...],          // PnL dos últimos 20 runs
  "by_version": [
    { "version": 7, "runs": 9, "win_rate": 0.61, "avg_pnl": 34.2, "best_pnl": 812.4 },
    { "version": 6, "runs": 12, "win_rate": 0.52, "avg_pnl": 11.0, "best_pnl": 240.1 }
  ]
}
```

Implementação barata: agregações SQL sobre `backtest_runs` (já tem `strategy_id`,
`strategy_version_id`, `summary_json`); índice novo
`backtest_runs(strategy_id, strategy_version_id, created_at)`.

### 4.3 Evolução por versão (o gráfico que motiva iterar)

Na Ficha Técnica do editor, nova seção **Evolução**: gráfico de barras
`win_rate`/`avg_pnl` **por versão** (dados do `by_version` acima). Mostra de forma
brutalmente honesta se v7 é melhor que v6 — fecha o loop *editar → rodar → comparar →
editar* que hoje exige memória do usuário.

### 4.4 Funcionalidades novas (priorizadas)

| Prioridade | Feature | Implementação |
|------------|---------|---------------|
| **Alta** | **Stats por estratégia/versão** (§4.2) | endpoint + cards da biblioteca |
| **Alta** | **Seletor de versão no Estúdio** (hoje só roda a última) | `strategyPicker.js`: dropdown secundário de versão, default = última; mostra `v7 · 61% WR · 9 runs` por opção |
| **Alta** | **Fork/Duplicar** | `POST /api/strategies/:id/fork` → nova definition (`slug-fork`), v1 = código da versão escolhida; botão no card e no editor |
| **Alta** | **Notas por versão** | coluna `notes TEXT` em `strategy_versions` (migração aditiva); campo opcional ao salvar versão ("o que mudou?"); exibido no dropdown de versões e no diff |
| **Média** | **Diff entre versões** | painel lado a lado no editor (duas `<select>` + diff textual; lib leve tipo `diff` ESM ou implementação LCS própria); sem merge — só leitura |
| **Média** | **Favoritos** | coluna `pinned INTEGER DEFAULT 0` em `strategy_definitions`; estrela no card; favoritas primeiro na biblioteca e no picker do Estúdio |
| **Média** | **Filtro do picker por status** | Estúdio lista só `validated` + `draft` (archived oculta); badge de status na opção |
| **Média** | **Rodar do card** | botão "▶ Rodar" abre o Estúdio com a estratégia pré-selecionada (`#/studio?strategy=5`) — params e janela vêm do último run dela |
| **Baixa** | Export/import `.gls` | download do source; import cria draft |
| **Baixa** | Templates além do seed | diretório `src/backtestStudio/gls/strategies/` já suporta; expor "Nova a partir de template" |

### 4.5 Ciclo de vida (mantido, com significado)

`draft → validated → archived` permanece, mas passa a ter efeito visível:

- **draft**: aparece no picker com badge âmbar.
- **validated**: destaque na biblioteca; default do picker.
- **archived**: some do picker e fica numa seção colapsada da biblioteca (com stats
  preservadas — histórico nunca se perde, runs antigos mantêm o snapshot).

---

## 5. Mudanças de API e schema (resumo consolidado)

| Item | Mudança |
|------|---------|
| `GET /api/data/coverage` | **novo** — cobertura por dia com estado derivado (Pronto/Processando/Atenção) |
| `POST /api/data/fix` | **novo** — pipeline plano + auto-accept + job composto, 1 confirmação |
| `GET /api/strategies/:id/stats` · `GET /api/strategies?stats=1` | **novos** — agregações de runs por estratégia/versão |
| `POST /api/strategies/:id/fork` | **novo** — duplicar estratégia a partir de uma versão |
| `strategy_versions.notes` | migração aditiva (changelog por versão) |
| `strategy_definitions.pinned` | migração aditiva (favoritos) |
| Índice `backtest_runs(strategy_id, strategy_version_id, created_at)` | para stats |
| SSE | eventos novos: `data:stale` (reconciliação), reuso de `job:*` na view Dados |
| Rotas UI | `#/backtests*` e `#/jobs` → redirects; `#/studio?strategy=:id` (pré-seleção) |

Nenhuma migração destrutiva; manifest e máquina de estados intactos.

---

## 6. Plano de implementação

| Fase | Entrega | Critério de aceite |
|------|---------|--------------------|
| **U1** | Migrar features exclusivas para o Estúdio (§2.2): stats/filtros de runs, metrics agrupadas, timing, no-entry diagnostic, timeline + diagnostics + logs no drawer, markers tipados no gráfico, batch size avançado | paridade funcional comprovada por checklist §2.2; nenhuma informação disponível antes deixa de existir |
| **U2** | Deletar `backtests.js`, `run-detail.js`, `event-detail.js`, `utils/chart.js`; sidebar com 4 itens; paginação sob demanda na tabela de eventos | rotas antigas redirecionam; bundle sem Chart.js; `npm test` verde |
| **U3** | View Dados unificada: calendário de cobertura (`/api/data/coverage`), 3 estados derivados, jobs inline via SSE, drawer de partição com modo avançado | fluxo "ver o que posso backtestar" = 0 cliques (visível ao abrir); `#/jobs` redireciona |
| **U4** | `POST /api/data/fix` + botão Corrigir/Preparar período + integração no CONFIG do Estúdio (indicador + corrigir sem sair + run dependente de job) | janela quebrada → pronta com **1 clique + 1 confirmação**; notificação ao concluir |
| **U5** | Biblioteca de estratégias: endpoint stats, cards com sparkline/WR/best, ordenação, favoritos, rodar do card | abrir Estratégias responde "qual funciona melhor?" sem cliques |
| **U6** | Seletor de versão no Estúdio + notas por versão + fork | rodar qualquer versão histórica; fork em 2 cliques |
| **U7** | Diff entre versões + gráfico Evolução por versão | comparar v6 vs v7 (código e desempenho) na mesma tela |

Cada fase: testes novos + `npm test` verde + atualização de
[contratos-api-schemas.md](../referencia/contratos-api-schemas.md) e do
[manual-backtest-studio.md](../referencia/manual-backtest-studio.md) quando tocar API/UI.

---

## 7. Metas mensuráveis

| Métrica | Hoje | Meta V3 |
|---------|------|---------|
| Telas para backtest | 2 (Estúdio + Backtests/Run/Event) | **1** |
| Itens na sidebar | 6 | **4** |
| Status de partição visíveis na tela principal | 9 | **3** |
| Cliques para corrigir uma janela de dados | 12–20 | **1 clique + 1 confirmação** |
| Cliques para saber qual estratégia performa melhor | impossível sem abrir runs um a um | **0** (visível na biblioteca) |
| Rodar versão histórica de estratégia | impossível | 2 cliques |
| Código de views legadas | ~1.680 linhas (3 arquivos) | **0** (deletadas) |

---

## 8. Riscos e mitigação

| Risco | Mitigação |
|-------|-----------|
| Perder informação ao deletar telas antigas | U1 fecha o inventário §2.2 **antes** do U2 deletar; checklist de paridade revisado item a item |
| Auto-fix mascarar problema real de dados | `POST /api/data/fix` nunca aceita mismatch > 2% (mesma política atual); resumo sempre lista o que foi auto-aceito; drawer avançado preserva auditoria completa |
| Simplificação de status esconder estado relevante | mapeamento 9→3 é função pura documentada em contratos; drawer mostra status bruto |
| Stats deixarem a listagem de estratégias lenta | agregações com índice dedicado; `?stats=1` cacheado (TTL 30s, invalidado por SSE `run:completed`) |
| Fork proliferar slugs lixo | sufixo `-fork-N` automático + forks nascem `draft`; biblioteca agrupa por ordenação de uso |

---

## 9. Relação com os demais documentos

- Motor e Estúdio (base desta evolução): [arquitetura-v2-performance-ux.md](arquitetura-v2-performance-ux.md).
- Manifest e estados de partição (inalterados): [arquitetura-lakehouse-backtest.md](arquitetura-lakehouse-backtest.md) e [implementacao/implementacao-lakehouse.md](../implementacao/implementacao-lakehouse.md).
- GLS e Studio: [arquitetura-editor-estrategias.md](arquitetura-editor-estrategias.md) e [implementacao/implementacao-editor-backtest.md](../implementacao/implementacao-editor-backtest.md).
- Contratos a atualizar por fase: [referencia/contratos-api-schemas.md](../referencia/contratos-api-schemas.md).
- Manual do usuário a revisar no U2 e U5: [referencia/manual-backtest-studio.md](../referencia/manual-backtest-studio.md).
