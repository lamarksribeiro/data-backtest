# OJD-V0 Phase I — Anomaly Report

- Range: **2026-05-04 → 2026-05-25**
- Days processed: **22**
- Snapshots: **24996** (eval taus 120, 90, 60, 45, 30s, window 45s)

## Global calibration (lower Brier / log-loss is better)

| Model | Brier | LogLoss |
|---|---:|---:|
| Market ask UP | 0.13063 | 0.40711 |
| Gaussian total RV | 0.15589 | 0.63710 |
| Gaussian continuous BV | 0.16277 | 0.74263 |
| Hyperion-like bump | 0.16302 | 0.77544 |
| OJD v0 provisional | 0.16303 | 0.73822 |

## By jump-share η (core of P1)

| η bin | n | up_rate | mean η | resid_mkt | resid_cont | brier_mkt | brier_cont | brier_ojd | corr(η,resid_cont) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| [0,0.1) | 2104 | 0.453 | 0.033 | 0.0049 | 0.0130 | 0.1313 | 0.1588 | 0.1588 | -0.040 |
| [0.1,0.25) | 3860 | 0.452 | 0.184 | -0.0054 | 0.0058 | 0.1231 | 0.1456 | 0.1458 | 0.008 |
| [0.25,0.45) | 7072 | 0.465 | 0.350 | -0.0040 | 0.0028 | 0.1307 | 0.1617 | 0.1619 | 0.023 |
| [0.45,0.65) | 6447 | 0.483 | 0.545 | -0.0006 | 0.0062 | 0.1300 | 0.1608 | 0.1609 | 0.001 |
| [0.65,1] | 5513 | 0.489 | 0.781 | 0.0042 | 0.0142 | 0.1363 | 0.1799 | 0.1807 | 0.001 |

## Gates

- **P1 (η residual):** FAIL — no strong monotonic residual pattern across eta
- **P3 (calibragem):** FAIL — ΔBrier OJD-tot=0.00714
- **Hour control (anti-SAD):** corr(η, residual_cont) after hour pooling = see by_hour tables in JSON

## Decision

KILL CANDIDATE (this formulation): no stable η→residual link. Pivot mechanism or archive.

See charter: `docs/research/ojd-v0-research-charter.md`