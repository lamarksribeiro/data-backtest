# OJD-V0 — Oriented Jump Decomposition for Fixed-Horizon Digitals

## Status

**FASE I — ENCERRADA (formulação η e pós-jump residual vs book)**  
**Resultado: KILL dessas formulações** — ver §10.  
Próximo: Pivot C (consistência hazard spot ↔ caminho das odds), não reabrir η sem medição nova.

Programa de descoberta de teoria matemática nova para BTC Up/Down 5m (Polymarket).  
Não é estratégia de produção. Não prometer lucro até sobreviver a holdout líquido.

---

## 0. Contrato de honestidade

1. **“Nunca usada no mercado”** no sentido absoluto é irrealista (quase tudo tem eco em finanças matemáticas).
2. O alvo realista e defensável é:
   - **nova como objeto operacional neste venue** (binário de 5m com PTB + book Polymarket), e
   - **não redutível** às teorias já implementadas/rejeitadas neste repo, e
   - **com formalismo próprio** (processo + predições + testes), não grid search com nome bonito.
3. Vantagem econômica só é discutida **depois** de:
   - anomalia empírica estável,
   - modelo melhor calibrado que baselines,
   - edge líquido após `src/backtest/fees.js` (crypto 0.07), book histórico e slippage.

---

## 1. Por que este eixo (vol estocástica + saltos)

### O que o mercado / bots já “sabem”

Quase toda precificação implícita de curto prazo colapsa em algo do tipo:

\[
p_{\text{mkt}} \approx \Phi\!\left(\frac{X_t}{\sigma_{\text{total}}\sqrt{\tau}}\right)
\]

onde \(X_t = \mathrm{side}\cdot(S_t - K)\), \(K=\) PTB, \(\tau=\) tempo restante.

Isso trata **toda** a variação como se fosse difusão contínua. Modelos locais do lab (Terminal Convexity, VCL, Hyperion com bump de Merton) usam variantes dessa família.

### O que a matemática de saltos implica e o book ignora

A variação quadrática decompõe-se:

\[
[S]_t = [S]^c_t + \sum_{s\le t}(\Delta S_s)^2
\]

Para um digital de horizonte fixo, a probabilidade terminal **não** é função só de \(\sigma_{\text{total}}\sqrt{\tau}\). Saltos transportam massa através da barreira \(K\) de forma não-gaussiana:

- mesma \(\sigma_{\text{total}}\) com **muita massa em jumps** ⇒ caudas e \(P(S_T>K)\) diferentes da Gaussian;
- jump **a favor / contra** a barreira altera o hazard residual de forma assimétrica;
- após um jump, a lei condicional regenera (não é só “ inflar \(\sigma\) ”).

### Hipótese central (candidata a teoria)

> **O resíduo de calibragem do book (e dos modelos \(\Phi(X/\sigma\sqrt{\tau})\)) é sistematicamente explicável pela fração de variação devida a saltos e pela orientação desses saltos em relação ao PTB — não pela vol total nem pela vol por hora do dia.**

Nome de trabalho: **OJD — Oriented Jump Decomposition**.

Isso é deliberadamente distinto de:

| Teoria / fato | Por que OJD não é a mesma coisa |
|---|---|
| Sigma Adaptive Drift (rejeitada) | SAD = vol por hora; mercado já precifica. OJD = composição jump vs contínuo |
| VCL | compressão de vol rápida total |
| Terminal Convexity | convexidade temporal com \(\sigma\) total + drift |
| Hyperion Merton bump | ajuste ad-hoc \(\pm 0.05\cdot\lambda\), sem decomposição realizada nem orientação a \(K\) |
| Hawkes como feature | OJD pode *usar* autoexcitação depois; a tese é o **resíduo de barreira**, não o contágio em si |

---

## 2. Formalismo mínimo alvo (v0 → v1)

### 2.1 Observáveis

Sobre janela rolante \(W\) (ex.: 30–60s) e ticks de underlying:

\[
\begin{aligned}
RV_W &= \sum r_i^2 \\
BV_W &= \frac{\pi}{2}\sum |r_i|\,|r_{i-1}| \quad \text{(bipower; proxy contínuo)} \\
JV_W &= \max(RV_W - BV_W,\ 0) \\
\eta_W &= \frac{JV_W}{RV_W+\varepsilon} \quad \text{(jump share)}
\end{aligned}
\]

Detecção pontual de saltos (Lee–Mykland ou threshold em \(r_i / \hat\sigma\)):

\[
J_t \in \{0,1\},\quad Z_t = \mathrm{sign}(\Delta S_t)\cdot\mathbf{1}_{J_t=1}
\]

Orientação à barreira:

\[
\begin{aligned}
X_t &= S_t - K \\
\zeta_t &= \mathrm{sign}(X_t) \\
\text{jump-with-lead} &= Z_t \cdot \zeta_{t-} \\
\text{jump-against-lead} &= -Z_t \cdot \zeta_{t-}
\end{aligned}
\]

### 2.2 Modelo de probabilidade candidato (ainda a validar)

Baseline gaussiano contínuo (o que o mercado “imita”):

\[
p_{\text{cont}} = \Phi\!\left(\frac{X_t}{\sigma_c\sqrt{\tau}}\right),\quad
\sigma_c^2 \propto BV_W / W
\]

Correção orientada a saltos (forma funcional a descobrir empiricamente na Fase I–II; placeholder):

\[
p_{\text{OJD}} = \mathrm{clip}\Big(
  p_{\text{cont}} + \underbrace{\Psi(\eta_W,\, \lambda^{\rightarrow},\, \lambda^{\leftarrow},\, |X_t|,\, \tau)}_{\text{resíduo de salto}}
;\ 0,1\Big)
\]

onde \(\lambda^{\rightarrow},\lambda^{\leftarrow}\) são intensidades recentes de jumps a favor / contra o lado líder.

**Teorema-alvo (v1, se a anomalia viver):**

1. Existência de um processo semi-martingale \(S\) com parte contínua + jumps finitos de atividade tal que \(p_{\text{OJD}}\) é a projeção (ou uma aproximação controlada) de \(\mathbb{P}(S_T>K\mid\mathcal{F}_t)\).
2. Em regime \(\eta_W\to 0\), \(p_{\text{OJD}}\to p_{\text{cont}}\) (redução ao modelo clássico).
3. Predição empírica: residual

\[
R_t = \mathbf{1}_{S_T>K} - p_{\text{mkt},t}
\]

correlaciona com \(\Psi\) **fora da amostra**, após controlar \(X_t,\tau,\sigma_{\text{total}}\).

---

## 3. Predições falsificáveis (obrigatórias)

Antes de qualquer lab de PnL, a teoria deve acertar:

| ID | Predição | Teste |
|---|---|---|
| P1 | Condicional a \(X,\tau,\sigma_{\text{total}}\) fixos, \(\eta\) alto muda a taxa real de “UP wins” de forma monotônica | bins / regressão parcial |
| P2 | Jumps *against-lead* elevam P(flip) residual vs baseline gaussiano | hazard pós-jump |
| P3 | \(p_{\text{cont}}\) sozinho está **mal calibrado** em buckets de alto \(\eta\); \(p_{\text{OJD}}\) melhora Brier/log-loss | reliability diagrams |
| P4 | O book \(ask_{UP}\) rastreia melhor \(p_{\text{cont}}\) que \(p_{\text{OJD}}\) em alto \(\eta\) (lag estrutural) | corr(\(ask\), \(p\)) por regime |
| P5 | Efeito **não** é só “hora do dia” (contra-SAD) | residual após dummies horárias |

Se P1–P3 falharem no holdout exploratório → **teoria morta**, arquivar em `docs/rejeitadas/`.

---

## 4. Fases e gates

### Fase I — Anomalia (atual)

- Decompor RV/BV/JV em ticks de BTC por evento 5m.
- Medir residual do book e de \(p_{\text{cont}}\) vs outcome.
- Procurar dependência residual em \(\eta\) e jumps orientados.
- **Gate:** pelo menos 1 padrão estável train→valid (efeito > ruído, não só in-sample).

### Fase II — Stylized facts

- 5–7 leis empíricas com IC / bootstrap.
- Separar regimes: perto da barreira vs longe; early vs late \(\tau\).
- **Gate:** leis reproduzem em janela temporal cega.

### Fase III — Formalismo

- Fechar \(\Psi\) ou substituir por mistura de saltos explícita (tipo Kou/Merton **estimado**, não bump ad-hoc).
- Provar/derivar limites de redução e, se possível, fórmula semi-fechada para digital.
- **Gate:** melhor calibragem que baselines (contínuo, cont+σ total, Hyperion-like).

### Fase IV — Vantagem econômica

- Só então lab de estratégia com fees, book depth, hold-to-settlement preferencial.
- Baselines de PnL: null, TC-like, VCL-like, Hyperion-like, OJD.
- **Gate (disciplina do repo):** holdout líquido com PF e estabilidade dignos de promoção; senão arquivar como “teoria estatística sem edge executável”.

### Fase V — Escrita

- Doc final em `docs/estrategias/` ou `docs/rejeitadas/`.
- Matemática + evidência + limitações.

---

## 5. Baselines obrigatórios (não negociáveis)

1. **Null:** base rate incondicional / por \(\tau\).
2. **Gaussian total:** \(\Phi(X/\sigma_{RV}\sqrt{\tau})\).
3. **Gaussian contínuo:** \(\Phi(X/\sigma_{BV}\sqrt{\tau})\).
4. **Hyperion-like:** Gaussian + bump de intensidade.
5. **Book:** mid/ask como probabilidade implícita.

Métrica primária de *teoria*: **log-loss / Brier** e reliability — **não** PnL.  
PnL só na Fase IV.

---

## 6. Proibições (anti-autoengano)

- Não tunar Terminal Convexity / Edge Sniper / VCL / Midas / Hyperion e chamar de OJD.
- Não usar “vol por hora” como tese (já morto no SAD).
- Não declarar vitória com PnL bruto ou fills ideais.
- Não aceitar edge < fee drag típico em asks ~0.5.
- Não confundir latência spot→book (microestrutura pura) com teoria de saltos **sem** decomposição.

---

## 7. Artefatos do programa

| Artefato | Caminho |
|---|---|
| Charter (este doc) | `docs/research/ojd-v0-research-charter.md` |
| Exploração Fase I | `labs/sandbox/ojd/` |
| Relatórios de anomalia | `labs/sandbox/ojd/reports/` |
| Teoria formal (se sobreviver) | `docs/estrategias/nao-implementadas/ojd-v1.md` |
| Lab de trading (se Fase IV) | `labs/strategies/volatility/ojd-v1/` |

---

## 8. Critério de sucesso científico vs comercial

| Nível | Critério |
|---|---|
| **Teoria válida (científica)** | P1–P3 holdout + formalismo coerente + melhora de calibragem vs baselines |
| **Teoria útil (comercial)** | + edge líquido estável após fees/slippage, não dominado por estratégias já existentes |
| **Teoria morta** | falha em P1–P3, ou só melhora in-sample, ou edge some com fees |

---

## 9. Comandos

```bash
# Formulação η (jump share) — 1s bars
node --max-old-space-size=8192 labs/sandbox/ojd/phase1-anomaly.mjs --from 2026-05-04 --to 2026-05-25

# Pivot B — residual pós-jump orientado
node --max-old-space-size=8192 labs/sandbox/ojd/phase1b-pivot-postjump.mjs --from 2026-05-04 --to 2026-05-25
```

Relatórios: `labs/sandbox/ojd/reports/`.

---

## 10. Resultados Fase I (2026-05-04 → 2026-05-25, BTC 5m)

### 10.1 Formulação η (jump-share) — KILL

| Achado | Implicação |
|---|---|
| Em ticks brutos, ~91% dos pontos com \(\eta\ge 0.65\) | Microestrutura contamina BV; **não** usar ticks crus |
| Em barras 1s, \(\eta\) bem distribuído | Medição ok |
| \(\mathrm{corr}(\eta,\ residual_{cont})\approx 0.006\) | Sem link residual |
| Residuais do book por bin de \(\eta\) ≈ 0 | Mercado **já calibra** regimes de jump-share |
| Brier mercado **0.131** vs melhor modelo físico **0.156** | Modelos \(\Phi(X/\sigma\sqrt{\tau})\) perdem feio para o ask |

**Decisão:** a hipótese “fração de jumps explica mispricing do digital” **não sobrevive** neste venue/intervalo.

### 10.2 Pivot B (pós-jump orientado) — KILL

| Regime | n | residual médio do ask UP |
|---|---:|---:|
| large with lead | 8826 | +0.4 pp |
| large against lead | 7154 | −1.0 pp |
| valid: with vs against | — | gap ~1.4 pp, instável / fino demais p/ fees |

Mercado acompanha jumps grandes (ex.: \(z\le -6\): up_rate 0.405 vs ask 0.407).  
**Decisão:** residual pós-jump **não** é anomalia explorável isolada.

### 10.3 Lição metodológica (ouro)

1. O book da Polymarket é **fortemente calibrado** em relação a vol/jumps de curto prazo do spot.  
2. “Melhor física de vol/jumps que o mercado” é o caminho **errado** como tese principal — alinhado ao SAD rejeitado (vol horária já precificada).  
3. Edge histórico no repo veio de **janelas/estrutura de execução** (convexidade terminal, lags de book, ladders), não de superar \(p_{mkt}\) com Heston/Merton.

---

## 11. Pivot C — Odds-Path Barrier Consistency — **KILL** (formulação testada)

Script: `labs/sandbox/ojd/phase1c-odds-path.mjs` (`--multi`).

| Asset | Range | n | Brier mkt | Brier path | C1 valid | Decisão |
|---|---|---:|---:|---:|---|---|
| BTC | 05-04→07-15 (73d) | 72 986 | **0.1418** | 0.1430 | FAIL | KILL |
| ETH | 05-24→07-15 (53d) | 49 954 | **0.1372** | 0.1388 | FAIL | KILL |
| SOL | 05-24→07-15 (53d) | 50 697 | **0.1331** | 0.1343 | FAIL | KILL |

### Achados

- Elasticidade média \(\Delta C / \Delta C_{\text{modelo}} \approx 0.77\text{–}0.90\) (book **não** está “morto”; reage).
- Regime `inelastic` **não** deixa residual estável vs `matched` (gap < 2 pp e mesmo sinal).
- Correção de caminho **piora** Brier vs ask em todos os ativos.
- `corr(edgePhys, resid_m) ≈ 0.05–0.06` (fraco): física aponta residual na direção certa às vezes, mas **calibração absoluta perde feio** para o book.
- Pocket `inel+mid+τ45–90` BTC valid: resid_m ≈ −2 pp, mas sinal path **não** melhora (resid_when_signal também negativo).

### Implicação

A família “**modelo físico de barreira/vol/jumps/path > book**” está **empírica e cross-assetmente esgotada** para este venue (nível e caminho de 8s).  
Próximas teorias devem mudar de objeto (ver §14).

---

## 12. Postura comercial (sem autoengano)

- **Ainda não temos teoria válida nova com vantagem.**  
- Temos um **programa vivo**, com duas mortes honestas e um pivot melhor informado.  
- Inventar equação bonita sem anomalia = teatro. O processo está funcionando exatamente porque matou candidatos.

---

## 13. Mapa do lake (complementar — não substitui)

Inventário formal do espaço amostral:

- Doc: `docs/research/lake-data-map.md`
- JSON: `labs/sandbox/ojd/reports/lake-inventory.json`
- Regenerar: `node labs/sandbox/ojd/map-lake-inventory.mjs`
- Screening barato no cubo: `node labs/sandbox/ojd/cube-residual-screen.mjs`
- Pivot C multi: `labs/sandbox/ojd/reports/phase1c-odds-path-multi-summary.json`

**Uso:** gerar hipóteses data-driven (cross-asset, L2, lead externo) **fora** da família física-vs-book já morta.

---

## 14. Pivot D — Binance Lead Residual — **PROCEED Phase II**

Script: `labs/sandbox/ojd/phase1d-binance-lead.mjs`  
Dados: Binance Vision 1s (`data/binance-1s/`) ⨝ lake `backtest_ticks` BTC depth25.

### Resultado expandido (2026-05-04 → 2026-06-05, 33 dias, n=25 025)

| Impulse (Binance 2s / σ) | n | resid_m = upWins − ask | Brier mkt | Brier lead-nudge |
|---|---:|---:|---:|---:|
| strong_up | 920 | **+0.066** | 0.139 | 0.136 |
| strong_down | 931 | **−0.069** | 0.139 | 0.135 |
| flat | 19 134 | −0.003 | 0.137 | 0.137 |

**Valid (30% final temporal):** strong_up resid **+0.060**, strong_down **−0.048** → gap **~11 pp** (gate PASS).

| Métrica | Valor |
|---|---|
| corr(impulse, resid_m) | ~0.058 |
| corr(impulse, Δask próximos 2s) | **~0.27** |
| Stale book (impulso forte + odds quase paradas): gap up−dn | **~0.13** (valid ~0.12) |
| Brier global lead vs mkt | empate (~0.138) — edge é **condicional**, não global |

### Hipótese formal (candidata a teoria)

> Sob filtração \(\mathcal{F}_t^{\text{Poly}}\) o ask \(C_t\) é bem calibrado; sob filtração ampliada \(\mathcal{F}_t^{\text{Poly}}\vee\sigma(S^{\text{Bin}}_{u}:u\le t)\) existe residual sistemático
>
> \[
> R_t = \mathbf{1}_{\{S_T\ge K\}} - C_t
> \]
>
> monotônico no impulso recente normalizado \(Z_t = (S^{\text{Bin}}_t - S^{\text{Bin}}_{t-\ell}) / \hat\sigma_t\), com \(\ell\sim 1\text{–}2\text{s}\).

**Objeto novo (vs TC / ES / OJD):** não é vol do oráculo do lake; é **assimetría de informação temporal** (lead de venue). O lake sozinho **não** vê isso (`underlying_price` ≈ oráculo acoplado ao book).

### O que os dados proibiram (contexto)

| Família | Status |
|---|---|
| Vol por hora (SAD) | morta |
| Jump-share η / bipower | morta |
| Residual pós-jump (oracle) | morta |
| Elasticidade odds↔oracle 8s | morta (BTC/ETH/SOL) |
| **Binance impulse residual** | **viva — Phase II** |

### Phase II executada (2026-05-04 → 06-05)

Script: `labs/sandbox/ojd/phase2-ladm.mjs`  
Reports: `labs/sandbox/ojd/reports/phase2-ladm-2026-05-04_2026-06-05.*`  
Doc: `docs/estrategias/nao-implementadas/ladm-v0.md`

| Item | Resultado |
|---|---|
| Ψ train | \(a\approx 0.081\), \(s=2.5\), \(\Psi=a\tanh(Z/s)\) |
| Brier holdout \|Z\|≥1.5 | LADM **0.1514** vs mkt **0.1561** |
| Lab holdout LADM | n=368, WR=42.4%, **net +$796**, fees $169, **PF 1.36**, maxDD $169 (stake $10) |
| vs impulse-only | **idêntico** nesta policy (Ψ não filtra além de \|Z\|≥1.5) |
| vs hyperion-like | LADM net >> (holdout hyp net +$67, PF 1.14) |
| vs fav-late | LADM net >> (fav ~+$12, PF ~1.02) |
| Verdict | **GO-CANDIDATE** (não capital live) |

### Gate de honestidade (Phase II+)

1. ~~Formalizar \(p_{\text{lead}}\)~~ feito  
2. ~~Brier condicional~~ feito (melhora leve)  
3. ~~Lab fees~~ feito (positivo)  
4. **Próximo:** política onde LADM **≠** impulse-only (minEdge > Ψ(zMin), ou size ∝ \|Ψ\|); range junho–julho; latência live.
