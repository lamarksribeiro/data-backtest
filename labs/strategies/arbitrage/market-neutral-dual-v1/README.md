# Estratégia Market-Neutral Dual-Side V1 (ATFR-V1 & DLSL-V1)

Estratégia quantitativa **Market-Neutral / Delta-Neutral** para o mercado de 5 minutos de BTC (UP/DOWN) na Polymarket.

---

## 🚀 Como Executar

### 1. Backtest Completo no Dataset Local (5,26M ticks / 8,806 eventos):
```bash
npm run lab:market-neutral
```

### 2. Backtest na Janela de Estresse das Últimas 72 Horas:
```bash
npm run lab:market-neutral:72h
```

### 3. Backtest na Janela das Últimas 24 Horas:
```bash
npm run lab:market-neutral:24h
```

---

## 📈 Resultados da Variante Campeã (DLSL-V1)

- **PnL Líquido (após fees e slippage):** `+$40.405,40`
- **Win Rate:** `74,1%`
- **Profit Factor:** `3,28`
- **Max Drawdown:** `$2.753,84`
- **Frequência de Lucro Garantido (Profit Lock Dual):** `81,8%`
- **Worst-Case Médio por Trade:** `+$4,45`
