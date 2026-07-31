# Pair Floor Invariant (PFI) V1

**Status:** research / interessante estruturalmente · **não é GO de size real**  
**Família:** market-neutral / dual-side / complete-set floor  
**Laboratório:** `scripts/lab-pair-floor-invariant.mjs`  
**Comando:** `npm run lab:pair-floor-invariant`  
**Data do experimento:** 2026-07-31  
**Não é:** Terminal Convexity, Edge Sniper, Gamma Ladder, Impulse Elasticity, Pair-Path, Escada, Cofre Sete.

---

## Nome da teoria

**Pair Floor Invariant V1 (PFI)** — invariante de piso de par.

A única entrada dual-side defensável neste mercado, após fees reais da Polymarket crypto, é comprar **quantidades iguais** de UP e DOWN quando o **piso de settlement pré-trade** (depois de fees, slippage e partial fill) é **não negativo**.

---

## Hipótese

No BTC Up/Down 5m, o payout de um par equalizado é determinístico:

\[
\text{payout} = q \cdot 1
\quad\text{(exatamente um lado resolve em \$1)}
\]

O custo all-in de montar o par como taker é:

\[
C = q\,(p_{UP}+p_{DOWN}) + F(q,p_{UP}) + F(q,p_{DOWN})
\]

com a fee oficial Polymarket crypto:

\[
F(q,p) = q \cdot r \cdot p \cdot (1-p), \quad r = 0.07
\]

([docs.polymarket.com/trading/fees](https://docs.polymarket.com/trading/fees)).

O **piso de par** (por share equalizada) é:

\[
\pi_{\text{floor}} = 1 - (p_{UP}+p_{DOWN}) - r\,p_{UP}(1-p_{UP}) - r\,p_{DOWN}(1-p_{DOWN})
\]

**Hipótese central:** o mercado quase sempre precifica \(p_{UP}+p_{DOWN} \approx 1.01\), o que, após fees, deixa \(\pi_{\text{floor}} \approx -0.035\). Oportunidades com \(\pi_{\text{floor}} \ge \varepsilon\) existem, são **estruturalmente market-neutral**, mas são **extremamente raras** e precisam de book válido (bid ≤ ask, spread apertado, tamanho real).

Lucro **não** vem de adivinhar se o BTC fecha acima ou abaixo do PTB. Vem de \(C < q\).

---

## Por que é não direcional

Para um par equalizado:

| Settlement | Recebe | Resultado líquido |
|---|---|---|
| UP vence | \(q\) | \(q - C\) |
| DOWN vence | \(q\) | \(q - C\) |

Os dois resultados são **idênticos**. Não há dependência de lado. `pnlIfUp == pnlIfDown == worst == best` por construção.

---

## Três hipóteses candidatas testadas

### H1 — Atomic Pair Floor (promovida)

- Entrar **só** se book válido e \(\pi_{\text{floor}} \ge \varepsilon\) (default \(\varepsilon=0.005\)).
- Comprar UP e DOWN no **mesmo tick** (par atômico de snapshot).
- Walk no book histórico com slippage cap e partial fill.
- Segurar até settlement (não precisa de saída).
- Máx. 1 estrutura por evento.

### H2 — Armed Sequential Completion (rejeitada)

- Abrir uma perna quando o floor projetado já está perto de zero.
- Completar a segunda quando o lock líquido ≥ limiar; senão dump residual.
- **Resultado:** residual tóxico destrói EV (espelha Pair-Path / protect-arb).
- Variante “cheaper open + complete later”: **−\$18k** no range, PF 0.56.

### H3 — Quasi Floor Hold (rejeitada)

- Comprar dual quando \(\pi_{\text{floor}} \in [-0.01, 0)\).
- Pior caso controlado (~1¢/share), mas **expectativa líquida negativa** (fee drag).
- n pequeno e holdout negativo.

### Hipóteses descartadas na exploração (antes do lab)

| Ideia | Por quê morreu |
|---|---|
| Arb bruta sem filtrar book invertido | Artefato de dados (bid > ask) |
| Free-roll temporal (vender uma perna ≥ custo total) | ~0% de freeroll após entrada dual típica |
| Straddle barato hold (ask_sum ≤ 1.02) | Floor médio ~−4¢ após fees |
| Dual aleatório | −0.31/evento, WR ≈ 0%, 100% side-neutral **prejuízo** |

---

## Matemática operacional (pré-entrada)

Antes de cada entrada o lab calcula:

| Métrica | Fórmula / definição |
|---|---|
| Custo UP | \(q \cdot \bar p_{UP}\) (walk) |
| Custo DOWN | \(q \cdot \bar p_{DOWN}\) |
| Custo combinado | soma |
| Fee esperada | \(F_{UP}+F_{DOWN}\) (taker crypto) |
| Slippage | cap `ask + slipMax` no walk |
| Pior caso líquido | \(\min(\text{pnlIfUp},\text{pnlIfDown})\) |
| Melhor caso líquido | \(\max(\text{pnlIfUp},\text{pnlIfDown})\) |
| Se UP vencer | payout UP − custos − fees |
| Se DOWN vencer | payout DOWN − custos − fees |
| Break-even | \(C = q\) (par equalizado) |
| Margem de segurança | \(\pi_{\text{floor}} - \varepsilon\) |
| Risco máx. por evento | conhecido: se equalizado e floor≥0, risco≈0 (exceto falha de fill) |
| Saída antes do settlement | **não necessária** na H1 |

### Critério de entrada H1

Entra somente se **arbitragem líquida realista** (família 1 do brief):

1. Book válido: `bid ≤ ask`, spread ≤ 0.04, tamanhos > 0.
2. \(\pi_{\text{floor}}^{\text{TOB}} \ge \varepsilon\).
3. Walk equalizado com `fillFrac` e `slipMax` ainda deixa floor realizado aceitável.
4. Uma estrutura por evento.

---

## Regras de saída e settlement

**H1 (recomendada):**

- **Saída parcial:** não.
- **Saída total:** não (exceto se no futuro houver inventário residual por fill falho — fora do caminho feliz).
- **Settlement:** redeem do lado vencedor; o outro zera.
- PnL líquido = \(q - C_{\text{all-in}}\).

**H2 (rejeitada):** complete ou dump residual; settlement do inventário restante.

---

## Fees, slippage e partial fills

### Fees

Modelo oficial crypto taker:

```text
fee = shares * 0.07 * price * (1 - price)
```

Maker fee = 0 (cenário counterfactual no lab).  
Rebate Diamond 44% testado como cenário otimista (não assumido no base).

### Impacto medido (H1-atomic-5bp, base)

| Item | Valor |
|---|---:|
| Fee total na amostra | \$3.18 |
| PnL líquido | +\$2.77 |
| Fee drag % | ~53% do (PnL+\|fees\|) |
| Conclusão | Edge **sobrevive** fees, mas fees comem ~metade do gross estrutural |

### Slippage / partial

- Walk L1 (e profundidade se presente) com `slipMax=0.02`.
- `fillFrac=0.5` (base) e `0.3` (stress): ambos positivos na H1.
- Partial fill que **desbalanceia** o par é rejeitado ou reduz qty equalizada.

---

## Recorte de dados

Fonte: lake local DuckDB/Parquet `backtest_ticks` BTC 5m book_depth=25  
(Postgres `goldenlens.ticks` existe localmente, mas o lake é a série canônica de backtest.)

| Métrica | Valor |
|---|---:|
| From | `2026-05-04T15:00:00.000Z` |
| To | `2026-07-30T05:59:59.663Z` |
| Ticks | 15,255,943 |
| Eventos | 23,589 |
| Ticks com ambos books | 13,869,865 |
| Ticks book válido (bid≤ask) | 13,869,709 |
| Avg ask_UP+ask_DOWN | 1.0108 |
| Avg bid_UP+bid_DOWN | 0.9892 |
| Ticks floor>0 após fee (book válido) | 30 |
| Eventos floor>0 | 25 |
| Eventos floor≥0.5¢ | 21 |
| Avg floor (todos ticks válidos) | **−0.0353** |

Gaps inter-tick: p99 ~0.5s, max ~16s (aceitável).

---

## Resultados empíricos

### Variante recomendada: `H1-atomic-5bp`

Parâmetros: `minEdge=0.005`, `budget=15`, `fillFrac=0.5`, `slipMax=0.02`, `maxSpread=0.04`, fee 7% sem rebate.

| Janela | n | PnL líq. | WR* | PF | Max DD | Side-neutral | Avg worst |
|---|---:|---:|---:|---:|---:|---:|---:|
| Full | 20 | **+2.77** | 0.55† | ∞‡ | 0 | **100%** | +0.14 |
| Train 60% | ~12 | >0 | — | ∞ | 0 | 100% | — |
| Val 20% | ~4 | >0 | — | ∞ | 0 | 100% | — |
| **Holdout 20%** | **4** | **+0.53** | 0.5† | ∞ | 0 | **100%** | +0.13 |
| Últimas 72h | 1 | +0.32 | 1 | ∞ | 0 | 100% | +0.32 |
| Últimas 24h | 1 | +0.32 | 1 | ∞ | 0 | 100% | +0.32 |

\*WR usa limiar |pnl|>0.05; várias trades são micro-positivas (flat band).  
†Na verdade **0 perdas** (maxLoss≥0): floor≥0 implica PnL≥0 se o par equaliza.  
‡PF=∞ (sem trades negativos).

### Outras H1

| Variante | n | Full PnL | Holdout PnL | Notas |
|---|---:|---:|---:|---|
| H1-atomic-0 | 24 | +2.86 | +0.64 | Mais trades, edge mais fino |
| H1-atomic-1c | 11 | +2.66 | +0.58 | Mais seletiva |
| H1-atomic-5bp-fill30 | 20 | +1.74 | +0.34 | Stress partial fill |
| H1-atomic-5bp-confirm2 | 1 | +0.25 | +0.25 | Confirmação 2 ticks esteriliza |

### H2 / H3 (rejeitadas)

| Variante | n | Full PnL | Holdout | Motivo rejeição |
|---|---:|---:|---:|---|
| H2-armed-0 | 2 | −9.62 | n=1 | Amostra inútil + residual |
| H2-armed-5bp | 0 | 0 | 0 | Sem entradas |
| H2-cheaper-toxic | 19,542 | **−18,070** | −3,213 | Residual tóxico |
| H3-quasi-1c | 5 | −0.25 | −0.10 | Floor negativo por design |

### Baselines (mesmo range)

| Baseline | n | Full PnL | Holdout PnL | Side-neutral |
|---|---:|---:|---:|---:|
| only UP | 15,919 | −13,057 | −3,033 | 0% |
| only DOWN | 15,739 | −10,688 | −1,110 | 0% |
| random dual hold | 23,456 | **−7,195** | −1,434 | **100%** (prejuízo simétrico) |

Interpretação: **ser dual não basta**. Dual sem invariante de floor é a forma mais limpa de **doar fees** ao mercado.

### Sensibilidade de fee (família H1-atomic-5bp)

| Cenário | n | Full PnL | Holdout |
|---|---:|---:|---:|
| Pessimista / base (r=7%, rebate 0) | 20 | +2.77 | +0.53 |
| Otimista (rebate Diamond 44%) | 31 | +4.97 | +1.11 |
| Maker 0% (counterfactual) | 88 | +11.76 | +2.86 |

Edge H1 **não depende** de rebate; rebate só aumenta frequência/tamanho do bolso.

---

## Comparação com estratégias existentes

| Estratégia | Direcional? | Dual? | Natureza do edge |
|---|---|---|---|
| Edge Sniper | Sim | Não | Favorito barato |
| Terminal Convexity | Sim | Não | Convexidade terminal |
| Gamma Ladder | Sim | Não | Escada direcional |
| Impulse Elasticity | Sim | Não | Elasticidade de impulso |
| Pair-Path / Clip-Path | Parcial | Sim (path) | Complete-set path; residual risk |
| Paridade Invariante | Não | Sim | Arb atômica (mesma família) |
| **PFI V1** | **Não** | **Sim atômico** | **Piso de settlement pós-fee** |

PFI é **prima metodológica** da Paridade Invariante, mas com:

1. rejeição explícita de books invertidos;
2. walk + partial + fee scenario matrix;
3. confronto sistemático com sequencial/quasi/baselines;
4. veredito de **frequência operacional** (não só existência de edge).

Não compete em PnL bruto com Edge Sniper/TC: compete em **neutralidade e pior caso**.

---

## Expectativa líquida

| Métrica | H1-atomic-5bp |
|---|---:|
| Expectancy / trade | +\$0.14 |
| Expectancy / \$ arriscado | ~ilimitada no caminho feliz (worst≈0 se equalizado) |
| Trades / dia | ~0.23 |
| PnL / dia médio | ~\$0.03 |
| Frequência de empate exato | alta na banda micro (flatRate 0.45 com limiar 5¢) |
| Frequência de ganho | 100% das entradas equalizadas com floor≥ε |
| Frequência de perda | 0% na amostra (caminho feliz) |

---

## Pior caso e melhor caso

**Por trade (H1 equalizada, floor≥ε):**

- **Pior caso teórico pré-trade:** \(q \cdot \pi_{\text{floor}} \ge q\varepsilon > 0\) se fills iguais.
- **Pior caso operacional real:** falha de uma perna (leg risk) → vira posição direcional de tamanho \(q\). **Polymarket não oferece ordem atômica cross-outcome.**
- **Melhor caso:** maior \(\pi_{\text{floor}}\) observado ~6.8¢/share (raríssimo).

**Drawdown da curva H1 na amostra:** 0 (nenhuma trade negativa).

---

## Limitações (obrigatórias)

1. **Frequência ultra-baixa** (~20 eventos em ~87 dias). Não escala wallet.
2. **Holdout n=4** — estatisticamente frágil; PF infinito por ausência de perdas, não por amostra grande.
3. **Leg risk live:** o backtest assume fill pareado no mesmo snapshot; live precisa de reconciliação se uma perna falhar.
4. **Qualidade de book:** edge depende de asks simultaneamente baratos e consistentes; ticks anômalos ainda podem passar filtros.
5. **Não é alpha direcional reutilizável** — é captura de micro-deslocamento de invariante.
6. **Fee drag alto (~50%)** — qualquer piora de fee/rebate ou slippage come o bolso.
7. **Não prometer lucro real.** Resultado é backtest local com simulação de book.

---

## Quando não operar

- Se \(\pi_{\text{floor}} < \varepsilon\) após fees.
- Book invertido ou spread > 0.04.
- Tamanho visível insuficiente para equalizar.
- Sem capacidade de **gerir leg risk** em <1s.
- Expectativa de volume (quer trades frequentes).
- Regime em que o recorder tem gaps grandes ou coverage < 0.99.

---

## Plano de uso

1. **Paper / shadow only** por enquanto.
2. Variante default: `H1-atomic-5bp`.
3. Alarme se >0 entradas/dia por vários dias (mudança de microestrutura ou bug de dados).
4. Live micro só com:
   - executor que **aborta/hedgeia** se segunda perna falhar;
   - size ≤ budget lab (\$10–15 notional par);
   - log de floor pré-trade em todo signal.
5. **Não** combinar com sequential cheaper-open (H2-toxic).
6. Revalidar trimestralmente: se `events_floor_pos` cair a 0, a teoria hiberna.

### Reprodução

```bash
npm run lab:pair-floor-invariant
# ou
node --max-old-space-size=8192 scripts/lab-pair-floor-invariant.mjs \
  --from 2026-05-04T15:00:00.000Z \
  --mode research \
  --fee-scenario base
```

Cenários de fee: `--fee-scenario pessimistic|base|optimistic|maker`.

Relatórios: `reports/labs/pair-floor-invariant/pfi-*.json`.

---

## Variantes rejeitadas (resumo)

| Variante | Por quê |
|---|---|
| H2 sequential armed / cheaper | Residual tóxico; EV negativo em escala |
| H3 quasi-floor hold | Floor negativo por design; fees ganham |
| Dual aleatório | Prejuízo sistemático side-neutral |
| only UP / only DOWN | Direcional e negativo no recorte de baseline |
| Free-roll / dual lock por bid sum | Frequência ~0 após custos |
| Confirm2 como default | n=1 — overfilter |

---

## Veredito final

**Existe** uma teoria dual-side market-neutral com matemática defensável e holdout líquido positivo: **Atomic Pair Floor (H1)**.

**Não existe** evidência suficiente para uso real em tamanho: a amostra é pequena, a frequência é mínima, e o risco operacional de perna é real.

O achado científico principal é negativo-construtivo:

> Comprar UP+DOWN sem invariante de piso pós-fee é, em média, doar ~3–4¢ por share ao mercado. A única dual-side que sobrevive é a arb atômica rara com book válido.

Postura: **research interessante, operação conservadora, sem promessa de lucro.**
