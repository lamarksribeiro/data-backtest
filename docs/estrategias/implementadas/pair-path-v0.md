# Pair-Path V0

**Status:** promovida ao Studio (`promotedToStudio: true`) · library-runner · **research / HOLD**  
**ID / Studio slug:** `pair-path-v0`  
**Família:** `carry`  
**Lab path:** `labs/strategies/carry/pair-path-v0/`  
**Runner:** `labs/legacy/strategy-runners/portable/pair-path-runner.js` · library `pair-path-runner@1`  
**Sandbox:** `labs/sandbox/pair-path-v0/` · contrato `MACHINE-V0.md`  
**Data:** 2026-07-29

> Research: 4 complete-sets reais lucrativos validam o path; a política de automação ampla ainda tem **parity gap**. Não é GO live. Auditoria: `labs/sandbox/pair-path-v0/AUDIT-PAIR-PATH-2026-07-29.md`.

## Tese

Complete-set barato: open no favorito (ask ∈ [0,52–0,62]) + um hedge no oposto se `proj avgSum ≤ avgSumMax`. PnL estrutural ≈ `sh × (1 − avgSum) − fees` quando equalizado.

## Defaults Studio

Preset `size-fee-v0` + `openCapCents: 2`, fill honesto (`restingFillModel: none`, `confirmationTicks: 2`).

## Ver também

- [Clip-Path V1](clip-path-v1.md) — mesma runner com `hedgeLevels`
- `docs/labs/pair-path-v0-sessao-019fa6ab.md`
