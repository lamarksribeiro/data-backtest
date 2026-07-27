# Desk Recovery V1

Lab GLS — port do desk live `data-robot/scripts/desk/live-session.js` (modo **RECOVERY**).

## Tese

| Modo | Quando | Ideia |
|------|--------|--------|
| **misprice** | τ 45–240s, \|Δ\|≥$40, ask≤55¢ | Favorito ainda barato vs cushion |
| **lock** | últimos 25s, \|Δ\|≥$40, ask 85–96¢ | Trava lado vencedor |
| **snipe** | últimos 25s, \|Δ\|≥$40, ask≤25¢ | Alto R:R se book hesita |

Exits ativos (variante `recovery-live`): take-profit +10¢, cushion erodiu, velocidade adversa, ask contrário, corte pré-settle.

## Variantes smoke

| id | O que testa |
|----|-------------|
| `recovery-live` | Igual ao desk live (misprice+lock+snipe+exits) |
| `recovery-hold` | Mesmas entradas, hold até settlement |
| `soft-misprice` | Cushion $25 / ask 62¢ (versão mais frouxa) |
| `lock-only` | Só LOCK terminal |
| `snipe-only` | Só SNIPE barato |

## Rodar

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
npm run lab:run -- --experiment labs/strategies/terminal/desk-recovery-v1/experiments/smoke.json --variant-workers 4
npm run lab:run -- --experiment labs/strategies/terminal/desk-recovery-v1/experiments/holdout-week.json --variant-workers 4
```

Relatórios em `reports/labs/desk-recovery-v1/`.

## Status

- **experimental** — criado 2026-07-27 para validar se a estratégia live é lucrativa no lake.

## Smoke 01–07/06/2026 (BTC 5m)

| Variante | PnL | Entradas | WR | PF | Max DD |
|----------|----:|---------:|---:|---:|-------:|
| **recovery-hold** | **+55.61** | 12 | 58.3% | 6.44 | 2.13 |
| soft-misprice | +5.92 | 27 | 40.7% | 2.32 | 1.59 |
| snipe-only | +3.06 | 4 | 25% | 1.51 | 2.09 |
| recovery-live (exits) | −1.35 | 12 | 25% | 0.81 | 2.57 |
| lock-only | 0 | 0 | — | — | — |

**Leitura:** a tese de misprice (cushion+ask barato) **é lucrativa** se **segurar até o settlement**. Os exits ativos do desk live **destruíram** o edge no smoke (mesmas 12 entradas: +55 hold vs −1.35 com exits).

Relatório: `reports/labs/desk-recovery-v1/2026-07-27T03-25-55-036Z-desk-recovery-smoke/`

## Holdout 01–07/07/2026

| Variante | PnL | Entradas | WR | PF | Max DD |
|----------|----:|---------:|---:|---:|-------:|
| **recovery-hold** | **+6.53** | 6 | 50% | 2.08 | 3.91 |
| recovery-live (exits) | −0.11 | 6 | 33% | 0.92 | 0.84 |
| lock-only | 0 | 0 | — | — | — |

Mesmo padrão: **hold > exits**. Edge existe, mas a gestão ativa do desk live corta winners.

Relatório: `reports/labs/desk-recovery-v1/2026-07-27T03-27-08-859Z-desk-recovery-holdout-week/`


