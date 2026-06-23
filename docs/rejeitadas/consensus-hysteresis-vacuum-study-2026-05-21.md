# Consensus Hysteresis Transfer / Liquidity Vacuum Study

## Status: ❌ REJEITADA — nenhuma hipótese nova sobreviveu ao holdout com robustez suficiente

Este experimento criou um laboratório novo e independente em `scripts/lab-consensus-hysteresis-transfer.js` para testar duas famílias inéditas no projeto e uma terceira hipótese exploratória. A conclusão final é conservadora: **houve sinais locais interessantes, mas nenhum edge novo ficou estatisticamente defensável no holdout e nas janelas recentes**.

---

## Recorte obrigatório do banco

- `from`: `2026-05-04T15:00:00.000Z`
- `to`: `2026-05-21T05:16:32.715Z`
- ticks: **2,859,255**
- eventos: **4,780**
- primeiro tick: `2026-05-04T15:00:00.548Z`
- último tick: `2026-05-21T05:16:32.715Z`
- cobertura cheia por dia: ~`172.4k` ticks e `288` eventos/dia
- gaps globais `>2s`: **17**
- gaps globais `>5s`: **6**
- gaps globais `>10s`: **4**
- maior gap global: **118.6s**
- gaps intraevento `>2s`: **2**
- maior gap intraevento: **58.806s**

Qualidade do book no recorte:

- missing top-of-book: ~**0.04%**
- sides vazios: ~**4.2%**
- missing de preço: ~**1.45%**
- dislocação média de ask sum: ~**1.26%**

---

## O que os dados mostraram antes da modelagem

1. A distância `|BTC - PTB|` cresce conforme o vencimento se aproxima.
2. O spread do book fica relativamente estável, mas a assimetria UP/DOWN aumenta perto do fim.
3. O book parece suficientemente íntegro para backtest com fill histórico.
4. O minuto dentro do evento muda a geometria da distância, mas esse efeito é mais descritivo do que diretamente explorável.

---

## Hipóteses candidatas

## 1. Consensus Hysteresis Transfer

### Intuição

Quando o BTC cruza o PTB depois de um regime longo, parte do book ainda carrega a memória probabilística do lado antigo. A hipótese era que o consenso demora alguns segundos para transferir totalmente seu peso ao novo lado.

### Variável latente mal precificada

**Velocidade de unwind do consenso anterior** logo após um cruzamento estrutural do PTB.

### Matemática inicial

```text
X_t = side × (BTC_t - PTB_t)
baseProb = Φ(X_t / σ_τ)
hysteresis = max(0, oldSideProb - 0.5)
             × log(1 + prevRegimeSec / 5)
             × exp(-timeSinceCross / decay)

z = baseZ
  + w_support × supportZ
  + w_cross × crossZ
  + w_hyst × hysteresis

p_model = Φ(z)
edge = p_model - ask
```

### Condição de entrada

- cruzamento recente do PTB;
- regime anterior suficientemente longo;
- lado antigo tinha probabilidade alta antes do cross;
- entrar no novo lado se `edge > threshold` e `ask` ainda estiver barato;
- no máximo uma posição por evento.

### Saída / settlement

- saída antecipada apenas se o bid recuperar o suficiente para capturar o catch-up;
- senão, hold até settlement.

### Principal risco

A mesma memória de consenso que cria o sinal também reduz demais a frequência. O edge pode existir apenas em poucos eventos e desaparecer fora da amostra.

---

## 2. Liquidity Vacuum Curvature

### Intuição

Mesmo sem cruzamento do PTB, o lado já vencedor pode ficar subprecificado quando a curva de asks do seu book é mais “oca” que a do lado oposto. A tese era que o mercado observa o topo do book, mas não internaliza totalmente a curvatura da profundidade.

### Variável latente mal precificada

**Curvatura relativa da escada de liquidez** combinada com atraso da probabilidade observada contra a probabilidade-base do estado BTC/PTB.

### Matemática inicial

```text
baseProb = Φ(X_t / σ_τ)
probLag = max(0, baseProb - marketProbCurrent)
depthDiff = ladderSlope(currentSideAsks) - ladderSlope(oppositeSideAsks)

z = baseZ
  + w_support × supportZ
  + w_depth × max(0, depthDiffZ)
  + w_lag × probLag × 3.5

p_model = Φ(z)
edge = p_model - ask
```

### Condição de entrada

- lado atual já está na frente;
- `depthDiff > minDepthDiff`;
- suporte local positivo;
- `ask` dentro da faixa definida pela variante;
- entrar no lado corrente quando `edge` e `decisionMetric` excedem o mínimo.

### Saída / settlement

- mesma lógica de fill histórico no ask para entrada;
- saída pelo bid se houver catch-up suficiente;
- caso contrário, settlement.

### Principal risco

A curvatura gera **muito mais entradas**, mas o book aparentemente já cobra esse risco via preço médio e slippage implícito.

---

## 3. Minute-of-Event Compression Release

### Intuição

Cada minuto do contrato de 5 minutos tem um regime diferente de compressão e aceleração. A hipótese era que existiria um minuto específico em que a distância BTC-PTB ainda não teria sido convertida em probabilidade com a mesma eficiência do restante do evento.

### Variável latente mal precificada

**Convexidade temporal por minuto do evento**, não só por segundos até o vencimento.

### Matemática inicial

```text
minuteScore = zscore(|BTC - PTB| no minuto atual)
temporalDislocation = minuteScore - zscore(marketProb)

entrar se temporalDislocation > k
```

### Condição de entrada

- somente em buckets específicos de minuto;
- combinar distância, odds sum e spread.

### Saída / settlement

- hold to settlement, salvo perda estrutural de suporte.

### Principal risco

O efeito apareceu no SQL como estrutura de regime, mas não como anomalia clara de preço. Por isso a hipótese foi rejeitada ainda na exploração e não virou variante promovida do lab.

---

## Laboratório implementado

Arquivo: `scripts/lab-consensus-hysteresis-transfer.js`

Características:

- Node.js ESM
- usa `pool` e `getTicksForBacktestBatches` de `src/database.js`
- aceita `--from`, `--to`, `--mode`, `--batch-size`
- default `from = 2026-05-04T15:00:00.000Z`
- simula fill no **book histórico**
- controla slippage e liquidez disponível
- limita a **uma posição por evento**
- separa `train/validation/holdout` em **60/20/20**
- calcula PnL, PF, drawdown, max loss, avg cost, win rate e resultado por dia
- suporta paralelismo por workers, embora a execução sequencial tenha sido a mais observável neste ambiente

Comando npm:

```bash
npm run lab:consensus-hysteresis -- --mode quick --batch-size 5000 --workers 1
```

---

## Resultados empíricos

## Full range

### Variantes novas

| Variante | Entradas | Win rate | PnL total | PF total | Holdout | PF holdout | Observação |
|---|---:|---:|---:|---:|---:|---:|---|
| `cht-transfer-core` | 43 | 65.1% | +77.40 | 1.67 | +22.43 | inf | holdout com só **2 trades** |
| `cht-transfer-longdwell` | 36 | 61.1% | +48.88 | 1.43 | -8.68 | 0.00 | amostra pequena |
| `cht-transfer-fast` | 24 | 58.3% | +23.48 | 1.33 | 0.00 | 0.00 | zerou no holdout |
| `cht-transfer-late90` | 24 | 62.5% | +23.45 | 1.31 | +21.00 | inf | holdout com **1 trade** |
| `cht-vacuum-core` | 245 | 78.8% | +64.72 | 1.16 | -0.03 | 1.00 | amostra boa, edge inexistente |
| `cht-vacuum-cheap` | 69 | 60.9% | +26.68 | 1.09 | -42.88 | 0.38 | falha clara fora da amostra |

### Baseline estrutural

| Variante | Entradas | PnL | PF | Holdout |
|---|---:|---:|---:|---:|
| `cht-random-cross-clock` | 35 | +39.35 | 1.39 | +24.99 |

O problema do baseline é decisivo: o melhor holdout nominal entre as hipóteses de histerese não se separa do relógio aleatório na mesma estrutura de cross, porque ambos dependem de pouquíssimos trades.

---

## Últimas 72h

| Variante | Entradas | Win rate | PnL | PF |
|---|---:|---:|---:|---:|
| `cht-transfer-core` | 1 | 100.0% | +1.43 | inf |
| `cht-vacuum-core` | 40 | 80.0% | -3.71 | 0.95 |
| `cht-vacuum-cheap` | 11 | 45.5% | -34.81 | 0.43 |

Leitura:

- a família de histerese perdeu quase toda a frequência;
- a família de vácuo manteve amostra, mas **ficou negativa**.

---

## Últimas 24h

| Variante | Entradas | Win rate | PnL | PF |
|---|---:|---:|---:|---:|
| `cht-transfer-core` | 1 | 100.0% | +1.43 | inf |
| `cht-vacuum-core` | 22 | 77.3% | -19.22 | 0.64 |
| `cht-vacuum-cheap` | 4 | 0.0% | -43.70 | 0.00 |

Nas 24h mais recentes, a nova família com maior amostra piora ainda mais. Isso elimina o argumento de que o problema era apenas baixa frequência do full range.

---

## Comparação com estratégias existentes

### Mesmo range completo

| Estratégia | Entradas | PnL | PF | Drawdown |
|---|---:|---:|---:|---:|
| `cht-transfer-core` | 43 | +77.40 | 1.67 | 26.72 |
| `cht-vacuum-core` | 245 | +64.72 | 1.16 | 34.19 |
| Edge Sniper V1 | 198 | +449.32 | 1.85 | 63.77 |
| Terminal Convexity V1 | 67 | +965.01 | 3.51 | 46.97 |
| Gamma Ladder V1 | 205 | +4042.76 | 7.89 | 68.59 |
| Impulse Elasticity V1 | 144 | +477.14 | 3.58 | 22.54 |
| Volatility Compression Lock V1 | 386 | +969.56 | 1.35 | 159.28 |
| Convergence Undershoot V1 | 1177 | +1121.47 | 1.32 | 101.34 |

### Nas últimas 24h

| Estratégia | Entradas | PnL | PF |
|---|---:|---:|---:|
| `cht-vacuum-core` | 22 | -19.22 | 0.64 |
| Edge Sniper V1 | 20 | +46.93 | 1.90 |
| Terminal Convexity V1 | 5 | +53.31 | 3.25 |
| Gamma Ladder V1 | 22 | +1811.45 | 220.88 |
| Impulse Elasticity V1 | 6 | +32.24 | 4.39 |

As estratégias existentes continuam dominando tanto em PF quanto em robustez fora da amostra.

---

## Por que falhou

### 1. Histerese gerou narrativa melhor que amostra

`cht-transfer-core` teve um full range aceitável, mas o holdout positivo veio de **apenas 2 trades**. Isso não atende o critério de robustez. O baseline aleatório no mesmo relógio teve holdout parecido.

### 2. Curvatura de book aumentou frequência, mas não qualidade

`cht-vacuum-core` resolveu o problema de sample size, porém o holdout ficou em **-0.03 / PF 1.00** e as últimas 24h/72h ficaram negativas. O mercado aparentemente já incorpora a profundidade relevante no ask médio.

### 3. A hipótese “cheap” explodiu no holdout

`cht-vacuum-cheap` parecia uma versão de payoff mais assimétrico, mas virou exatamente o oposto: holdout **-42.88**, PF **0.38**, e nas últimas 24h fez **0 vitórias em 4 trades**.

### 4. O edge novo não ficou claramente diferente das famílias já existentes

Mesmo quando a teoria nova não perdia dinheiro, ela não entregava um comportamento melhor que as referências. Faltou uma curva própria defensável.

---

## Variantes rejeitadas e motivo

| Variante / hipótese | Motivo da rejeição |
|---|---|
| `cht-transfer-core` | holdout positivo com só 2 trades; não se separa do baseline |
| `cht-transfer-fast` | frequência baixa demais e holdout zerado |
| `cht-transfer-longdwell` | seletiva demais; holdout negativo |
| `cht-transfer-late90` | holdout com 1 trade; insuficiente |
| `cht-depth-confirmed` | não gerou entradas |
| `cht-fade-overflip` | não gerou entradas |
| `cht-vacuum-core` | maior amostra, mas holdout neutro/negativo e recente fraco |
| `cht-vacuum-cheap` | perda clara em holdout e 24h |
| `Minute-of-Event Compression Release` | efeito temporal existe, mas não virou mispricing explorável |

---

## O que foi realmente descoberto

1. **Existe memória local após cruzamentos do PTB**, mas o efeito é raro demais para virar edge novo confiável neste recorte.
2. **A curvatura de profundidade do book influencia a seleção de trades**, porém não basta para superar o preço pago e o slippage histórico.
3. **O principal gargalo não é encontrar sinais bonitos, mas provar que eles sobrevivem ao holdout com sample size útil**.

---

## Variante recomendada

**Para uso real: nenhuma.**

Se for necessário manter uma linha de pesquisa viva, a única variante com algum valor investigativo é a **`cht-vacuum-core`**, não para operar, mas para estudar uma versão futura que:

- una curvatura do book com uma variável exógena mais forte;
- imponha filtro de regime para reduzir trades de baixa qualidade;
- prove melhora também nas últimas 72h e 24h.

No estado atual, **não deve ser promovida para service nem para uso operacional**.

---

## Plano de uso

- manter o arquivo `scripts/lab-consensus-hysteresis-transfer.js` como laboratório de pesquisa;
- não promover nenhuma variante para `src/services`;
- usar este estudo como referência de hipóteses rejeitadas;
- procurar uma família nova que combine microestrutura com regime externo, em vez de depender apenas de book local e distância BTC/PTB.

---

## Comandos de reprodução

```bash
npm run lab:consensus-hysteresis -- --mode research --from 2026-05-04T15:00:00.000Z
npm run lab:consensus-hysteresis -- --mode quick --from 2026-05-04T15:00:00.000Z --batch-size 5000 --workers 1
npm run lab:consensus-hysteresis -- --mode quick --from 2026-05-18T05:16:32.715Z --to 2026-05-21T05:16:32.715Z --batch-size 5000 --workers 1
npm run lab:consensus-hysteresis -- --mode quick --from 2026-05-20T05:16:32.715Z --to 2026-05-21T05:16:32.715Z --batch-size 5000 --workers 1
```

---

## Resumo final

- **O que foi descoberto:** dois sinais novos — histerese pós-cross e curvatura de vácuo de liquidez — existem como padrões locais, mas não sustentam edge robusto.
- **Por que é novo:** a tese não reaproveita Terminal Convexity, Edge Sniper, Gamma Ladder, Impulse Elasticity, Cofre Sete ou ajustes cosméticos; ela usa memória de consenso e curvatura do book como núcleo probabilístico.
- **Quais resultados sustentam a conclusão:** `cht-transfer-core` dependeu de holdout minúsculo; `cht-vacuum-core` teve 45 trades no holdout e mesmo assim fechou em `-0.03 / PF 1.00`; nas últimas 24h ficou `-19.22 / PF 0.64`.
- **Qual variante é recomendada:** nenhuma para produção; `cht-vacuum-core` só merece sobreviver como pista de pesquisa.
- **Quais variantes foram rejeitadas e por quê:** as de histerese por baixa amostra, as de vácuo por não sobreviverem fora da amostra, e a hipótese por minuto por não mostrar mispricing claro no SQL.
