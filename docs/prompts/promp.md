# Prompt — Descoberta de Nova Teoria Quantitativa no `data-backtest` (BTC Up/Down 5m)

Você está trabalhando no workspace **`data-backtest`** (lakehouse OLAP Parquet/DuckDB, motor SOA, Research Labs). Sua missão é **criar uma teoria quantitativa completamente nova**, do zero, para operar **BTC Up/Down de 5 minutos na Polymarket**, com um objetivo claro:

> **Lucro líquido robusto, segurança, drawdown baixo e uma curva de PnL suave** — idealmente linear estável ou exponencial controlada (compounding) — **que sobreviva às fees reais da Polymarket.**

A pesquisa deve ser **agressiva**; a validação deve ser **conservadora**. Não prometa lucro real. Não aceite edge ilusório.

---

## 0. Postura e disciplina metodológica

- A teoria anterior de referência é **Terminal Convexity V1** (`labs/strategies/terminal/terminal-convexity-v1/` + `docs/estrategias/implementadas/`). Use a **disciplina** desse experimento, **não** a teoria.
- **NÃO** transforme isto em tuning de nenhuma estratégia existente. Antes de começar, leia o catálogo para saber o que já existe e o que já morreu:
  - **Implementadas:** `docs/estrategias/implementadas/` (Terminal Convexity, Edge Sniper V3, Gamma Ladder, Impulse Elasticity, Cofre Sete, Fusion Five, Omni Edge, VSMR, Momentum Edge, Stable Carry Compression, Volatility Compression Lock, Boundary Coherence Entropy Deviation, Empirical Residual Manifold, Quantum Entropic Manifold, Lead Inertia, BS-Lead, etc.).
  - **Não implementadas / candidatas:** `docs/estrategias/nao-implementadas/`.
  - **Rejeitadas (leia para NÃO repetir):** `docs/rejeitadas/` (DPD, Sigma Adaptive Drift, OBI Transition Pressure, Residual Coherence Gap, Coherence Hazard Edge, Dynamic Probability Decoupling, Ambiguity Equilibrium Dispersal, TPTCA, Consensus Hysteresis Vacuum, etc.).
- A nova teoria precisa ter **hipótese própria, matemática própria, filtros próprios, lógica própria e métrica própria de decisão**.
- Procure: distorções estatísticas, anomalias temporais, falhas de precificação, ineficiências de microestrutura e comportamentos **não lineares** que gerem edge **reproduzível**.
- **Use paralelismo em todo código de teste:** `engine: "soa"`, `glsExecution: "compiled-soa"`, `fastRun: true`, `dailyMetrics: true` (chunked-1d) e `--variant-workers N`. Sweeps grandes vão para o **Brutus** (`labs/ops/brutus/`).

---

## 1. Fees da Polymarket (OBRIGATÓRIO)

A Polymarket cobra fee taker em crypto prediction markets. Isso destrói estratégias de alta frequência, scalp, micro-edge e turnover elevado.

### Implementação obrigatória

- O cálculo oficial **já existe**: use **`src/backtest/fees.js`**.
  - `calculatePolymarketTakerFee({ shares, price, feeRate })` — fórmula real: `shares * feeRate * price * (1 - price)`.
  - `applyPolymarketFeesToBacktestResult(result, options)` — aplica fees ao resultado completo, recomputa summary, equity, drawdown, `feeDrag`.
  - Taxa crypto = `POLYMARKET_FEE_RATES.crypto = 0.07`. A fee é **máxima em price ≈ 0.50** e cai em direção às pontas — isso muda onde o edge sobrevive.
- **NÃO recrie fórmulas de fee.** Use exatamente o mesmo cálculo de produção. Nada de `polymarketFee.js` (não existe aqui).
- **Nenhuma estratégia é válida apenas pelo PnL bruto.** Validação sempre líquida, após fees + slippage + spread + partial fills + execução realista (fills contra **book histórico** via `orderSimulator.js`, dataset `backtest_ticks`, depth 25).
- O motor (`src/backtest/engine.js`) e o lab runner (`labs/shared/variantSweepWorker.js`) **aplicam fees automaticamente** via `applyPolymarketFeesToBacktestResult` — desabilitar só com `applyPolymarketFees: false` nos params (não recomendado).
- Modelo de fee atual: **taker only** (`polymarket_taker`); não há fee maker implementada em `fees.js`.

### Toda estratégia deve medir

- PnL bruto
- PnL líquido
- fee total
- impacto % das fees
- expectativa líquida
- edge bruto vs líquido
- deterioração do edge conforme a frequência sobe
- fee drag acumulado
- retorno líquido por trade
- retorno líquido por dólar arriscado

### Estratégias inválidas

Considere inválidas estratégias que:

- só funcionam antes das fees;
- somem após `src/backtest/fees.js`;
- dependem de fills irreais;
- dependem de edge minúsculo;
- ficam negativas com slippage realista;
- dependem de turnover excessivo.

---

## 2. Recorte de dados (OBRIGATÓRIO)

> **Arquitetura de dados do `data-backtest`:** backtests **não** leem Postgres diretamente. O fluxo é:
>
> ```text
> Postgres (data-colector)  →  sync/export  →  Parquet em LAKE_ROOT
>                                              →  DuckDB lê active_path do manifest
> SQLite (STATE_DB_PATH)    →  lake_manifest, estratégias, runs
> ```
>
> Comandos npm abaixo devem ser executados a partir do diretório **`data-backtest/`**.

- Use **somente** dados a partir de `2026-05-04T15:00:00.000Z` (nos experimentos JSON, use `"from": "2026-05-04"` — partições são diárias; o corte fino de 15:00 UTC vale para análise exploratória, não para o campo `from` do lab).
- Fim do range = **maior timestamp disponível** no lakehouse local (consultar via manifest).
- Dados de backtest ficam em **Parquet** (`LAKE_ROOT=./lake`) e são lidos via **DuckDB** pelos `active_path` válidos do manifest.
- Se faltar período localmente: `npm run lake:pull` (copia lake + SQLite do Brutus) e depois `npm run lake:verify`.

### Configuração local (`.env` em `data-backtest/`)

```env
LAKE_ROOT=./lake
STATE_DB_PATH=./state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=25
BACKTEST_ENGINE=soa
GLS_EXECUTION=compiled-soa
```

### Onde cada store entra

| Store | Caminho / variável | Uso |
|---|---|---|
| **Parquet (lakehouse)** | `LAKE_ROOT` → `./lake/backtest_ticks/` | **Fonte dos ticks e book** usada nos backtests |
| **SQLite (state store)** | `STATE_DB_PATH` → `./state/data-backtest.db` | Manifest (`lake_manifest`), estratégias, runs, prepare jobs |
| **DuckDB** | in-process (`@duckdb/node-api`) | Query layer sobre Parquet; **não** é um arquivo `.db` separado |
| **Postgres (opcional)** | `DATA_COLLECTOR_DATABASE_URL` | **Somente sync/export** a partir do `data-colector`; **não** é o hot path do backtest |

> ⚠️ **Não use** `DATABASE_URL=.../goldenlens` — isso é legado do `polymarket-test`. No `data-backtest`, a variável correta para Postgres (quando necessário) é `DATA_COLLECTOR_DATABASE_URL`, apontando para o banco `data_collector` (ex.: `postgresql://postgres:postgres@localhost:5432/data_collector`).

### Antes de qualquer modelagem, confirme cobertura e integridade

**1. Verificação rápida do setup local:**

```powershell
cd data-backtest
npm run lake:verify
```

**2. Manifest (SQLite) — partições válidas, range de datas:**

```powershell
npm run manifest:list -- --status valid --limit 50
node src/cli.js manifest:stats
```

Filtrar por dataset/underlying/interval inspecionando o JSON retornado ou consultando `lake_manifest` diretamente no SQLite (`STATE_DB_PATH`).

**3. Disponibilidade estrita para o período do experimento:**

```powershell
npm run query:availability -- --dataset backtest_ticks --from 2026-05-04 --to 2026-06-19 --underlying BTC --interval 5m --book-depth 25
```

**4. Amostra de ticks (DuckDB sobre Parquet):**

```powershell
npm run query:ticks -- --dataset backtest_ticks --from 2026-05-04 --to 2026-05-05 --underlying BTC --interval 5m --book-depth 25 --limit 10
```

**5. Postgres (opcional, só para auditar origem antes/depois do sync):**

```powershell
node scratch/check-postgres-data.js
```

Requer `DATA_COLLECTOR_DATABASE_URL` configurada no `.env`.

### Checklist de integridade

- quantidade de ticks (via `query:ticks` / backtest smoke)
- quantidade de eventos (partições no manifest)
- primeiro/último timestamp (manifest + query)
- cobertura por dia (`manifest:list`, `dailyMetrics: true` nos experimentos)
- gaps relevantes (`query:availability` em modo strict)
- integridade do book histórico (dataset `backtest_ticks`, `bookDepth: 25`, colunas de asks/bids preenchidas)
- nunca fazer glob direto em `./lake` — sempre usar `active_path` do manifest (regra do lakehouse)

---

## 3. Objetivo da teoria

Explorar uma curva **fora do consenso do mercado**. Pode envolver: probabilidade, estatística, microestrutura, dinâmica temporal, fluxo de ordens, liquidez, reversões, acelerações, teoria da decisão, compressão de volatilidade, distorções temporais — qualquer comportamento reproduzível.

A teoria precisa **sobreviver realisticamente** a: fees, spread, slippage, partial fills, liquidez limitada, deterioração operacional e execução imperfeita.

---

## 4. Arsenal matemático moderno (menu de inspiração)

Para BTC Up/Down de horizonte fixo (5 min), o problema natural é: **qual a probabilidade real de o preço terminar acima/abaixo do strike no instante de settlement, e onde o mercado precifica isso errado?** Use o que for plausível — escolha e combine, não copie tudo.

### Precificação e probabilidade

- **First-passage / Ponte Browniana (Brownian bridge):** probabilidade de cruzamento/terminal dado preço atual, distância ao strike (PTB) e tempo restante `τ`. Compare `P_modelo` vs `P_mercado` (ask/odds) → mispricing direto.
- **Calibração:** regressão isotônica / Platt scaling, *reliability diagram*, decomposição de **Brier score** (reliability vs resolution) para achar zonas onde o mercado precifica sistematicamente mal.
- **Predição conformal** para limiares de decisão com garantia de cobertura.
- **Divergência KL / entropia** entre distribuição implícita do mercado e a empírica condicional.

### Regime e memória

- **Detecção de mudança de regime:** BOCPD (Bayesian Online Change-Point), CUSUM.
- **Hurst / fBm / teste de variance-ratio:** distinguir regime de tendência vs reversão.
- **HMM / regime switching** para condicionar o sinal.

### Volatilidade e saltos

- Estimadores realizados: **Yang-Zhang**, **Garman-Klass**, **bipower variation**; detecção de saltos (**Lee-Mykland**) para ajustar a variância da ponte browniana.
- Compressão/expansão de volatilidade como gatilho condicional.

### Microestrutura (sem usar assimetria de liquidez como tese principal)

- **Micro-price (Stoikov)** como mid melhor que o midpoint.
- **Processos de Hawkes** (auto-excitação do fluxo) como *feature*, não como tese central.
- **Path signatures / rough paths** como features não lineares de dependência de trajetória.
- **Cópulas** entre retorno do BTC e distância ao PTB.

### Decisão, sizing e controle de risco (para a curva de PnL)

- **Optional stopping / martingale**, **SPRT** (teste sequencial) para saída antecipada.
- **Kelly / Kelly fracionário com restrição de CVaR** → bankroll com crescimento exponencial controlado e drawdown limitado; *fixed fraction* para curva mais linear.
- **EVT (POT/GPD)** para controle de cauda e drawdown.
- **Almgren-Chriss-lite** para modelar slippage dado o book depth.

> ⚠️ O **edge precisa vir de uma anomalia/mispricing real**, não de truque de sizing. Sizing e overlays de risco só moldam a curva; não inventam vantagem.

---

## 5. Hipóteses proibidas como tese principal

- "Comprar o lado vencedor nos últimos segundos porque está barato."
- Ajustar thresholds do Terminal Convexity / replicar Edge Sniper / qualquer estratégia existente com outros parâmetros.
- Grid search sem explicar a anomalia.
- Lucro que some após fees.
- Micro scalp sem vantagem líquida robusta.
- **Assimetria de liquidez como hipótese principal.**

---

## 6. Processo obrigatório

### 6.1 Mapear o projeto

Analisar: Labs (`labs/cli/`, `labs/shared/`, `labs/strategies/`), motor de backtest (`src/backtest/engine.js`, `sweep.js`, `variantSweepWorker.js`), fees (`src/backtest/fees.js`), GLS (`src/backtestStudio/gls/`), docs de arquitetura (`docs/arquitetura/arquitetura-v*.md`) e os guias `docs/referencia/guia-criacao-e-teste-de-laboratorios.md` e `guia-performance-laboratorio.md`. Identifique simplificações irreais (preço ideal, fills perfeitos).

### 6.2 Investigar os dados com DuckDB / CLI exploratório (paralelizável)

Usar `query:availability`, `query:ticks`, `query:candles` e scripts em `scratch/` — **não** consultar Postgres diretamente para backtest. Postgres (`DATA_COLLECTOR_DATABASE_URL`) só para auditar origem ou rodar sync.

Explorar: comportamento por tempo restante · distância BTC vs PTB · spread · soma das odds · assimetria UP/DOWN · mudanças de regime · volatilidade · reversões · acelerações · compressões · gaps · qualidade do book · comportamento intra-evento e por minuto · edge bruto vs líquido · impacto das fees · impacto da frequência operacional.

### 6.3 Formular pelo menos 3 hipóteses realmente diferentes

Para cada uma, escrever:

- intuição
- variável latente
- fórmula matemática
- condição de entrada
- condição de saída
- condição de settlement
- principal risco
- expectativa bruta
- expectativa líquida
- impacto das fees
- vulnerabilidade a slippage
- vulnerabilidade a fee drag
- robustez operacional

### 6.4 Escolher a mais promissora

Critério: evidência preliminar, robustez, estabilidade, **sobrevivência após fees**, qualidade do holdout, consistência temporal. **Nunca** escolher pelo maior PnL bruto.

---

## 7. Implementar a estratégia como pacote de laboratório (não script solto)

Siga `docs/referencia/guia-criacao-e-teste-de-laboratorios.md`:

1. **GLS:** `src/backtestStudio/gls/strategies/<NomeDaTeoria>.gls` (`param`, `state.*`, `onEventStart` / `onTick` / `onEventEnd`). Respeite a restrição de não reatribuir `let` (use aritmética inline).
2. **Standard Library:** se precisar de matemática complexa, adicione em `src/backtestStudio/gls/standardLibrary.js` (use helpers `sampleUnderlying`, `_tsMs` com fallback) e **registre na whitelist** `src/backtestStudio/gls/blocks.js`.
3. **Pacote:** `labs/strategies/<family>/<id>/` com `strategy.json`, `defaults.json`, `params.schema.json`, `search-spaces/grid-search.json`, `experiments/*.json`.
4. **Experimentos** com:
   - `dataset: "backtest_ticks"`, `bookDepth: 25`, `requiresBook: true` (fills reais contra book via GLS `book.*` + `orderSimulator.js`; **não use preço ideal**; partial fills quando liquidez insuficiente).
   - `from: "2026-05-04"` (default; recorte de pesquisa a partir de `2026-05-04T15:00:00.000Z`), `to` = máximo disponível no manifest.
   - `engine: "soa"`, `glsExecution: "compiled-soa"`, `fastRun: true`, `dailyMetrics: true`, `variantWorkers: N`.
   - **Fees:** aplicadas automaticamente pelo motor (taxa crypto 0.07, modelo taker) — resultados devem registrar entradas, exits, settlements, fees, slippage, PnL bruto, PnL líquido, drawdown, PF, win rate, max loss, expectancy, turnover, fee drag, avg cost.
5. **Uma posição por evento**, salvo justificativa matemática forte.
6. **Splits:** train 60% · validation 20% · holdout 20%; resultados **por dia** e **líquidos consolidados**.
7. **Comando npm:** adicione scripts `lab:<id>:*` no `package.json` (ex.: `lab:<id>:baseline`, `lab:<id>:champion`, `lab:<id>:validate`).

---

## 8. Rodar testes empíricos (paralelos)

- Range completo · últimas 72h · últimas 24h · split 60/20/20.
- Comparar contra: **Edge Sniper, Terminal Convexity V1, Gamma Ladder V1, Impulse Elasticity V1** e demais em `docs/estrategias/`.
- Comparar contra **baseline aleatória**.
- Comparar impacto das fees em **baixa / média / alta** frequência (mostrar deterioração do edge com turnover).
- Sweeps grandes → Brutus (`labs/ops/brutus/run-benchmark-ab.sh`, `run-queue.sh`, `pull-reports.sh`); discovery/smoke local.

---

## 9. Critérios mínimos para a teoria ser "interessante"

- Positiva no holdout
- Positiva **após fees**
- PF > 2.0 no holdout (ou justificativa forte)
- Drawdown controlado
- Não depender de uma única trade
- Sobreviver nas últimas 72h
- Comportamento **diferente** das estratégias existentes
- Manter edge após custos
- Robusta com slippage moderado
- Curva de PnL suave (linear/exponencial, sem degraus dependentes de poucos trades)

---

## 10. Se a hipótese falhar

- Não maquiar resultado.
- Não ignorar fees.
- Registrar **por que** falhou e se o edge morreu após custos.
- Voltar aos dados, criar nova hipótese, repetir até: encontrar edge defensável **ou** provar que o recorte não sustenta vantagem.
- Teses mortas vão documentadas em `docs/rejeitadas/`.

---

## 11. Entregáveis obrigatórios

### Código

- Pacote de estratégia em `labs/strategies/<family>/<id>/` (+ GLS + standardLibrary/blocks se necessário).
- Novo(s) comando(s) npm em `package.json`.

### Documentação

Criar em `docs/estrategias/nao-implementadas/` (ou `implementadas/` se aprovada; `docs/rejeitadas/` se falhar), contendo:

- nome da teoria
- hipótese
- matemática
- variáveis
- regras
- execução
- impacto das fees
- expectativa líquida
- resultados
- comparação com outras estratégias
- limitações
- riscos
- plano de uso

---

## 12. Resumo final obrigatório (em português)

Gerar resumo contendo:

- o que foi descoberto
- por que é novo
- evidências que sustentam
- comportamento após fees
- expectativa líquida
- variantes aprovadas
- variantes rejeitadas
- por que algumas hipóteses falharam
- riscos remanescentes

---

## 13. Postura final

Agressivo na pesquisa, conservador na validação. Desconfie de: estratégias rápidas demais, lucro pequeno por trade, turnover excessivo, fills perfeitos, edge sensível a fee.

Só finalize com uma teoria **nova, testada, reproduzível, documentada e validada após fees reais** — ou com **evidência clara** de que nenhuma hipótese sobreviveu ao holdout líquido.
