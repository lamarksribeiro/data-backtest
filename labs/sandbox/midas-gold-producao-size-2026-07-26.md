# MIDAS Gold produção — sizing $10/$30 (2026-07-26)

## Decisão

Mesmo pacote **g3-os** do micro campeão, com budget de produção **`$10 / $30`** (não $2/$4).

| Ativo | Estúdio | Preset | Jul PnL | PF | Hold PnL | Pior dia |
|---|---|---|---:|---:|---:|---:|
| BTC | **v11** (default) | `btc-gold-v1` | **2047.7** | **1.57** | 1308.3 | −3.89 |
| ETH | **v12** | `eth-gold-v1` | **944.0** | **1.27** | 594.1 | −31.15 |
| BTC micro | v9 canário | `$2/$4` | 432.9 | 1.65 | — | −0.22 |
| ETH micro | v10 | `$2/$4` | 247.9 | 1.40 | — | — |

Labs: `gold-size-july` · `gold-size-eth-july` (01–25/07, settle 0.995, depth 25).

## Política de ordem (robot) — FAK vs GTC

| Perna | Tipo | Veredito |
|---|---|---|
| Entrada | **FAK** | Correto. GTC resting na entrada preenche tarde contra o gate (adverse selection). |
| Saída protetora / REVERSE EXIT / odds-shock | **GTC** | Correto. FAK na saída falhou no live (`REVERSE_EXIT_INCOMPLETE`); book fino 3–8s. |

Não mudar entrada para GTC sem lab novo de adverse selection.

## Robot

- `midasGoldPreset()` → `$10/$30` + FAK/GTC + g3-os (`btc-gold-v1` / `eth-gold-v1`)
- `canaryMidasGoldPreset()` → permanece micro `$2/$4` (canário P9)

## Seed

```powershell
npm run lab:seed-presets
```

Default Estúdio: **v11**.
