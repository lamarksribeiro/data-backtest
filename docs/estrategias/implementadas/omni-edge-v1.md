# OMNI EDGE V1 — Compositor Bayesiano Multi-Regime

## Tese central

Cada estratégia atual do laboratório explora **um regime ortogonal** do mercado
binário Polymarket BTC 5-min:

| Módulo                | Regime explorado                                                                |
| --------------------- | ------------------------------------------------------------------------------- |
| Lead Inertia          | Continuação de tendência direcional clara cedo no evento                        |
| Stable Carry          | Range estável + spread limpo, prêmio assimétrico no “Up”/“Down” YES             |
| Gamma Ladder          | Tail negociado em sequências (não-direcional, sobre books desbalanceados)       |
| Terminal Convexity    | Final do evento, convexidade do payout (~últimos 90s)                           |
| Cofre Sete            | Coleta de gotinhas em janelas longas com risk-of-ruin baixíssimo                |
| Impulse Elasticity    | Reversão pós-impulso (mean-reversion rápido)                                    |
| Edge Sniper           | Mispricing severo entre book BTC e implied odds (signal-rich, pouca frequência) |
| VCL (opcional/off)    | Quebra de squeeze de volatilidade — falso-positivo elevado, off por default     |

Rodar todos em paralelo aumenta a frequência mas **explode drawdown** quando
correlações sobem (todos perdem juntos em regimes patológicos: choque BTC,
liquidez seca, expiração caótica). A `Fusion Five V1` mitiga isso com pesos
fixos; OMNI EDGE V1 vai além usando **alocação adaptativa Bayesiana**.

## Matemática aplicada

### 1. Posterior Beta por módulo

Cada módulo `m` mantém um Beta(α, β) atualizado on-line com cada trade fechado:
- $\alpha_m \mathrel{+}= 1$ se trade vencedor;
- $\beta_m \mathrel{+}= 1$ caso contrário.

O prior é $(\alpha_0, \beta_0) = (8, 8)$ — equivalente a 16 trades fictícios
50/50, suficiente para evitar overconfidence sem matar warm-up real.

Probabilidade pontual estimada: $\hat{p}_m = \frac{\alpha_m}{\alpha_m + \beta_m}$.

### 2. Wilson Lower Bound como gate de entrada

Antes de aceitar uma proposta do módulo `m`, calculamos:

$$
\text{Wilson LB}(p, n, z) = \frac{p + \frac{z^2}{2n} - z\sqrt{\frac{p(1-p) + \frac{z^2}{4n}}{n}}}{1 + \frac{z^2}{n}}
$$

Com $z=1.0$ (≈ 84% one-sided), módulo só pode operar se
$\text{Wilson LB} \ge 0.50$ **após warmup** ($n \ge 5$ trades reais).
Isso elimina módulos em má fase sem esperar a estatística clássica
ficar significativa.

### 3. Sizing fracional de Kelly

Para sizing dentro do cap do evento usamos Kelly fracional com payout binário 1:1:

$$
f^* = \max(0, 2\hat{p} - 1) \cdot k
$$

onde $k = 0.5$ (half-Kelly, regra padrão para reduzir variância empírica).
$f^*$ é então clampado em $[0.20, 1.50]$ relativamente ao sizing nativo
do módulo. Módulo nunca recebe mais que 1.5× sua aposta default mesmo em
hot-streak (proteção a variance bleed).

### 4. Regime gate via volatilidade realizada

A cada 250ms amostramos o último preço BTC. Por bucket de 1 min calculamos:

$$
\sigma_w = \sqrt{\sum_{i \in w} (r_i)^2} / \sqrt{|w|}
$$

(retornos log de tick-a-tick na janela $w$ de 3600s). Se
$\sigma_w \ge 6.0\,\text{USD/s}$ no momento da proposta, **apenas módulos
não-direcionais** (Gamma, Cofre) podem operar — direcionais (Lead, Stable,
Terminal, Impulse, Edge, VCL) ficam embargados. Reduz exposição em choques.

### 5. Cooldown adaptativo por drawdown rolante

Janela rolante de 12 trades por módulo. Se a soma de PnL fechado na janela
≤ -20% × wallet inicial, módulo entra em cooldown de 12h. Sai automaticamente
após o tempo. Combinado com Wilson LB, dá um sistema de “suspender + reentrar
sob prova”.

### 6. Halt global de drawdown

Se equity global cair $200 abaixo do pico, **toda** entrada nova é bloqueada
até equity recuperar acima do halt. Não há resize automático — proteção dura.

### 7. Dedup mesmo lado (preferir edge score)

Se 2 módulos propõem entrada no mesmo evento, mesmo lado e dentro do
mesmo bucket de 5s, apenas o de maior `priority/edgeScore` entra; os outros
são rejeitados com motivo `dedup_same_side`. Evita doubling artificial e
reduz correlação.

## Parâmetros default

```js
{
  walletSize: 100,
  maxEventStackCost: 60,         // teto de exposição por evento
  maxModulesPerEvent: 3,         // diversidade obrigatória
  globalHaltDrawdown: 200,
  includeModules: ['lead', 'stable', 'gamma', 'terminal', 'cofre', 'impulse', 'edge'],
  bayes: {
    priorAlpha: 8, priorBeta: 8,
    wilsonZ: 1.0, minWilsonLb: 0.50,
    warmupTrades: 5, kellyMultiplier: 0.5,
    minSizeFactor: 0.20, maxSizeFactor: 1.50,
  },
  streak: { rollingWindow: 12, lossBudgetPctWallet: 0.20, cooldownSec: 43200 },
  regimeGate: { enabled: true, volWindowSec: 3600, volPanicThreshold: 6.0,
                spareNonDirectional: true },
  dedupSameSidePreferEdge: true,
}
```

## Validação

Use `npm run lab:omni-edge -- --from 2026-05-19T00:00:00Z --to 2026-05-20T00:00:00Z --mode full`
para split 60/20/20 + baselines individuais + Fusion Five.

Pela UI: `Backtest → modo OMNI EDGE V1`, exposta no `/api/backtest/omni-edge`.

## Sinais de saúde a monitorar

- `moduleHealth[m]`: posterior atual ($\alpha, \beta, \hat{p}$, Wilson LB).
- `summary.rejected`: motivos de bloqueio (`wilson_lb`, `cooldown`,
  `regime_vol_panic`, `global_halt`, `event_stack_cap`, `max_modules`,
  `dedup_same_side`).
- `summary.baselines`: PnL/PF/MaxDD que cada módulo teria sozinho.

## Próximos passos

1. Calibrar `kellyMultiplier` por módulo (atual: uniforme 0.5).
2. Substituir warmup fixo por critério MDL — começar a usar Wilson tão logo
   ganho informacional > limiar.
3. Adicionar “memória de regime” — features curtas (vol burst, spread shock)
   que pré-classifiquem o evento antes de qualquer módulo abrir.
