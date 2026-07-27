# -*- coding: utf-8 -*-
"""Analise de flips no fim do evento BTC 5m: calibracao, features preditivas, gate economico."""
import sys, math
import numpy as np
import pandas as pd

CSV = r"C:\Users\lamar\AppData\Local\Temp\claude\D--Projetos-projeto-goldenlens-data-backtest\63477af6-927c-451f-b87f-48a7f647f3cb\scratchpad\flip-features.csv"
HOLDOUT_START = "2026-06-25"

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 50)

df = pd.read_csv(CSV)
df["day"] = df["day"].astype(str)
df = df[np.isfinite(df["z"]) & np.isfinite(df["momTo10"]) & np.isfinite(df["momTo30"])].copy()
df["absDist"] = df["dist"].abs()
df["train"] = df["day"] < HOLDOUT_START

def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))

df["pBrown"] = [min(0.5, 2 * (1 - phi(z))) for z in df["z"]]

print("=== BASE ===")
print("linhas:", len(df), "| eventos:", df["event_start"].nunique(), "| dias:", df["day"].nunique())
print("train:", df["train"].sum(), "| holdout:", (~df["train"]).sum())
print("\n=== TAXA DE FLIP POR TAU ===")
print(df.groupby("tau").agg(n=("flip", "size"), flipRate=("flip", "mean"),
                            pBrownMean=("pBrown", "mean")).round(4))

# ---- Calibracao z ----
print("\n=== CALIBRACAO: flip rate por bucket de z, por tau (todas as linhas) ===")
zb = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 100]
df["zBucket"] = pd.cut(df["z"], zb, right=False)
for tau in [60, 30, 20, 10]:
    sub = df[df["tau"] == tau]
    g = sub.groupby("zBucket", observed=True).agg(n=("flip", "size"), flip=("flip", "mean"), brown=("pBrown", "mean")).round(3)
    print(f"\n-- tau={tau}s --")
    print(g)

# ---- Momentum contra o lider ----
print("\n=== INTERACAO z x momentum (tau=30, z<2) ===")
sub = df[(df["tau"] == 30)].copy()
sub["momToN"] = sub["momTo10"] / (sub["sigma60"] * math.sqrt(10)).clip(lower=1e-9)  # momentum em unidades de vol
mb = [-100, -2, -1, -0.5, 0, 0.5, 1, 2, 100]
sub["mBucket"] = pd.cut(sub["momToN"], mb, right=False)
piv = sub[sub["z"] < 2].pivot_table(index="zBucket", columns="mBucket", values="flip", aggfunc=["mean", "size"], observed=True)
print(piv.round(3).to_string())

# ---- dMid15 (book repricing) ----
print("\n=== dMid15 (repricing do book contra favorito) tau=30, z<2 ===")
sub2 = df[(df["tau"] == 30) & (df["z"] < 2)].copy()
db = [-1, -0.10, -0.05, -0.02, 0, 0.02, 0.05, 1]
sub2["dmB"] = pd.cut(sub2["dMid15"], db, right=False)
print(sub2.groupby("dmB", observed=True).agg(n=("flip", "size"), flip=("flip", "mean")).round(3))

# ---- cruzamentos ----
print("\n=== cross60 tau=30 (z<2) ===")
print(sub2.groupby(sub2["cross60"].clip(upper=5)).agg(n=("flip", "size"), flip=("flip", "mean")).round(3))
print("\n=== lastCrossAge tau=30 (z<2) ===")
ab = [0, 10, 30, 60, 120, 999, 10000]
sub2["ageB"] = pd.cut(sub2["lastCrossAge"], ab, right=False)
print(sub2.groupby("ageB", observed=True).agg(n=("flip", "size"), flip=("flip", "mean")).round(3))

# ---- favMid: o mercado ja sabe? ----
print("\n=== flip rate vs favMid (mercado) tau=30 ===")
fb = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.01]
sub = df[df["tau"] == 30].copy()
sub["fB"] = pd.cut(sub["favMid"], fb, right=False)
g = sub.groupby("fB", observed=True).agg(n=("flip", "size"), flip=("flip", "mean")).round(3)
g["mktImplied"] = [round(1 - (a + b) / 2, 3) for a, b in zip(fb[:-1], fb[1:])]
print(g)

# ---- Logistica numpy: prever flip ----
def logit_fit(X, y, iters=300, lr=0.5):
    Xb = np.column_stack([np.ones(len(X)), X])
    w = np.zeros(Xb.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Xb @ w))
        g = Xb.T @ (p - y) / len(y)
        H = (Xb * (p * (1 - p))[:, None]).T @ Xb / len(y) + 1e-6 * np.eye(Xb.shape[1])
        w -= np.linalg.solve(H, g)
    return w

def logit_pred(w, X):
    Xb = np.column_stack([np.ones(len(X)), X])
    return 1 / (1 + np.exp(-Xb @ w))

FEATS = ["z", "momToN", "cross60c", "dMid15f", "favMid", "logAge"]
def prep(d):
    d = d.copy()
    d["momToN"] = (d["momTo10"] / (d["sigma60"] * math.sqrt(10)).clip(lower=1e-9)).clip(-4, 4)
    d["cross60c"] = d["cross60"].clip(upper=6)
    d["dMid15f"] = d["dMid15"].fillna(0).clip(-0.2, 0.2)
    d["logAge"] = np.log1p(d["lastCrossAge"].clip(upper=999))
    d["zc"] = d["z"].clip(upper=6)
    return d

print("\n=== LOGISTICA por tau (train -> holdout AUC) ===")
def auc(y, p):
    order = np.argsort(p)
    y = np.asarray(y)[order]
    n1 = y.sum(); n0 = len(y) - n1
    if n1 == 0 or n0 == 0: return float("nan")
    ranks = np.arange(1, len(y) + 1)
    return (ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n0 * n1)

models = {}
for tau in [90, 60, 45, 30, 20, 10]:
    d = prep(df[df["tau"] == tau])
    tr, ho = d[d["train"]], d[~d["train"]]
    X = tr[["zc", "momToN", "cross60c", "dMid15f", "favMid", "logAge"]].values
    w = logit_fit(X, tr["flip"].values.astype(float))
    pho = logit_pred(w, ho[["zc", "momToN", "cross60c", "dMid15f", "favMid", "logAge"]].values)
    ptr = logit_pred(w, X)
    # baseline: so favMid (mercado)
    wm = logit_fit(tr[["favMid"]].values, tr["flip"].values.astype(float))
    pm = logit_pred(wm, ho[["favMid"]].values)
    # baseline: so z
    wz = logit_fit(tr[["zc"]].values, tr["flip"].values.astype(float))
    pz = logit_pred(wz, ho[["zc"]].values)
    models[tau] = w
    print(f"tau={tau:3d}s  n_tr={len(tr):5d} n_ho={len(ho):5d} flip_ho={ho['flip'].mean():.3f} | "
          f"AUC full={auc(ho['flip'].values, pho):.3f} trainAUC={auc(tr['flip'].values, ptr):.3f} | "
          f"AUC favMid={auc(ho['flip'].values, pm):.3f} | AUC z={auc(ho['flip'].values, pz):.3f}")
    print("   pesos:", dict(zip(["b0"] + ["zc", "momToN", "cross60c", "dMid15f", "favMid", "logAge"], np.round(w, 3))))

# ---- Gate economico no cenario MIDAS: comprar favorito no tau, segurar ate settle ----
# EV real por trade $10: win -> 10/ask*0.995 - 10 - fee ; loss -> -10 - fee (fee ~ 0.07*p*(1-p)*shares)
print("\n=== SIMULACAO ECONOMICA (compra favorito a favAsk, $10, settle 0.995) ===")
def ev_row(r):
    ask = r["favAsk"]
    if not (0 < ask < 1): return np.nan
    shares = 10.0 / ask
    fee = 0.07 * ask * (1 - ask) * shares
    if r["flip"] == 0:
        return shares * 0.995 - 10.0 - fee
    return -10.0 - fee

for tau in [30, 20, 10]:
    d = prep(df[(df["tau"] == tau) & (df["favAsk"] > 0.5) & (df["favAsk"] <= 0.94)]).copy()
    d["pnl"] = d.apply(ev_row, axis=1)
    d = d[np.isfinite(d["pnl"])]
    tr, ho = d[d["train"]], d[~d["train"]]
    w = models[tau]
    for name, dd in [("train", tr), ("holdout", ho)]:
        p = logit_pred(w, dd[["zc", "momToN", "cross60c", "dMid15f", "favMid", "logAge"]].values)
        dd = dd.copy(); dd["pFlip"] = p
        base = dd["pnl"].sum(); n = len(dd)
        print(f"\n-- tau={tau}s {name}: n={n} PnL_base=${base:.0f} (exp {base/max(n,1):.3f}) --")
        for thr in [0.15, 0.20, 0.25, 0.30, 0.40]:
            keep = dd[dd["pFlip"] < thr]
            skip = dd[dd["pFlip"] >= thr]
            print(f"   gate pFlip<{thr:.2f}: mantem {len(keep):5d} PnL=${keep['pnl'].sum():8.0f} "
                  f"(exp {keep['pnl'].mean() if len(keep) else 0:.3f}) | corta {len(skip):4d} "
                  f"PnL_evitado=${skip['pnl'].sum():8.0f} (exp {skip['pnl'].mean() if len(skip) else 0:.3f}, flipRate={skip['flip'].mean() if len(skip) else 0:.2f})")

print("\nOK")
