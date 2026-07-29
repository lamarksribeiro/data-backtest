# Clip-Path V1

**Status:** promovida ao Studio (`promotedToStudio: true`) · library-runner · **research / HOLD / PARITY GAP**  
**ID / Studio slug:** `clip-path-v1`  
**Família:** `carry`  
**Lab path:** `labs/strategies/carry/clip-path-v1/`  
**Runner:** `pair-path-runner@1` (mesma lib do Pair-Path V0)  
**Sandbox:** `labs/sandbox/pair-path-v0/` · contrato `MACHINE-CLIP-V1.md`  
**Preset default:** `presets/clip-path-v1.json` (deep3 + escape 2-stage)  
**Data:** 2026-07-29

> HOLD: path real (4 pares CLOB) validado; preset contínuo amplo rejeitado no lake depth-25. Sem nova operação live sem fechar paridade.

## Tese

Pair-Path V0 + hedge em níveis DESC (`hedgeLevels`) + escape tardio. Produto Phil útil era o **clip** 1–2 viradas com avgSum &lt; 1 — não a escada MULT.

## Defaults Studio

deep3: 40%@≤40 + 30%@≤36 + 30%@≤32, `avgSumMax` 0,94, escape τ≤20 / τ≤12, fill honesto.

## Ver também

- [Pair-Path V0](pair-path-v0.md)
- `labs/sandbox/pair-path-v0/BRIEFING-CLIP-PATH-2026-07-28.md`
