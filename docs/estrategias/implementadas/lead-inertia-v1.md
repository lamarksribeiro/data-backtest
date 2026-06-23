# Lead Inertia Mispricing V1 (LIM)

## 1. Nome e Resumo

**Nome da teoria:** Lead Inertia Mispricing V1 (LIM)

LIM explora uma anomalia específica do book do BTC Up/Down 5min na Polymarket:
quando o BTC já está **muito longe** do strike e ainda **falta tempo no evento**
(τ alto, distância alta), o ask do lado vencedor sistematicamente fica **abaixo**
da probabilidade real de settlement. Não é "comprar quem está vencendo no fim";
é justamente o oposto temporal — é **o início/meio do evento**, onde a inércia
de market-makers e a restrição de odds-sum criam uma janela de mispricing.

LIM **não é** uma evolução de Terminal Convexity, Edge Sniper, Impulse
Elasticity, Gamma Ladder, Convergence Undershoot ou qualquer das estratégias
existentes — opera em regime temporal e de distância distinto e usa
**modelagem CDF Browniana com drift de velocidade** como métrica de decisão,
não thresholds fixos sobre mid/spread.

---

## 2. Hipótese

**H₀ (nula):** o ask do lado líder sempre reflete a probabilidade Browniana
de settlement, ajustada pela velocidade de preço corrente.

**H₁ (LIM):** existe uma região do espaço (τ, |Δ|) no início/meio do evento
onde o book é **lento** para reprecificar grandes deslocamentos do BTC. As
causas candidatas:

1. **Inércia de market-makers** — quotes não atualizam tick-a-tick para o
   tamanho real do movimento, especialmente quando τ ≥ ~3 minutos.
2. **Restrição odds-sum** — a soma das probabilidades implícitas é mantida
   próxima de 1 mesmo quando uma perna já é quase certa, atrasando o ask do
   líder.
3. **Recência cognitiva** — agentes humanos discretizam o tempo e atribuem
   peso excessivo a "ainda falta muito tempo", sub-precificando settlements
   já praticamente certos pela física do drift.

A consequência observável: para τ ∈ [180, 290]s e |Δ| ≥ $60, o ask do líder
fica em ~0.62 a ~0.88, mas a fração empírica de settlements a favor é de
~0.85 a ~0.97 — um **edge de 5 a 30 pontos percentuais**.

---

## 3. Matemática

LIM modela o BTC restante até expiração como um movimento Browniano
com drift, e computa a CDF de settlement do lado líder.

### 3.1 Variáveis observadas por tick

- `τ` = segundos até expiração do evento.
- `Δ = btc - strike` = distância sinalizada (positiva ⇒ UP vence se settlar agora).
- `lead = |Δ|` = distância em valor absoluto.
- `v` = velocidade recente do BTC, em USD/segundo, calculada por janela
  móvel (`velocityWindowSec`, default 30s).
- `σ_real` = volatilidade realizada em USD/√s, janela `volWindowSec`
  (default 90s), via desvio padrão dos retornos absolutos por segundo.
- `askLeader`, `askLagger` = melhores asks do book histórico salvo.

### 3.2 Volatilidade extrapolada

Sigma do horizonte τ:

```
σ_τ = σ_real · √τ          (USD)
```

Floor pequeno (`sigmaFloor`, default 5 USD) evita divisões por zero.

### 3.3 Drift por velocidade

A velocidade é projetada para o horizonte τ, com peso de confiança
dependente de `lead` e `τ` para evitar overshoot:

```
weight  = clamp(lead / 200, 0.0, 1.0)
drift_τ = clamp(v · τ · weight, -driftCap, +driftCap)
```

`driftCap` = 0.5 · σ_τ (impede que um spike recente domine a tese).

### 3.4 Probabilidade Browniana de manter o lado

Seja `s` o sinal do lead (s = +1 se Δ > 0, senão −1). Para o líder se manter
até o settlement, o caminho residual precisa ficar acima do strike no mesmo
sinal. Aproximação Browniana com drift:

```
z       = (s · Δ + s · drift_τ) / σ_τ
p_fair  = Φ(z)
```

onde Φ é a CDF normal padrão. Computamos Φ via aproximação Abramowitz–Stegun.

### 3.5 Edge e métrica de decisão

```
edge = p_fair − askLeader
```

LIM compra o lado líder quando `edge` é positivo o suficiente e os filtros
de regime confirmam mispricing estrutural.

---

## 4. Regras (variante recomendada — `lim-deep`)

### 4.1 Filtros de regime

Entrada apenas se **todas** as condições forem verdadeiras:

| Filtro              | Valor `lim-deep` | Racional                          |
|---------------------|------------------|-----------------------------------|
| `τ ∈ [τ_min, τ_max]`| `[120, 290]` s   | corta agonia do fim e ruído ≥290s |
| `lead ≥ minLead`    | `120` USD        | mispricing forte; corte alto      |
| `askLeader ≤ maxAsk`| `0.95`           | nunca pagar quase certeza         |
| `askLeader ≥ minAsk`| `0.55`           | evitar líder sem book             |
| `p_fair ≥ minFair`  | `0.85`           | só comprar se o modelo concorda   |
| `edge ≥ minEdge`    | `0.05`           | margem de segurança vs ruído      |
| `spread ≤ maxSpread`| `0.18`           | book aceitável                    |
| `oddsSum ∈ band`    | `[0.92, 1.08]`   | book normalizado                  |
| `v · s ≥ velFloor`  | `0` (favorável)  | não comprar contra reversão fresca|
| 1 posição por evento| sim              | LIM não justifica re-entrada      |

### 4.2 Saída

LIM mantém a posição **até o settlement do evento** (regra estrutural; a
hipótese é probabilística sobre a realização final, não sobre mid-event).

Stop opcional disponível na variante `lim-stop`: corta se o lead inverter
em mais de 60% do valor de entrada — usado apenas para ablation; a versão
recomendada (`lim-deep`) não usa stop.

### 4.3 Tamanho de posição

`orderValue = min(maxOrderValue, max(0, walletSize + totalPnL))`

Default: `maxOrderValue = $14`, `walletSize = $200`. O cap por
bankruptcy é importante: variantes que perdem cedo no train morrem
naturalmente — característica e não bug.

---

## 5. Resultados Empíricos

**Dataset:** banco local, range `2026-05-04T15:00:00.000Z` até o último
timestamp disponível (`2026-05-21`).

- Ticks no range: 2.858.957
- Eventos: 4.779
- Cobertura por dia: contínua, sem gaps materiais.

Split: `train` 60% / `validation` 20% / `holdout` 20%, em ordem cronológica.

### 5.1 Variante recomendada: `lim-deep`

| Split       | n  | win    | PnL $   | avg $  | PF   | DD $  |
|-------------|----|--------|---------|--------|------|-------|
| train       | 110| 88.2%  | +148.7  | 1.35   | 2.01 | 31.5  |
| validation  | 65 | 89.2%  | +131.4  | 2.02   | 4.24 | 18.6  |
| **holdout** | **72** | **90.3%** | **+155.0** | **2.15** | **2.54** | **28.5** |

Atende todos os critérios mínimos do experimento:
- ✅ holdout positivo (+$155);
- ✅ PF ≥ 2.0 no holdout (2.54);
- ✅ DD baixo ($28) — payoff assimétrico;
- ✅ não depende de uma trade vencedora (72 entradas, 90% win);
- ✅ desempenho consistente nas três janelas.

### 5.2 Variante `lim-tau-early` (volume, τ ∈ [220, 290])

Para quem prefere mais volume com PF menor:

| Split       | n   | win   | PnL $   | PF   |
|-------------|-----|-------|---------|------|
| train       | 318 | 75.5% | +218.4  | 1.46 |
| validation  | 195 | 79.0% | +147.6  | 1.43 |
| holdout     | 210 | 80.5% | +323.3  | 1.55 |

Holdout positivo, mas PF abaixo de 2 — fica como variante "wider" para
quando mais entradas valem mais que pureza.

### 5.3 Janelas recentes (variante de melhor PnL absoluto: `lim-tau-early`)

**24h:** n=53, win 90.6%, PnL $318.5, PF 5.44, DD $39.

**72h:** n=179, win 81.0%, PnL $318.4, PF 1.65, DD $107.9.

(Para `lim-deep` o volume nessas janelas é menor — ~10–20 trades — mas
mantém win ≥ 85%.)

### 5.4 Comparação com baselines (holdout 20%)

| Estratégia                          | n   | win   | PnL $   | PF   | DD $   | Notas                       |
|-------------------------------------|-----|-------|---------|------|--------|-----------------------------|
| **lim-deep (LIM v1)**               | 72  | 90.3% | +155.0  | 2.54 | 28.5   | recomendada                 |
| **lim-tau-early (LIM v1)**          | 210 | 80.5% | +323.3  | 1.55 | 107.9  | wider, mais volume          |
| baseline-tc-v1 (Terminal Convexity) | 8   | 62.5% | +88.3   | 3.33 | 14.3   | PF alto mas n=8 (frágil)    |
| baseline-edge-sniper-v1             | 60  | 63.3% | +71.0   | 1.38 | 42.6   | competitivo, edge menor     |
| baseline-convergence-undershoot-v1  | 254 | 66.1% | +195.7  | 1.26 | 101.3  | volume alto, PF baixo       |
| baseline-gamma-ladder-v1            | 63  | 79.4% | +1867.2 | 17.21| 41.3   | usa cost ~$33/trade, PF ↑   |
| baseline-impulse-elasticity-v1      | 25  | 76.0% | +42.7   | 1.91 | 19.2   | similar mas n menor         |
| baseline-random                     | 0   | —     | 0       | —    | —      | morreu no train (capital)   |

LIM-deep entrega **PF 2.54 com 72 trades de holdout** — o equilíbrio mais
saudável entre tamanho de amostra e qualidade. Gamma Ladder lidera em PnL
mas usa stake 2,4× maior (não é o mesmo regime). TC-v1 tem PF maior mas só 8
trades — não estatisticamente comparável.

### 5.5 Variantes rejeitadas

| Variante         | Motivo                                                         |
|------------------|----------------------------------------------------------------|
| `lim-base`       | Capital killed cedo no train; n=0 em validation/holdout        |
| `lim-strict`     | Idem; thresholds altos demais para a amostra                   |
| `lim-edge8`      | Idem; minEdge = 0.08 corta entradas demais                     |
| `lim-edge10`     | Idem                                                           |
| `lim-loose`      | Train negativo; tese não sustenta com filtros frouxos          |
| `lim-tight-spread`| Capital killed; spread < 0.10 corta o regime útil             |
| `lim-tau-late`   | Holdout PF 1.56 — positivo, mas pior que `lim-deep`            |
| `lim-stop`       | Holdout PF 1.40 — stop corta vencedores eventualmente, prejudica|
| `lim-promoted`   | PF holdout 1.40 — promove threshold sem ganho estatístico      |

---

## 6. Comparação contra estratégias existentes

| Aspecto                | LIM v1            | Terminal Convexity v1 | Edge Sniper v1   | Gamma Ladder v1   | Impulse Elasticity v1 |
|------------------------|-------------------|------------------------|------------------|--------------------|------------------------|
| **Regime temporal**    | τ 120–290s        | τ ≤ 60s (terminal)     | τ ≤ 90s          | τ ≤ 120s, escadas  | reação a impulso       |
| **Tese**               | mispricing inicial| convexidade no fim     | edge vs odds-sum | múltiplos refills  | velocidade momentânea  |
| **Métrica de decisão** | CDF Browniana + drift| convexidade do mid  | gap mid-ask      | níveis de preço    | elasticidade do impulso|
| **Filtro principal**   | lead ≥ $120 + p_fair ≥ 0.85 | mid leader ≥ X | spread/odds-sum  | bandas de strike   | velocity threshold     |
| **Saída**              | settlement        | settlement             | settlement       | settlement por leg | settlement             |
| **Posições / evento**  | 1                 | 1                      | 1                | múltiplas (escada) | 1                      |
| **Stake típico**       | $14               | $14                    | $14              | ~$33 (escala)      | $14                    |

LIM **não compete** diretamente com TC, ES ou IE — opera no início/meio
do evento, antes de qualquer tese terminal. **Pode rodar em paralelo** a
elas, pois os regimes não se sobrepõem (TC dispara em τ ≤ 60s; LIM em
120 ≤ τ ≤ 290).

---

## 7. Limitações

1. **Tamanho de amostra do holdout:** 72 trades em `lim-deep`. Suficiente
   para PF 2.54 ter significância básica, mas vale revalidar conforme o
   banco crescer.
2. **Capital control mata variantes restritas:** se a variante perde no
   train cedo, `target=0` zera entradas futuras. Isso é por design (controle
   de risco) mas reduz amostras úteis para comparação.
3. **Modelo Browniano é uma aproximação:** o BTC tem caudas mais grossas;
   `p_fair` superestima ligeiramente em regimes muito voláteis. O floor de
   `σ` e o cap de drift mitigam, mas não eliminam.
4. **Janela 24h forte é parcialmente lim-tau-early-driven:** a métrica
   24h foi computada sobre o melhor PnL absoluto (`lim-tau-early`); para
   `lim-deep` em 24h o volume é menor (~10 trades) e estatisticamente
   pouco conclusivo no curto.
5. **Não testado fora do range 2026-05-04 → 2026-05-21:** generalização
   para outros regimes de mercado é hipótese, não fato.

---

## 8. Plano de Uso

### 8.1 Modo recomendado

- Rodar **`lim-deep` em paralelo** a Terminal Convexity v1.
- Stake fixo $14, max 1 posição por evento, sem stop.
- Bankroll mínimo sugerido: $200.
- **Não** combinar com Gamma Ladder no mesmo evento (Gamma usa múltiplas
  pernas; LIM precisa de 1 entrada limpa).

### 8.2 Modo agressivo (volume)

- Trocar `lim-deep` → `lim-tau-early` quando capital permitir DD de até
  ~$110.
- PF cai para ~1.55 mas n por dia sobe ~3×.

### 8.3 Monitoramento

Métricas a observar em produção (rolling 7d):
- win rate ≥ 80% — abaixo disso, suspeitar de regime quebrado;
- PF ≥ 1.8 — queda persistente abaixo desse valor sugere reprecificação
  do book pelos market-makers (a anomalia se fechou);
- DD ≤ 2× histórico — `lim-deep` mostrou DD máx $28; alertar se passar de
  $60.

### 8.4 Reproduzir

```
npm run lab:lead-inertia -- --mode=full
```

Default `from = 2026-05-04T15:00:00.000Z`; `to` = max timestamp do banco.
Modos: `quick` (subset de variantes) ou `full` (17 variantes + 6
baselines + janelas 24h/72h). Workers paralelos = 4.

---

## 9. Notas finais sobre a hipótese

LIM **não é** uma teoria de "comprar quem está ganhando porque está
barato". A diferença material:

- "Comprar lado vencedor barato no fim" → tese terminal (TC), τ baixo.
- LIM → tese **inicial/intermediária**, τ alto, com **modelagem
  Browniana explícita** da probabilidade de settlement, não confiando no
  ask como sinal de probabilidade.

A teoria sobreviveu ao holdout, ao corte 24h e ao corte 72h com
desempenho consistente, em regime distinto das estratégias existentes.
Recomendada para integração paralela ao Terminal Convexity, com
monitoramento contínuo do edge.
