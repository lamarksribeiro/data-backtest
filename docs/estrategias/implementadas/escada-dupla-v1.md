# Escada Dupla V1

**Status:** promovida ao Studio (`promotedToStudio: true`) · library-runner  
**ID / Studio slug:** `escada-dupla-v1`  
**Família:** `carry`  
**Lab path:** `labs/strategies/carry/escada-dupla-v1/`  
**Runner:** `labs/legacy/strategy-runners/portable/escada-dupla-runner.js` · library `escada-dupla-runner@1`  
**Champion Studio:** v2 · `ascent_hedge` · holdout 2026-07-01→22 · PnL +$38.798 · PF 1.87 · WR 67% · 22/22 dias+  
**Versão realista:** Studio v4 · preset `btc-resting-honest` · mesmo grid · `executionMode=resting_maker` (A/B: `experiments/resting-holdout-july.json`)  
**Sandbox auxiliar:** `node labs/sandbox/escada-dupla-lab.mjs`  
**Simulador de referência:** `Simulador_manual85.html`  
**Data:** 2026-07-24 (promoção Studio 2026-07-25)

> Seed Studio: `npm run seed:ported-strategies` (ou reiniciar `src/server.js`).  
> Não usar `lab:promote-to-studio` (só GLS).

---

## 1. Objetivo deste documento

Planejar o port completo da estratégia **Escada Dupla** do simulador manual para o `data-backtest`, com:

1. paridade mecânica com o protótipo (grade, re-arme, multiplicador, equalização);
2. execução honesta maker/taker (lado oposto ao 1º 55¢ = resting maker);
3. microestrutura parametrizável (spread, slippage);
4. fees Polymarket reais via `applyPolymarketFeesToBacktestResult`;
5. lab → sweep → preset → promoção ao Estúdio.

Não é veredito empírico: **ainda não há PnL holdout**. O critério de aceite da Fase 0 é paridade com o simulador; o das Fases 3–4 é edge líquido após fees/slip.

---

## 2. Tese

Em mercados binários UP/DOWN (asks complementares ~100¢), comprar **os dois lados** em escadas simétricas, com re-arme em grade e reforço do lado atrasado, pode deixar:

\[
\bar p_{\text{UP}} + \bar p_{\text{DOWN}} \le 1
\]

com shares equalizadas → lucro estrutural no settlement (\( \$1 \) no lado vencedor).

O edge operacional vem de três peças:

| Peça | Papel |
|---|---|
| **Escada + re-arme** | Captura oscilações (caro na subida, barato na descida) sem martingale cego |
| **Maker no lado oposto** | O 1º lado a bater 55¢ é perseguido como **taker**; o oposto descansa como **limit/maker** (fee 0) |
| **Equalização ≤ 5¢** | Quando o lado menor fica barato, completa shares e trava o par |

Risco estrutural: **chicote** (sobe → reforça o oposto → sobe de novo e o líder vence). O multiplicador amplifica esse cenário.

Relação com estratégias existentes:

| Estratégia | Semelhança | Diferença |
|---|---|---|
| `gamma-ladder` | multi-entrada / ladder | Gamma usa modelo pStat+edge; Escada é path-following puro em odds |
| `hopper-3` | maker resting + carry | Hopper é 1 entrada + viradas; Escada é grade dual contínua |
| `cofre-sete` / carry | travar par | Escada constrói o inventário ao longo do path, não só no terminal |

---

## 3. Mecânica (contrato funcional do simulador)

### 3.1 Estado por evento

Para cada lado \( L \in \{\text{UP}, \text{DOWN}\} \):

- níveis **SUB-k** (disparam se `ask_L ≥ preço_k`);
- níveis **DESC-k** (disparam se `ask_L ≤ preço_k`);
- flag `armado` por nível;
- contagem de fills (para UI / debug).

Configuração default do protótipo:

```text
SUB:  [55→30sh, 60→20, 65→20, 70→20, 75→20, 80→20, 85→20, 90→10]
DESC: [45→10, 40→10, 35→10, 30→10, 25→10, 20→10, 15→10, 10→10]
```

(ambas as escadas UP e DOWN espelhadas.)

### 3.2 Disparo e re-arme

1. Ao disparar nível \(k\) do tipo \(T\) no lado \(L\), compra `shares` (com sizing abaixo).
2. Desarma \(T\)-\(k\) em \(L\).
3. **Re-arma** o complementar no **mesmo lado**: `SUB-k ↔ DESC-k`.

Isso permite oscilar: sobe (SUB) → desce (DESC re-armada) → sobe de novo (SUB re-armada)…

### 3.3 Multiplicador do 2º lado (SUB)

Nas entradas **SUB**, o tamanho escala com quantas vezes aquele índice `k` já entrou (contando **os dois lados**):

\[
\text{shares} = \text{base}_k \cdot m^{\,n_k}
\]

onde \( m \) = `sideMultiplier` (default 2) e \( n_k \) = nº de fills SUB com aquele `idx` no histórico do evento.

DESC não escala (tamanho fixo da caixa).

### 3.4 Líder 55¢ e liquidez

No primeiro tick em que `ask_UP ≥ 0.55` **ou** `ask_DOWN ≥ 0.55`:

- esse lado vira `leaderSide` (permanente no evento);
- **líder** → ordens **taker** (paga fee + spread/slip);
- **oposto** → ordens **maker/limit** (fee 0; fill no preço limite se o book atravessar).

Modos de override (param `liquidityMode`):

| Valor | Comportamento |
|---|---|
| `auto` | regra líder/oposto (default) |
| `taker` | tudo taker |
| `maker` | tudo maker (só para ablação; irreal se sem resting) |

### 3.5 Equalização

Se `shares_UP ≠ shares_DOWN` e o ask do lado menor ≤ `equalizeMaxAsk` (default 0.05):

- compra \(\lvert sh_U - sh_D \rvert\) no lado menor;
- liquidez segue a mesma regra auto (se o lado menor for o oposto → maker; se for líder → taker);
- `equalizeExtraSlipCents` opcional só nessa ordem.

### 3.6 Settlement

Sem taxa na resolução. PnL do evento:

\[
\text{PnL} = \text{shares}_{\text{vencedor}} - \sum (\text{notional} + \text{fees})
\]

Inventário residual não vendido resolve a \( \$1 \) / \( \$0 \).

---

## 4. Microestrutura e fees (obrigatório no port)

### 4.1 Fee Polymarket

Usar o motor canônico `src/backtest/fees.js`:

\[
\text{fee} = C \cdot r \cdot p \cdot (1-p),\quad r_{\text{crypto}}=0.07
\]

- `liquidity === 'maker'` → fee 0 (já implementado em `summarizeTrades`);
- taker em entry **e** exit (se houver saída antecipada);
- settlement sem fee.

Categoria default: `crypto`. Expor `polymarketFeeCategory` / `applyPolymarketFees` como nos demais labs.

### 4.2 Fill price (paridade com simulador)

| Papel | Compra | Venda (se houver) |
|---|---|---|
| Maker | `fill = limit` | (v1: sem exit maker; hold/eq) |
| Taker | `fill = limit + halfSpread + slip` (¢→prob) | `fill = mid − halfSpread − slip` |

Params:

| Param | Default | Unidade | Notas |
|---|---:|---|---|
| `spreadCents` | 1 | ¢ | halfSpread = /2 no fill taker |
| `slippageCents` | 0 | ¢ | adverso extra taker |
| `equalizeExtraSlipCents` | 0 | ¢ | só equalização |
| `makerFillEpsilon` | 0.01 | prob | atravessamento ask (igual Hopper/GLS) |
| `makerTimeoutSec` | 30 | s | cancela resting sem fill |
| `executionMode` | `resting_maker` | enum | ver §5 |

### 4.3 Modos de execução (herança Hopper)

Reutilizar a semântica de `docs/estrategias/hopper-3-maker-realista.md`:

| `executionMode` | Líder (taker) | Oposto (maker) |
|---|---|---|
| `optimistic_maker` | walk ask | fill imediato no limit (ablation / irreal) |
| `resting_maker` | walk ask | `placeLimitBuy` / resting até atravessar |
| `taker` | walk ask | walk ask (ignora maker no oposto) |

**Campeão de honestidade para promoção:** `resting_maker` + `liquidityMode=auto` + fees on.

Referência de implementação: `orderSimulator.js` (`placeLimitBuy`, fill por atravessamento) e Hopper `resting_maker`.

---

## 5. Arquitetura de implementação no data-backtest

### 5.1 Escolha de kind (decisão)

| Opção | Prós | Contras | Veredito |
|---|---|---|---|
| **GLS puro** | SOA rápido, seed Studio direto | Estado de grade dual + N resting orders é verboso em GLS; re-arme e mult por idx complicam | Não como v1 |
| **Strategy JS → compiled-soa** | Autoria mais clara; hooks oficiais; maker via `placeLimitBuy` | Precisa caber no whitelist/stdlib | Candidata se N resting ≤ capacidade do simulator |
| **Library-runner** (estilo Hopper) | Controle fino do estado, paridade fácil com simulador, testes unitários do motor | Mais boilerplate; sync `data/strategy-libraries/` | **Recomendada para v1** |

**Decisão do plano:** `kind: library-runner` na v1, família `carry`, com caminho de promoção ao Studio via envelope Strategy JS + `strategyLibrary(...)`, igual `hopper-3` / `cofre-sete`.

Se o order-simulator GLS já aguentar N limits simultâneas (uma por nível DESC/SUB do lado maker), avaliar migração GLS na v2.

### 5.2 Layout de arquivos (alvo)

```text
labs/strategies/carry/escada-dupla-v1/
  strategy.json
  strategy.js                 # envelope Studio (dependencies.runner)
  defaults.json
  params.schema.json
  presets/
    btc-parity-sim.json       # defaults iguais ao HTML
    btc-resting-honest.json   # resting_maker + fees
    btc-taker-ablation.json
  search-spaces/
    broad.json
    sizing-mult.json
  experiments/
    parity-smoke.json
    train-chunked.json
    holdout-july.json
    ablation-liquidity.json
    ablation-whip.json
  baselines/

labs/legacy/strategy-runners/portable/escada-dupla-runner.js
data/strategy-libraries/escada-dupla-runner.v1.json

docs/estrategias/nao-implementadas/escada-dupla-v1.md   # este doc
tests/escadaDuplaParity.test.js
tests/escadaDuplaRestingMaker.test.js
```

### 5.3 Contrato do runner

```js
export function createBacktestRunner(params) {
  return {
    processTick(tick, eventCtx) { /* ... */ },
    finish(eventCtx) { /* inventário → settlement */ },
  };
}
```

Estado mínimo por evento:

```text
leaderSide: null | 'UP' | 'DOWN'
ladder[side][tipo][idx]: { price, sharesBase, armed, fills }
pendingMakerOrders: Map<orderKey, { side, idx, tipo, limit, shares, placedAt }>
inventory: { UP: { shares, cost }, DOWN: { shares, cost } }
subEntryCountByIdx: Map<idx, n>
equalized: boolean
orders[] / fills[] com liquidity 'maker'|'taker'
```

### 5.4 Integração com o motor

1. `loadStrategy` resolve library-runner (`executionMode: library-runner-soa`).
2. Cada fill registra `liquidity` correta.
3. `engine.js` chama `applyPolymarketFeesToBacktestResult` no fim.
4. Breakdown no summary: `entryFee`, `exitFee`, `makerTradesFree`, `makerNotional`.

Docs de apoio:

- `docs/referencia/guia-criacao-e-teste-de-laboratorios.md`
- `docs/arquitetura/extensao-order-simulator-maker-limit.md`
- `docs/estrategias/hopper-3-maker-realista.md`
- `src/backtest/fees.js`

---

## 6. Schema de parâmetros (v1)

### 6.1 Grade e sizing

| Param | Tipo | Default | Notas |
|---|---|---:|---|
| `walletSize` | number | 100 | padrão Studio |
| `subLevels` | array`[priceCents, shares]` | ver §3.1 | editável |
| `descLevels` | array`[priceCents, shares]` | ver §3.1 | editável |
| `sideMultiplier` | int ≥ 1 | 2 | só SUB |
| `leaderThresholdCents` | number | 55 | limiar do líder |
| `equalizeMaxAskCents` | number | 5 | equalização |
| `equalizeEnabled` | bool | true | |

### 6.2 Liquidez / microestrutura

| Param | Tipo | Default |
|---|---|---:|
| `liquidityMode` | `auto`\|`taker`\|`maker` | `auto` |
| `executionMode` | `resting_maker`\|`optimistic_maker`\|`taker` | `resting_maker` |
| `spreadCents` | number | 1 |
| `slippageCents` | number | 0 |
| `equalizeExtraSlipCents` | number | 0 |
| `makerFillEpsilon` | number | 0.01 |
| `makerTimeoutSec` | number | 30 |
| `maxConcurrentMakerOrders` | int | 16 | segurança |

### 6.3 Fees / book

| Param | Default |
|---|---:|
| `applyPolymarketFees` | true |
| `polymarketFeeCategory` | `crypto` |
| `bookDepth` | 25 |

### 6.4 Risk / gates (v1 mínimos; expandir após smoke)

| Param | Default | Motivo |
|---|---:|---|
| `maxEventNotional` | 80 | teto de caixa por evento |
| `maxSharesPerSide` | 400 | corta explosão do multiplicador |
| `minSecondsLeftToEnter` | 15 | evita fills inúteis no fim |
| `maxSecondsLeftToStart` | 300 | opcional: só opera janela X |
| `blockWhipAfterReversal` | false | feature flag (Fase 4) |

---

## 7. Plano de implementação por fases

### Fase 0 — Paridade com o simulador (obrigatória)

**Objetivo:** o runner, em modo `optimistic_maker` + `spreadCents=0` + `slippageCents=0`, reproduz o HTML em paths sintéticos.

| Entrega | Critério de aceite |
|---|---|
| Motor de grade + re-arme + mult | Testes com paths: `50→95`, `50→55→0`, `50→h→100-h→95` |
| Líder 55¢ | UP sobe → UP taker / DOWN maker; DOWN sobe primeiro → espelho |
| Equalização | Dispara só com lado menor ≤ 5¢ |
| Fees | Com fees on, PnL = bruto − Σ fees taker; maker fee = 0 |
| Fixture | Comparar inventário/custo do runner vs snapshot do HTML (mesmos paths) |

Arquivo: `tests/escadaDuplaParity.test.js`.

### Fase 1 — Pacote lab + library

1. Criar `labs/strategies/carry/escada-dupla-v1/` a partir de `_templates/`.
2. Implementar `escada-dupla-runner.js` portable.
3. Sync `data/strategy-libraries/escada-dupla-runner.v1.json`.
4. Envelope `strategy.js` + `defaults.json` + `params.schema.json`.
5. `strategy.json`: `kind: library-runner`, `requiresBook: true`, `defaultBookDepth: 25`, `promotedToStudio: false`.
6. Smoke: `npm run lab:run -- --experiment .../parity-smoke.json` (1–3 dias).

### Fase 2 — Maker resting honesto

1. Portar lógica Hopper `resting_maker` para N ordens (ou fila por nível).
2. Fill só com atravessamento ask; timeout cancela e **não** marca inventário.
3. Teste: `tests/escadaDuplaRestingMaker.test.js` (fill rate &lt; 100% vs optimistic).
4. Preset `btc-resting-honest`.

### Fase 3 — Calibração empírica (treino)

Janela sugerida (alinhada MIDAS/Hopper):

- **Treino:** 2026-05-04 → 2026-07-01  
- **Holdout:** 2026-07-01 → 2026-07-18 (ou janela mais recente disponível no lake)

Sweeps (`dailyMetrics: true` no Brutus se ≥ 50 variantes):

| Experimento | Eixo |
|---|---|
| `sizing-mult` | `sideMultiplier` ∈ {1,2,3} × tetos de shares |
| `grade-coarse` | densidades SUB/DESC (espaçamento 5 vs 10¢) |
| `microstructure` | spread 0/1/2 × slip 0/1 × executionMode |
| `equalize` | on/off × limiar 3/5/8¢ |
| `liquidity-ablation` | auto vs tudo-taker |

Métricas de ranking: PnL líquido, PF, maxDD, fee drag, % fills maker, taxa de chicote (eventos com ≥2 viradas e líder final = 1º líder).

### Fase 4 — Mitigações de chicote e risco

Só depois de baseline honesto:

| Ideia | Como testar |
|---|---|
| Cap de potência do mult (`maxMultPower`) | ablação vs mult ilimitado |
| `blockWhipAfterReversal` | após 1 reversão completa, não rearmar SUB do líder |
| Reduzir DESC size | menos combustível no oposto |
| Gate de tempo / vol | não escalar se τ baixo ou σ alto |
| Desligar equalização tardia | se τ &lt; X e desbalanceado, aceitar exposição |

Mecanismos que piorarem holdout **ficam como params OFF** (padrão MIDAS).

### Fase 5 — Presets + promoção Studio

1. Preset campeão + robust + micro (se sizing pequeno para robot).
2. `promotedToStudio: true`, seed via boot.
3. Mover este doc para `docs/estrategias/implementadas/escada-dupla-v1.md`.
4. Atualizar `labs/strategies/_catalog/port-catalog.json` e `scripts/port-catalog.js`.
5. Atualizar índices `docs/estrategias/README.md` e `implementadas/README.md`.

### Fase 6 (opcional) — Paridade data-robot

Fora do escopo inicial do backtest, mas prever interface de params estável para canário no `data-robot` (mesmo padrão MIDAS micro presets).

---

## 8. Critérios de aceite / rejeição

### Aceite para promoção

- [ ] Paridade Fase 0 100% nos fixtures do simulador  
- [ ] `resting_maker` + fees crypto em treino **e** holdout  
- [ ] Holdout PnL &gt; 0 e PF ≥ 1,2 (piso fraco; calibrar após 1ª corrida)  
- [ ] Fee drag reportado; maker share ≥ X% das shares do lado oposto (sanity)  
- [ ] Drawdown e chicote documentados (não só PnL)  
- [ ] Preset reproduzível via `lab:run-preset`

### Rejeição (arquivar em `docs/rejeitadas/`)

- Holdout líquido ≤ 0 após fees em `resting_maker`  
- Edge só existe em `optimistic_maker` (alfa de fill irreal)  
- Explosão de notional / DD incompatível com wallet operacional  
- Dependência de path que some quando maker timeout &gt; 0  

---

## 9. Experimentos iniciais (esqueleto)

### 9.1 Smoke paridade

```json
{
  "id": "escada-dupla-parity-smoke",
  "strategyId": "escada-dupla-v1",
  "from": "2026-06-01",
  "to": "2026-06-03",
  "dailyMetrics": true,
  "bookDepth": 25,
  "variants": [
    { "name": "sim-parity", "sideMultiplier": 2, "executionMode": "optimistic_maker", "spreadCents": 0, "slippageCents": 0 },
    { "name": "resting-fees", "sideMultiplier": 2, "executionMode": "resting_maker", "spreadCents": 1, "slippageCents": 0 }
  ]
}
```

### 9.2 Comandos

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest

# testes de paridade / maker
node --test tests/escadaDuplaParity.test.js
node --test tests/escadaDuplaRestingMaker.test.js

# smoke lab
npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/parity-smoke.json

# sweep (Brutus se grande)
npm run lab:run -- --experiment labs/strategies/carry/escada-dupla-v1/experiments/train-chunked.json
```

---

## 10. Telemetria e debug

Por evento, gravar no `event` / log:

- `leaderSide`, tick/ts em que foi setado  
- nº fills taker vs maker por lado  
- `subEntryCountByIdx`  
- equalização (sim/não, shares, fill, liquidity)  
- `fees.entryFee` / `makerTradesFree`  
- flag `whipPath` (heurística: ≥1 reversão completa + líder final = líder inicial com inventário oposto ≥ inventário líder)

UI Estúdio: reutilizar breakdown de fees do drawer (já existe para entry/exit).

---

## 11. Riscos de implementação

| Risco | Mitigação |
|---|---|
| Muitas resting orders vs simulator | Limitar a níveis do lado maker; cancelar ao rearmar |
| Fill maker otimista demais | Default `resting_maker`; A/B obrigatório |
| Multiplicador explode banca | `maxSharesPerSide` + `maxEventNotional` |
| Divergência ¢ vs probabilidade | Converter sempre `/100`; clamps [0.01, 0.99] |
| Paridade HTML vs book real | Fase 0 em mid/ask sintético; Fase 2+ só book lakehouse |
| Contagem SUB cross-side | Espelhar exatamente o filtro `tipoBase==='SUB' && idx` do HTML |

---

## 12. Checklist operacional (ordem de execução)

1. [ ] Congelar defaults do HTML em `defaults.json` / fixture de teste  
2. [ ] Runner portable + testes de paridade (Fase 0)  
3. [ ] Library JSON + envelope lab  
4. [ ] Resting maker + teste A/B (Fase 2)  
5. [ ] Smoke 2 dias no lake local  
6. [ ] Sweep treino + holdout (Fase 3)  
7. [ ] Ablações chicote (Fase 4)  
8. [ ] Presets + doc de resultados  
9. [x] Promoção Studio + move do doc para `implementadas/`  
10. [ ] (Opcional) canário params no data-robot  

---

## 13. Referências

- Simulador: `Simulador_manual85.html` (protótipo com fees, auto maker/taker, spread/slip)  
- Fees: `src/backtest/fees.js`  
- Maker resting: `docs/estrategias/hopper-3-maker-realista.md`, `docs/arquitetura/extensao-order-simulator-maker-limit.md`  
- Ladder existente: `docs/estrategias/implementadas/gamma-ladder-v1.md`  
- Labs: `docs/referencia/guia-criacao-e-teste-de-laboratorios.md`  
- Índice: `docs/estrategias/README.md`
