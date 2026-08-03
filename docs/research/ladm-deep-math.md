# LADM — Matemática profunda (filtração, residual, informação)

Gerado a partir de `phase3-deep-math.mjs` | range **2026-05-04 → 2026-07-15** | n=69185

## 1. Objeto matemático

Seja o evento de 5 minutos com barreira (K) (PTB) e settlement
\[
Y = \mathbf{1}_{\{S_T^{\mathrm{set}} \ge K\}} \in \{0,1\}.
\]
Preço ask UP no instante (t): (C_t \in (0,1)). Residual de mercado:
\[
R_t := Y - C_t.
\]
### Filtrações

- (\mathcal{F}_t): informação do venue (book + oráculo/lake).
- (\mathcal{B}_t = \sigma(S_u^{\mathrm{Bin}} : u \le t)): história Binance.
- (\mathcal{G}_t = \mathcal{F}_t \vee \mathcal{B}_t): filtração ampliada.

Sob precificação “eficiente” em (\mathcal{F}):
\[
C_t \approx \mathbb{E}[Y \mid \mathcal{F}_t] \quad \Rightarrow \quad \mathbb{E}[R_t \mid \mathcal{F}_t] \approx 0.
\]
A descoberta empírica é a **falha de eficiência sob (\mathcal{G})**:
\[
\mathbb{E}[R_t \mid \mathcal{G}_t] = \mu_t \neq 0,
\]
com *information drift* (\mu_t) mensurável em (\mathcal{B}_t) (impulso de curto prazo).

### Impulso normalizado

Para lag (\ell) e vol local (\hat\sigma_t) (1s, janela 30s):
\[
Z_t^{(\ell)} = \frac{S_t^{\mathrm{Bin}} - S_{t-\ell}^{\mathrm{Bin}}}{\hat\sigma_t \sqrt{\ell}}.
\]
Moneyness de barreira (escala do ruído residual):
\[
m_t = \frac{S_t^{\mathrm{oracle}} - K}{\hat\sigma_t \sqrt{\tau}}, \quad \tau = T-t.
\]
Lead gap (Binance vs oráculo no mesmo (\ell=2)):
\[
\Gamma_t = \Delta^{\mathrm{Bin}}_{2s} S_t - \Delta^{\mathrm{oracle}}_{2s} S_t.
\]

## 2. Seleção de lag (evidência)

| ℓ | corr(Z,R) train | corr(Z,ΔC₂s) | corr(Z,ΔC₅s) |
|--:|---:|---:|---:|
| 1 | 0.0574 | 0.2944 | 0.2325 |
| 2 | 0.0589 | 0.2940 | 0.2314 |
| 3 | 0.0533 | 0.2616 | 0.2090 |
| 4 | 0.0478 | 0.2415 | 0.1898 |
| 5 | 0.0455 | 0.2195 | 0.1739 |

## 3. Modelos aninhados para (R_t) (OLS)

Família: (R = X\beta + \varepsilon), com features em (Z,m,\tau,\Gamma), stale.

| Modelo | R² train | R²(R) holdout | Brier mkt | Brier C+Xβ | ΔBrier |
|---|---:|---:|---:|---:|---:|
| M0_intercept | 0.0000 | -0.0000 | 0.14737 | 0.14737 | 0.00000 |
| M1_Z2 | 0.0035 | 0.0018 | 0.14737 | 0.14709 | 0.00028 |
| M2_Z2_tanh | 0.0033 | 0.0018 | 0.14737 | 0.14710 | 0.00027 |
| M3_Z2_m | 0.0040 | 0.0025 | 0.14737 | 0.14698 | 0.00039 |
| M4_Z2_m_tau | 0.0040 | 0.0025 | 0.14737 | 0.14698 | 0.00039 |
| M5_Z2_m_Z2xm | 0.0040 | 0.0025 | 0.14737 | 0.14698 | 0.00039 |
| M6_asym | 0.0035 | 0.0018 | 0.14737 | 0.14709 | 0.00028 |
| M7_Z2_leadGap | 0.0037 | 0.0021 | 0.14737 | 0.14705 | 0.00032 |
| M8_Z2_m_leadGap_tau | 0.0042 | 0.0027 | 0.14737 | 0.14695 | 0.00042 |
| M9_Z2_stale | 0.0035 | 0.0020 | 0.14737 | 0.14706 | 0.00031 |

### Partial R² (ganho além de só Z)

```
{
  "M5_vs_M1": 0.0004852784292513901,
  "M6_vs_M1": 0.0000024152452392511847,
  "M8_vs_M1": 0.0007154081198574858,
  "M9_vs_M1": 0.00005433556664713457
}
```

Melhor OLS por Brier holdout: **M8_Z2_m_leadGap_tau** — β0=-0.0034 (t=-0.71), β1=0.0189 (t=9.00), β2=0.0000 (t=4.49), β3=0.0094 (t=3.09), β4=-0.0012 (t=-0.20)

## 4. Path catch-up vs residual terminal

Decomposição empírica: o book *reage* ((\Delta C\)) e o settlement *realiza* ((Y\)).
Se (Z) só prevê (\Delta C) e o residual terminal some após ortogonalizar a (\Delta C_{2s}),
o edge seria **apenas latência de path** (scalp). Se (Z) ainda prediz (R_\perp), há **edge de settlement**.

```
{
  "train": {
    "corr_Z_R": 0.058946391297685544,
    "corr_Z_dC2": 0.29395783163180966,
    "corr_dC2_R": 0.14958716850737844,
    "corr_Z_Rorth": 0.015144468962005901,
    "r2_R_on_dC2": 0.02237632098192821,
    "r2_Rorth_on_Z": 0.00022935494014275637,
    "beta_Z_on_Rorth": [
      0.000049891995949463065,
      0.005618841566538019
    ],
    "t_Z_on_Rorth": [
      0.026525280790404886,
      3.085814127614691
    ]
  },
  "holdout": {
    "corr_Z_R": 0.04546912832506951,
    "corr_Z_Rorth": -0.00532871533531757,
    "n": 13837
  }
}
```

## 5. Assimetria ímpar/par de (\mu(Z))

Se (\mu(Z) = \mathbb{E}[R|Z]) for ímpar, (E[R|Z\ge z] + E[R|Z\le -z] \approx 0).

| z | n↑ | n↓ | E[R|Z≥z] | E[R|Z≤−z] | skew_gap (soma) | mag_gap |
|--:|--:|--:|---:|---:|---:|---:|
| 1 | 1549 | 1333 | 0.0246 | -0.0332 | -0.0086 | -0.0086 |
| 1.5 | 844 | 762 | 0.0566 | -0.0550 | 0.0017 | 0.0017 |
| 2 | 606 | 568 | 0.0689 | -0.0534 | 0.0155 | 0.0155 |
| 2.5 | 432 | 417 | 0.0719 | -0.0586 | 0.0133 | 0.0133 |

## 6. Interação com moneyness (m)

| bin | n | corr(Z,R) | n_strong | E[R\|Z≥1.5] | E[R\|Z≤−1.5] |
|---|---:|---:|---:|---:|---:|
| |m|<0.5 | 2197 | 0.1145 | 333 | 0.1254 | -0.1470 |
| 0.5≤|m|<1.5 | 4060 | 0.0529 | 525 | 0.0630 | -0.0632 |
| 1.5≤|m|<3 | 3171 | 0.0413 | 422 | 0.0567 | -0.0219 |
| |m|≥3 | 4409 | -0.0144 | 326 | -0.0151 | 0.0197 |

## 7. Modelo de probabilidade (logit aninhado)

\[
\mathrm{logit}\,\mathbb{P}(Y=1\mid\mathcal{G}_t) = \alpha + \beta_0\,\mathrm{logit}(C_t) + \beta_Z Z_t + \beta_m m_t + \beta_{Zm} Z_t m_t + \cdots
\]

| Modelo | ll train | Brier holdout | Logloss holdout | Brier mkt | Δlogloss |
|---|---:|---:|---:|---:|---:|
| L0_logitC | -19178.0 | 0.14720 | 0.45441 | 0.14737 | 0.00073 |
| L1_logitC_Z | -19107.8 | 0.14682 | 0.45353 | 0.14737 | 0.00161 |
| L2_logitC_Z_m_Zxm | -19099.3 | 0.14675 | 0.45327 | 0.14737 | 0.00186 |
| L3_full | -19093.5 | 0.14669 | 0.45310 | 0.14737 | 0.00204 |
| L4_asym | -19107.8 | 0.14682 | 0.45352 | 0.14737 | 0.00162 |

LR tests (train):
```
{
  "L1_vs_L0": {
    "stat": 140.36328626678733,
    "df": 1,
    "p_approx": 0
  },
  "L2_vs_L1": {
    "stat": 17.078156247116567,
    "df": 2,
    "p_approx": 0.0002649810613652992
  },
  "L3_vs_L2": {
    "stat": 11.504599241343385,
    "df": 2,
    "p_approx": 0.0033782185984616575
  }
}
```

## 8. Residualização dupla (além de estado de barreira)

Resíduo (e = R - \Pi_{m,\tau,C} R), depois (e \sim Z):
```
{
  "train_corr_e_Z": 0.05802105132248555,
  "train_r2_e_on_Z": 0.003366442396554481,
  "beta_Z": 0.02176371331754488,
  "t_Z": 11.841016223297244,
  "holdout_corr_e_Z": 0.04487955149474214,
  "note": "R residualized on m,τ,C then regressed on Z — isolates lead beyond barrier state"
}
```

## 9. Information drift e Kelly conceitual

```
{
  "beta_Z": 0.022118954420756964,
  "t_Z": 12.03051274536508,
  "mean_abs_drift_strong": 0.060396632645649095,
  "mean_signed_aligned": 0.060396632645649095
}
```

Para aposta unitária no lado alinhado com preço (C) e probabilidade real (p = C + \mu):
\[
f^\star = \frac{p - C}{1 - C} \quad (\text{lado UP barato}), \quad \mu = p - C.
\]
Com (\mu \approx \beta_Z Z) e (Z\sim 2), (\mu \sim 2\beta_Z) (ordem dos pp observados).

## 10. Var condicional

```
{
  "flat": {
    "n": 10385,
    "mean_R2": 0.1470128822339949,
    "brier": 0.1470128822339949
  },
  "strong": {
    "n": 1606,
    "mean_R2": 0.15225413885429648,
    "brier": 0.15225413885429648
  }
}
```

## 11. Síntese matemática do que há *a mais*

### 11.1 Canal de informação (DAG empírico)

```text
Z^(2)  ──corr≈0.29──►  ΔC_{2s}  ──►  alinhamento path do book
  │                        │
  │ corr≈0.05              │
  ▼                        ▼
  R = Y − C   com   R ≈ α + β ΔC_{2s} + R_⊥
                     e  corr(Z, R_⊥) ≈ 0 no holdout
```

Interpretação rigorosa:

- Em \(t\), \(\Delta C_{2s}\) é **futuro** → \(\mathbb{E}[R_t\mid Z_t]=\mathbb{E}[\alpha+\beta\Delta C_{2s}+R_\perp\mid Z_t]\approx \beta\,\mathbb{E}[\Delta C_{2s}\mid Z_t]\).
- O edge de **hold-to-settle** em \(t\) é real se e só se \(\mathbb{E}[R_t\mid Z_t]\neq 0\) (medido: sim).
- Mas o **mecanismo** é quase inteiramente: *Z prevê o catch-up do ask*, e esse catch-up está alinhado com \(Y\). Não há (neste holdout) residual terminal **ortogonal** ao path de 2s.
- Consequência operacional: (i) hold-to-settle captura o \(\mu\) *antes* do catch-up; (ii) alternativa matemática equivalente em expectativa é **micro-horizonte** de 2–5s se fills permitirem — mas fees de ida e volta destroem isso; por isso hold-to-settle é a projeção economicamente viável do mesmo \(\mu\).

### 11.2 Achados quantitativos

1. **Lag ótimo:** \(\ell=2\) maximiza corr\((Z,R)\) (0.059 train). corr\((Z,\Delta C_{2s})\approx 0.29\) — canal path 5× mais forte que residual bruto.
2. **Path vs terminal:** holdout corr\((Z,R)=0.045\), corr\((Z,R_\perp)=-0.005\) → **mediação por path**.
3. **Assimetria:** em \(|Z|\ge 1.5\), \(E[R]\approx +5.7\) pp vs \(-5.5\) pp — \(\mu(Z)\) **quase ímpar** (tanh/linear OK; L4 assimétrico não melhora).
4. **Moneyness (achado mais forte além de Z):**
   - \(|m|<0.5\) (ATM): corr\((Z,R)=0.11\), \(E[R|Z\ge 1.5]=+12.5\) pp, \(E[R|Z\le -1.5]=-14.7\) pp
   - \(|m|\ge 3\) (deep): sinal **some/inverte** (corr \(\approx -0.01\))
   - **LADM sem filtro de moneyness dilui o edge.**
5. **Dupla residualização:** \(e=R-\Pi_{m,\tau,C}R\) ainda correlaciona com \(Z\) (holdout 0.045, \(t_{\mathrm{train}}\approx 12\)) → Z não é só proxy linear de estado.
6. **Logit:** L1 vs L0 LR=140 (Z entra); L2 vs L1 LR=17 (m e Z×m); L3 leve ganho com \(\Gamma,\tau\). Δlogloss holdout máximo \(\approx 0.002\) — **informação real mas pequena em score global**; concentrada nas caudas de Z e no ATM.
7. **Forma canônica atualizada:**

\[
\mu_t = \beta_Z Z_t^{(2)}\cdot \mathbf{1}_{\{|m_t| < m^\star\}} + \beta_\Gamma \Gamma_t + \cdots,\quad m^\star \sim 1.5\text{–}2
\]

ou interação \(Z\cdot \phi(m)\) com \(\phi\) decaindo em \(|m|\).

## 12. Forma canônica recomendada (teoria + prática)

\[
p_t^{\mathcal{G}} = \sigma\Big( \alpha + \beta_C \mathrm{logit}(C_t) + \beta_Z Z_t^{(2)} + \beta_m m_t + \beta_{Zm} Z_t^{(2)} m_t + \beta_\Gamma \Gamma_t \Big)
\]
ou, em residual linear (mais simples para sizing):
\[
\mu_t = \beta_Z Z_t^{(2)} + \beta_{Zm} Z_t^{(2)} m_t + \beta_\Gamma \Gamma_t, \quad p_t = \mathrm{clip}(C_t + \mu_t).
\]
Edge executável no lado alinhado: (\mathrm{edge} = \mathrm{sign}(Z)\cdot \mu) quando se compra o lado do impulso a ask (C^{\mathrm{side}}).
