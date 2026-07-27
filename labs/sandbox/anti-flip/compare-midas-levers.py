# -*- coding: utf-8 -*-
"""Compara as variantes do sweep antiflip-levers da MIDAS gold nas 3 janelas."""
import json, os, glob, sys
import pandas as pd

ROOT = r"D:\Projetos\projeto-goldenlens\data-backtest\reports\labs\midas-carry-v1"
pd.set_option("display.width", 250)

def latest(name):
    c = sorted(glob.glob(os.path.join(ROOT, f"*-{name}")), reverse=True)
    return c[0] if c else None

def load(name):
    d = latest(name)
    if not d:
        return None
    p = os.path.join(d, "results.json")
    if not os.path.exists(p):
        return None
    raw = json.load(open(p, encoding="utf-8"))
    if isinstance(raw, dict):
        rows = raw.get("results") or raw.get("variants") or []
    else:
        rows = raw
    out = []
    for r in rows:
        s = r.get("summary", r)
        daily = r.get("daily", [])
        out.append({
            "variant": r.get("variantId") or r.get("id") or r.get("variant"),
            "PnL": round(s.get("totalPnl", 0), 1),
            "n": s.get("entries", 0),
            "WR": round(s.get("winRate", 0), 1),
            "PF": round(s.get("profitFactor", 0), 3),
            "maxDD": round(s.get("maxDrawdown", 0), 1),
            "piorDia": round(min([d0.get("totalPnl", 0) for d0 in daily] or [0]), 1),
            "diasPos": sum(1 for d0 in daily if d0.get("totalPnl", 0) > 0),
            "dias": len(daily),
        })
    return pd.DataFrame(out)

frames = {}
for w in ["july", "june", "blind"]:
    f = load(f"antiflip-levers-{w}")
    if f is None:
        print(f"[!] janela {w} ainda sem resultado")
        continue
    frames[w] = f
    print(f"\n{'='*70}\n=== {w.upper()} ===")
    print(f.sort_values("PnL", ascending=False).to_string(index=False))

if len(frames) >= 2:
    print(f"\n{'='*70}\n=== CONSOLIDADO (PnL por janela) ===")
    m = None
    for w, f in frames.items():
        s = f[["variant", "PnL", "PF", "maxDD"]].rename(
            columns={"PnL": f"PnL_{w}", "PF": f"PF_{w}", "maxDD": f"DD_{w}"})
        m = s if m is None else m.merge(s, on="variant", how="outer")
    pnl_cols = [c for c in m.columns if c.startswith("PnL_")]
    m["PnL_total"] = m[pnl_cols].sum(axis=1)
    base = m[m["variant"] == "gold-baseline"]
    if len(base):
        b = base.iloc[0]
        for c in pnl_cols + ["PnL_total"]:
            m["d" + c] = (m[c] - b[c]).round(1)
    print(m.sort_values("PnL_total", ascending=False).to_string(index=False))
    print("\n(d* = delta vs gold-baseline)")
