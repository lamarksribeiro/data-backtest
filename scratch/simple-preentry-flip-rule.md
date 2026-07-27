# Regra simples de alerta pré-entrada

Selecionada antes de ler o teste:

```text
tau = 30 s
favMid caiu >= 0.05 em 15 s
z físico <= 0.50
favAsk <= 0.68
=> não entrar
```

| janela | bloqueadas | flip base → sinal | ΔPnL | PnL base → novo | DD base → novo | IC95% Δ |
|---|---:|---:|---:|---:|---:|---:|
| development | 125 (2.8%) | 20.4% → 46.4% | +186.52 | -647.26 → -460.74 | 705.96 → 516.19 | [+27.00; +354.95] |
| test | 60 (2.1%) | 18.7% → 45.0% | +64.65 | +51.38 → +116.03 | 214.29 → 194.28 | [-59.06; +193.93] |
| all | 185 (2.5%) | 19.7% → 45.9% | +251.16 | -595.88 → -344.71 | 757.44 → 532.91 | [+45.93; +461.47] |

No teste posterior, o sinal mediano ocorreu com ask 0.58, z 0.30 e queda de mid 0.15.

O `z` é a confirmação física: distância do PTB normalizada pela volatilidade e pelo tempo restante. Retirá-lo aumenta cobertura, mas reduz a concentração de flips.
