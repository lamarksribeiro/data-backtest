# OJD-V0 Phase I — Anomaly Report

- Range: **2026-05-04 → 2026-05-25**
- Days processed: **22**
- Snapshots: **25149** (eval taus 120, 90, 60, 45, 30s, window 45s)

## Global calibration (lower Brier / log-loss is better)

| Model | Brier | LogLoss |
|---|---:|---:|
| Market ask UP | 0.13093 | 0.40780 |
| Gaussian total RV | 0.15615 | 0.63911 |
| Gaussian continuous BV | 0.18097 | 1.02767 |
| Hyperion-like bump | 0.16918 | 0.85613 |
| OJD v0 provisional | 0.18099 | 1.01577 |

## By jump-share η (core of P1)

| η bin | n | up_rate | mean η | resid_mkt | resid_cont | brier_mkt | brier_cont | brier_ojd | corr(η,resid_cont) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| [0,0.1) | 82 | 0.463 | 0.012 | -0.0339 | 0.0028 | 0.1588 | 0.1878 | 0.1878 | 0.103 |
| [0.1,0.25) | 72 | 0.458 | 0.190 | 0.0047 | 0.0343 | 0.1027 | 0.0832 | 0.0832 | 0.126 |
| [0.25,0.45) | 351 | 0.479 | 0.378 | 0.0124 | 0.0378 | 0.1382 | 0.1645 | 0.1644 | -0.140 |
| [0.45,0.65) | 1737 | 0.461 | 0.571 | 0.0050 | 0.0170 | 0.1264 | 0.1646 | 0.1649 | 0.004 |
| [0.65,1] | 22907 | 0.474 | 0.899 | -0.0011 | 0.0072 | 0.1311 | 0.1827 | 0.1827 | 0.009 |

## Gates

- **P1 (η residual):** FAIL — no strong monotonic residual pattern across eta
- **P3 (calibragem):** FAIL — ΔBrier OJD-tot=0.02484
- **Hour control (anti-SAD):** corr(η, residual_cont) after hour pooling = see by_hour tables in JSON

## Decision

KILL CANDIDATE (this formulation): no stable η→residual link. Pivot mechanism or archive.

See charter: `docs/research/ojd-v0-research-charter.md`