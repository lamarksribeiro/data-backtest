# MIDAS Multi-Pulse V1 — High-Frequency Multi-Entry Terminal Carry

**Status:** candidata em validação no Lab · **Lab:** `labs/strategies/terminal/midas-multi-pulse-v1/` · **Studio slug:** `midas-multi-pulse-v1` · **Data:** 2026-07-23

## Tese e Motivação

A **MIDAS Carry V1** provou ser uma das estratégias mais consistentes do `data-backtest`, obtendo PnL de ~US$ 5.099 (PF 1.53, Win Rate ~92%) no treino de 58 dias. No entanto, sua restrição a 1 única entrada por evento de 5 minutos subutiliza momentos em que o mercado oferece múltiplas oportunidades de acumulação de posição ou repetições de sinal favorável.

A **MIDAS Multi-Pulse V1** expande essa arquitetura para permitir **múltiplas entradas (pulsos) por evento** com compensação dinâmica de taxas da Polymarket:

1. **Múltiplos Pulsos por Evento (`maxEntriesPerEvent = 3..4`):** Permite até $N$ entradas por evento de 5m, com intervalo temporal mínimo (`minEntryIntervalSecs`) para evitar over-trading em micro-ticks de alta volatilidade.
2. **Três Janelas Temporais de Pulso ($\tau \in [4s, 90s]$):**
   - **Early Pulse Window (90s–30s):** Entrada antecipada baseada em desequilíbrio do livro (OBI $\ge 0,10$) e colchão físico de volatilidade ($z \ge 0,8$).
   - **Core Terminal Carry Pulse (30s–4s):** Entrada clássica MIDAS em favorito caro ($ask \in [0.55, 0.94]$).
   - **Scoop Pulse (30s–5s):** Entrada em favorito barato com z alto.
3. **Compensação de Taxas Polymarket:** A fee taker $0.07 \cdot p \cdot (1-p)$ atinge mínima em $p \ge 0,85$ (~0.5% a 0.7%), permitindo acumular múltiplos pulsos com margem de segurança e custo operacional reduzido por dólar alocado.
4. **Teto de Risco Acumulado por Evento (`maxEventBudget = US$ 35`):** Impede exposição excessiva em um único evento, mesmo com múltiplos pulsos.

---

## Parâmetros Principais

| Parâmetro | MIDAS Carry V1 | MIDAS Multi-Pulse V1 Champion |
|---|---|---|
| `maxEntriesPerEvent` | 1 | **3** |
| `minEntryIntervalSecs` | — | **3s** |
| `maxEventBudget` | US$ 15 | **US$ 35** |
| `earlyPulseEnabled` | false | **true** ($\tau \in [30s, 90s]$) |
| `earlyMinZ` | — | **0.8** |
| `earlyMinObi` | — | **0.10** |
| `maxAsk` | 0.94 | **0.94** |
| `tierAskThreshold` | 0.82 | **0.82** |
| `tierAskBudgetFactor` | 1.5 | **1.5** |
| `lateFlipReverseEnabled` | true | **true** |

---

## Arquitetura de Execução

- **Linguagem:** GLS v1 + Strategy JS v1 (suporte a `compiled-soa`).
- **Engine:** `soa` (DuckDB / Parquet lakehouse).
- **Paridade:** Validação em profundidade do livro de ordens (Book depth 25).

---

## Modos de Execução & Testes

```powershell
# Sincronizar banco de dados SQLite e manifestos
node scripts/seed-presets.js

# Executar experimento de treino (58 dias: 2026-05-04 a 2026-07-01)
node labs/cli/run.js --experiment labs/strategies/terminal/midas-multi-pulse-v1/experiments/train-multi-pulse.json

# Executar validação em holdout de Julho
node labs/cli/run.js --experiment labs/strategies/terminal/midas-multi-pulse-v1/experiments/holdout-multi-pulse.json
```
