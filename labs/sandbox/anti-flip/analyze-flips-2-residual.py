# -*- coding: utf-8 -*-
"""Parte 4: (A) poder residual apos condicionar no preco do mercado; (B) robustez dia-a-dia da saida."""
import math
import numpy as np
import pandas as pd

CSV = r"C:\Users\lamar\AppData\Local\Temp\claude\D--Projetos-projeto-goldenlens-data-backtest\63477af6-927c-451f-b87f-48a7f647f3cb\scratchpad\flip-features.csv"
HOLDOUT_START = "2026-06-25"
pd.set_option("display.width", 220)

df = pd.read_csv(CSV)
df["day"] = df["day"].astype(str)
df = df[np.isfinite(df["z"]) & np.isfinite(df["momTo10"])].copy()
df["train"] = df["day"] < HOLDOUT_START

def prep(d):
    d = d.copy()
    d["momToN"] = (d["momTo10"] / (d["sigma60"] * math.sqrt(10)).clip(lower=1e-9)).clip(-4, 4)
    d["cross60c"] = d["cross60"].clip(upper=6)
    d["dMid15f"] = d["dMid15"].fillna(0).clip(-0.2, 0.2)
    d["logAge"] = np.log1p(d["lastCrossAge"].clip(upper=999))
    d["zc"] = d["z"].clip(upper=6)
    return d

def logit_fit(X, y, iters=60):
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

# ===== A. RESIDUAL: dentro de cada faixa de preco, z/book/momentum ainda informam? =====
print("=== A. PODER RESIDUAL DENTRO DE FAIXAS DE PRECO (tau=30, holdout) ===")
d = prep(df[df["tau"] == 30])
tr, ho = d[d["train"]], d[~d["train"]]
bands = [(0.55, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 0.95), (0.95, 1.01)]
for lo, hi in bands:
    m_tr = tr[(tr["favMid"] >= lo) & (tr["favMid"] < hi)]
    m_ho = ho[(ho["favMid"] >= lo) & (ho["favMid"] < hi)]
    if len(m_ho) < 100: continue
    imp = 1 - (lo + hi) / 2
    print(f"\n-- favMid [{lo:.2f},{hi:.2f}) n_ho={len(m_ho)} flip_real={m_ho['flip'].mean():.3f} vs implicito~{imp:.3f}")
    for feat, cuts in [("z", [0, 1, 2, 4, 100]), ("dMid15f", [-1, -0.05, -0.01, 0.01, 1]), ("momToN", [-5, -1, 0, 1, 5])]:
        g = m_ho.groupby(pd.cut(m_ho[feat], cuts, right=False), observed=True).agg(n=("flip", "size"), flip=("flip", "mean")).round(3)
        print(f"   {feat}: " + " | ".join(f"{str(i)}={r['flip']:.3f}(n{int(r['n'])})" for i, r in g.iterrows()))

# AUC do modelo SEM favMid vs preco sozinho, dentro de bandas
def auc(y, p):
    o = np.argsort(p); y = np.asarray(y)[o]
    n1 = y.sum(); n0 = len(y) - n1
    if n1 == 0 or n0 == 0: return float("nan")
    r = np.arange(1, len(y) + 1)
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n0 * n1)

print("\n=== AUC dentro de banda de preco: features de microestrutura sozinhas (holdout) ===")
NOPRICE = ["zc", "momToN", "cross60c", "dMid15f", "logAge"]
for lo, hi in bands:
    m_tr = tr[(tr["favMid"] >= lo) & (tr["favMid"] < hi)]
    m_ho = ho[(ho["favMid"] >= lo) & (ho["favMid"] < hi)]
    if len(m_ho) < 200 or m_ho["flip"].sum() < 20: continue
    w = logit_fit(m_tr[NOPRICE].values, m_tr["flip"].values.astype(float))
    p = logit_pred(w, m_ho[NOPRICE].values)
    wp = logit_fit(m_tr[["favMid"]].values, m_tr["flip"].values.astype(float))
    pp = logit_pred(wp, m_ho[["favMid"]].values)
    print(f"  favMid[{lo:.2f},{hi:.2f}) n={len(m_ho)} flips={int(m_ho['flip'].sum())} | AUC micro={auc(m_ho['flip'].values, p):.3f} | AUC preco-dentro-da-banda={auc(m_ho['flip'].values, pp):.3f}")

# ===== B. ROBUSTEZ DIA-A-DIA DA REGRA DE SAIDA =====
print("\n\n=== B. SAIDA 'PERDEU LIDERANCA' — ROBUSTEZ TEMPORAL ===")
piv = {t: prep(df[df["tau"] == t]).set_index("event_start") for t in [30, 20, 10]}
e30 = piv[30][(piv[30]["favAsk"] > 0.5) & (piv[30]["favAsk"] <= 0.94)]
common = e30.index.intersection(piv[20].index).intersection(piv[10].index)
e30, e20, e10 = e30.loc[common], piv[20].loc[common], piv[10].loc[common]

res = pd.DataFrame(index=common)
res["day"] = e30["day"].values
res["train"] = e30["train"].values
res["ask"] = e30["favAsk"].values
res["win"] = (e30["leader"].values == e30["winner"].values).astype(int)
res["same20"] = (e20["leader"].values == e30["leader"].values)
res["same10"] = (e10["leader"].values == e30["leader"].values)
# preco de venda = bid do NOSSO lado no momento da saida
mid20 = np.where(res["same20"], e20["favMid"].values, 1 - e20["favMid"].values)
mid10 = np.where(res["same10"], e10["favMid"].values, 1 - e10["favMid"].values)
res["bid20"] = np.clip(mid20 - e20["spread"].values / 2, 0.01, 0.99)
res["bid10"] = np.clip(mid10 - e10["spread"].values / 2, 0.01, 0.99)

shares = 10.0 / res["ask"]
feeIn = 0.07 * res["ask"] * (1 - res["ask"]) * shares
pnl_hold = np.where(res["win"] == 1, shares * 0.995 - 10.0 - feeIn, -10.0 - feeIn)

def exit_pnl(px):
    fee = 0.07 * px * (1 - px) * shares
    return shares * px - 10.0 - feeIn - fee

exited20 = ~res["same20"]
exited10 = res["same20"] & ~res["same10"]
pnl_rule = np.where(exited20, exit_pnl(res["bid20"]),
             np.where(exited10, exit_pnl(res["bid10"]), pnl_hold))
res["pnlHold"] = pnl_hold
res["pnlRule"] = pnl_rule
res["exited"] = exited20 | exited10

print(f"total n={len(res)} | saidas acionadas: {res['exited'].sum()} ({res['exited'].mean()*100:.1f}%)")
print(f"  HOLD  : ${pnl_hold.sum():.0f}  (exp {pnl_hold.mean():.3f})")
print(f"  REGRA : ${pnl_rule.sum():.0f}  (exp {pnl_rule.mean():.3f})   delta=${pnl_rule.sum()-pnl_hold.sum():+.0f}")

print("\n-- so nas posicoes onde a saida disparou --")
ex = res[res["exited"]]
print(f"  n={len(ex)} | WR se tivesse segurado={ex['win'].mean():.3f}")
print(f"  HOLD ${ex['pnlHold'].sum():.0f} (exp {ex['pnlHold'].mean():.3f}) -> REGRA ${ex['pnlRule'].sum():.0f} (exp {ex['pnlRule'].mean():.3f})")

print("\n-- por mes --")
res["month"] = res["day"].str[:7]
g = res.groupby("month").agg(n=("pnlHold", "size"), hold=("pnlHold", "sum"), rule=("pnlRule", "sum"),
                             nExit=("exited", "sum")).round(0)
g["delta"] = (g["rule"] - g["hold"]).round(0)
print(g.to_string())

print("\n-- consistencia diaria (delta por dia) --")
gd = res.groupby("day").agg(hold=("pnlHold", "sum"), rule=("pnlRule", "sum"))
gd["delta"] = gd["rule"] - gd["hold"]
print(f"  dias com delta>0: {(gd['delta'] > 0).sum()} | delta<0: {(gd['delta'] < 0).sum()} | =0: {(gd['delta'] == 0).sum()}")
print(f"  delta mediano/dia: ${gd['delta'].median():.2f} | media ${gd['delta'].mean():.2f} | pior dia ${gd['delta'].min():.2f} | melhor ${gd['delta'].max():.2f}")

print("\n-- drawdown --")
for col in ["pnlHold", "pnlRule"]:
    daily = res.groupby("day")[col].sum().sort_index()
    eq = daily.cumsum()
    dd = (eq.cummax() - eq).max()
    print(f"  {col}: PnL ${daily.sum():.0f} | maxDD ${dd:.0f} | pior dia ${daily.min():.2f}")

# variante: exigir tambem que o book confirme (bid do nosso lado < 0.5) para nao sair em ruido
print("\n-- variante: sair so se perdeu lideranca E book concorda (bid do nosso lado < 0.45) --")
cond20 = exited20 & (res["bid20"] < 0.45)
cond10 = exited10 & (res["bid10"] < 0.45)
pnl_v2 = np.where(cond20, exit_pnl(res["bid20"]), np.where(cond10, exit_pnl(res["bid10"]), pnl_hold))
print(f"  n_saidas={cond20.sum()+cond10.sum()} | PnL ${pnl_v2.sum():.0f} (exp {pnl_v2.mean():.3f})")
res["pnlV2"] = pnl_v2
for name, m in [("train", res["train"]), ("holdout", ~res["train"])]:
    s = res[m]
    print(f"  {name}: hold ${s['pnlHold'].sum():.0f} | regra ${s['pnlRule'].sum():.0f} | v2 ${s['pnlV2'].sum():.0f}")

print("\nOK")
