# Aether Edge Pro V1 — Estratégia Sinérgica Multi-Regime

**Status:** Candidate · **Família:** Portfolio · **Studio Slug:** `aether-edge-v1`

## Visão Geral

A **Aether Edge Pro V1** é uma estratégia de alta performance construída para unificar os melhores edges quantitativos das estratégias aprovadas no ecossistema GoldenLens:

1. **BCED V1 (Boundary Coherence Entropy Deviation):** Captura desbalanços de entropia ($\mathcal{H}_{book} \ge 0.02$) na janela intermediária ($180\text{s} \ge \tau \ge 60\text{s}$).
2. **ERM V1 (Empirical Residual Manifold):** Residual entre a probabilidade física empírica e as odds cotadas pelo mercado.
3. **SBRI V1 (Strike Boundary Repricing Inelasticity):** Explora a inércia dos cotações imediatamente após o rompimento do PTB ($120\text{s} \ge \tau \ge 30\text{s}$).
4. **MIDAS Carry V1 & TFC V7:** Carrego terminal ($30\text{s} \ge \tau \ge 5\text{s}$) com envelope High-Ask ($0.82 \le ask \le 0.94$) e dimensionamento de capital em tier (1.5x), usufruindo de taxas taker até 3x menores na Polymarket ($fee = 0.07 \cdot p \cdot (1-p)$).
5. **Whipsaw Lock:** Reversão e proteção microestrutural de 1 perna para falsos rompimentos.

## Como Executar

```bash
# Executar preset campeão no período contínuo (Maio a Julho 2026)
npm run lab:run-preset -- --preset btc-champion-v1 --strategy aether-edge-v1 --strategy-family portfolio

# Executar varredura de experimentos
npm run lab:run -- --experiment labs/strategies/portfolio/aether-edge-v1/experiments/2026-07-sweep-aether-edge.json
```
