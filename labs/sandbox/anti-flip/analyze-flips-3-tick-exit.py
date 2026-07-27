# -*- coding: utf-8 -*-
import numpy as np, pandas as pd
CSV = r"C:\Users\lamar\AppData\Local\Temp\claude\D--Projetos-projeto-goldenlens-data-backtest\63477af6-927c-451f-b87f-48a7f647f3cb\scratchpad\tick-exit.csv"
HO = "2026-06-25"
pd.set_option("display.width", 240)
d = pd.read_csv(CSV)
d["day"] = d["day"].astype(str)
d["train"] = d["day"] < HO
V = [c[4:] for c in d.columns if c.startswith("pnl_")]

print(f"trades={len(d)} | WR(hold)={d['win'].mean():.3f} | dias={d['day'].nunique()}")
print(f"train={d['train'].sum()} holdout={(~d['train']).sum()}\n")

rows = []
for v in V:
    p = d[f"pnl_{v}"]; t = d[f"t_{v}"]
    tr = d[d["train"]][f"pnl_{v}"]; ho = d[~d["train"]][f"pnl_{v}"]
    daily = d.groupby("day")[f"pnl_{v}"].sum().sort_index()
    eq = daily.cumsum(); dd = (eq.cummax() - eq).max()
    wins = p[p > 0].sum(); loss = -p[p < 0].sum()
    rows.append({
        "variante": v, "nExit": int(t.notna().sum()), "exit%": round(100 * t.notna().mean(), 1),
        "PnL": round(p.sum()), "exp": round(p.mean(), 3),
        "train": round(tr.sum()), "holdout": round(ho.sum()),
        "PF": round(wins / loss, 3) if loss else np.inf,
        "maxDD": round(dd), "piorDia": round(daily.min(), 1),
        "diasPos": int((daily > 0).sum()),
    })
r = pd.DataFrame(rows).sort_values("PnL", ascending=False)
print(r.to_string(index=False))

base = d["pnl_hold"]
print("\n=== DELTA vs HOLD (por variante) ===")
for v in V:
    if v == "hold": continue
    dl = d[f"pnl_{v}"] - base
    gd = d.groupby("day").apply(lambda g, v=v: (g[f"pnl_{v}"] - g["pnl_hold"]).sum(), include_groups=False)
    print(f"  {v:16s} delta=${dl.sum():+7.0f} | train ${dl[d['train']].sum():+6.0f} ho ${dl[~d['train']].sum():+6.0f} | dias+ {int((gd>0).sum()):2d}/-{int((gd<0).sum()):2d} | piorDia ${gd.min():+.1f}")

print("\n=== ANTECEDENCIA DO SINAL (segundos restantes na saida) ===")
for v in ["lead", "lead_bid45", "lead_or_bid35", "bid35", "shock", "zexit40"]:
    t = d[f"t_{v}"].dropna()
    if not len(t): continue
    print(f"  {v:16s} n={len(t):5d} | mediana {t.median():5.1f}s | p25 {t.quantile(.25):.1f}s p75 {t.quantile(.75):.1f}s | >10s: {100*(t>10).mean():.0f}%")

print("\n=== EFICIENCIA DA SAIDA: nas posicoes onde a regra disparou ===")
for v in ["lead", "lead_bid45", "lead_or_bid35", "bid35"]:
    m = d[f"t_{v}"].notna()
    s = d[m]
    print(f"  {v:16s} n={m.sum():5d} | WR se segurasse {s['win'].mean():.3f} | hold ${s['pnl_hold'].sum():7.0f} -> regra ${s[f'pnl_{v}'].sum():7.0f} (recupera ${s[f'pnl_{v}'].sum()-s['pnl_hold'].sum():+.0f})")
    fp = s[s["win"] == 1]  # saiu mas teria ganhado (falso alarme)
    tpv = s[s["win"] == 0]
    print(f"                   falso alarme n={len(fp)} custo ${(fp[f'pnl_{v}']-fp['pnl_hold']).sum():+.0f} | acerto n={len(tpv)} ganho ${(tpv[f'pnl_{v}']-tpv['pnl_hold']).sum():+.0f}")

print("\n=== POR MES (melhores variantes) ===")
d["mes"] = d["day"].str[:7]
best = ["hold", "lead", "lead_bid45", "lead_or_bid35"]
print(d.groupby("mes")[[f"pnl_{v}" for v in best]].sum().round(0).to_string())
