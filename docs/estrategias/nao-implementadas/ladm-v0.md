# LADM v0.1 — Lead-Adjusted Digital Measure

## Status

**GO-CANDIDATE** (2026-08-02T06:25:40.420Z)  
Phase II empirical pack: `labs/sandbox/ojd/reports/phase2-ladm-2026-05-04_2026-06-05.*`

## Hipótese

Seja (C_t) o ask UP na Polymarket e (S^{\mathrm{Bin}}) o spot Binance 1s. O book é bem calibrado sob a filtração do venue (oráculo + odds). Sob filtração ampliada com Binance,

\[
Z_t = \frac{S^{\mathrm{Bin}}_t - S^{\mathrm{Bin}}_{t-\ell}}{\hat\sigma_t \sqrt{\ell}}, \quad \ell=2\mathrm{s}
\]

o residual terminal (R_t = \mathbf{1}_{\{S_T \ge K\}} - C_t) é monotônico em (Z_t).

## Modelo

\[
\Psi(Z) = a \tanh(Z / s), \qquad
p^{\mathrm{lead}}_{\mathrm{UP}} = \mathrm{clip}\big(C_t + \Psi(Z_t)\big)
\]

Parâmetros **somente train** neste pack:

- (a = 0.081024)
- (s = 2.5)
- método: ls_tanh

DOWN: (p^{\mathrm{lead}}_{\mathrm{DOWN}} = \mathrm{clip}(C^{\mathrm{DN}}_t - \Psi(Z_t))).

## Política operacional (selecionada no train)

```json
{
  "zMin": 1.5,
  "minEdge": 0.03,
  "askMax": 0.7,
  "onlyStale": false,
  "tauMax": 120,
  "askMin": 0.08
}
```

- Stake: $10 notional / trade  
- Fees: taker crypto rate 0.07 via `calculatePolymarketTakerFee`  
- Hold to settlement; 1 trade / evento  

## Resultados holdout

| Strategy | n | WR | Net $ | PF | MaxDD |
|---|---:|---:|---:|---:|---:|
| LADM | 368 | 0.424 | 796.14 | 1.36 | 168.59 |
| Impulse only | 368 | 0.424 | 796.14 | 1.36 | 168.59 |
| Hyperion-like | 73 | 0.370 | 66.81 | 1.14 | 117.89 |
| Fav late | 263 | 0.783 | 11.64 | 1.02 | 105.53 |

### Calibração condicional holdout (|Z|≥1.5)

- Brier mkt: 0.15611
- Brier LADM: 0.15138

## Decisão

**GO-CANDIDATE**: Candidate for formal theory doc + fuller range backtest; still not live capital.

### Honestidade: LADM vs impulse-only nesta política

Com a política campeã do train (`zMin=1.5`, `minEdge=0.03`, `askMax=0.7`), o nudge \(\Psi(Z)=a\tanh(Z/s)\) com \(a\approx0.081\), \(s=2.5\) produz \(|\Psi|\gtrsim 0.04\) sempre que \(|Z|\ge 1.5\). Logo **todo** trade de impulso alinhado já passa o `minEdge` — e o lab LADM **coincide trade-a-trade** com impulse-only (mesmo n, WR, net, PF).

| O que a Phase II **prova** | O que **não** prova |
|---|---|
| Residual terminal monotônico em \(Z^{\mathrm{Bin}}\) (estável train/valid/holdout) | Que o polinômio/tanh \(\Psi\) melhora **seleção** de trades vs “seguir impulso” |
| Brier condicional \|Z\|≥1.5: LADM **0.151** vs mkt **0.156** no holdout | Edge de precificação global (Brier all-sample ≈ empate) |
| Hold-to-settle **líquido de fees** positivo (PF≈1.36 holdout, net≈+$796 em stake $10) | Latência live / fill real / lead 1–2s em produção |
| Domina hyperion-like e fav-late no holdout (net) | Superioridade vs impulse-only sob esta policy |

**Implicação:** a teoria econômica viva é a **medida ampliada por lead Binance** (impulso \(Z\)); \(\Psi\) é correção de **calibragem**. Sizing por \(|\Psi|\) ou threshold de edge mais alto que \(|\Psi|_{\min}(zMin)\) é o próximo teste para LADM ≠ impulse-only.



## O que LADM não é

- Não é Heston/Merton/jump-share no oráculo do lake (famílias A–C mortas).
- Não substitui depth L2 / ladders / maker.
- Requer **feed Binance (ou lead real)** em live; o lake sozinho não reproduz o edge.

## Próximos passos se GO

1. Range completo com mais dias Binance + holdout de junho/julho.
2. Port para strategy runner SOA com join Binance.
3. Shadow/dry-run Giovanna com latência real.


---

## Phase II+ (2026-05-04 → 2026-07-15) — diferenciação LADM

Gerado: 2026-08-02T06:44:06.740Z

### Ψ re-fit (train 60%)

- a=0.080956, s=3
- ψ(|Z|=1.5)≈0.0374, ψ(2.0)≈0.0472

### Primary policy (`cand`)

```json
{
  "zMin": 1.25,
  "minEdge": 0.05,
  "askMax": 0.55,
  "askMin": 0.08,
  "tauMax": 120,
  "onlyStale": false,
  "sizeRefPsi": 0.05,
  "sizeMaxMult": 2.5
}
```

sets_differ (holdout): **true**

| Mode | n | WR | Net $ | PF | MaxDD |
|---|---:|---:|---:|---:|---:|
| impulse_only | 772 | 0.320 | 533.0 | 1.10 | 534.6 |
| ladm_edge | 423 | 0.357 | 1013.2 | 1.35 | 227.7 |
| ladm_size | 772 | 0.320 | 822.2 | 1.15 | 470.9 |
| ladm_combo | 423 | 0.357 | 1246.7 | 1.35 | 284.9 |

### Verdict II+

**GO-CANDIDATE** — Differentiated LADM survives holdout — candidate for runner with Binance feed.


