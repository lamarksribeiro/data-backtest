# -*- coding: utf-8 -*-
"""MERGE Flip Hunt x Anti-Flip: calibracao de Phi(z), OOS nunca minerado, saida anti-flip."""
import numpy as np, pandas as pd, math
CSV = r"C:\Users\lamar\AppData\Local\Temp\claude\D--Projetos-projeto-goldenlens-data-backtest\63477af6-927c-451f-b87f-48a7f647f3cb\scratchpad\merge-fliphunt.csv"
pd.set_option("display.width", 250)
d = pd.read_csv(CSV); d["day"] = d["day"].astype(str)
EX = [c[4:] for c in d.columns if c.startswith("pnl_")]

# Splits: replica os do Flip Hunt + adiciona a janela NUNCA minerada por eles
d["split"] = np.where(d["day"] < "2026-05-28", "PRE (nunca minerado)",
             np.where(d["day"] < "2026-07-01", "train (deles)", "holdout (deles)"))

print(f"=== ENTRADAS REPLICADAS (preset btc-tight-spread, 91 dias) ===")
print(f"total={len(d)} | dias={d['day'].nunique()} | WR={d['win'].mean():.3f}")
print(d.groupby("split").agg(n=("win","size"), dias=("day","nunique"), WR=("win","mean"),
                             pnl_hold=("pnl_hold","sum")).round(3).to_string())

print("\n\n=== 1. CALIBRACAO DO TERMO DE FISICA pPhys = Phi(z) ===")
print("Este e o gate do Flip Hunt: edge = pPhys - ask >= 0.05\n")
b = [0.83,0.90,0.95,0.98,0.995,1.001]
d["pB"] = pd.cut(d["pPhys"], b, right=False)
g = d.groupby("pB", observed=True).agg(n=("win","size"), winReal=("win","mean"), pPhysMed=("pPhys","median")).round(4)
g["vies_pp"] = ((g["pPhysMed"] - g["winReal"])*100).round(1)
print(g.to_string())
print(f"\nMedia pPhys = {d['pPhys'].mean():.4f}  |  WR real = {d['win'].mean():.4f}")
print(f"==> Phi(z) SUPERESTIMA a prob. de vitoria em {100*(d['pPhys'].mean()-d['win'].mean()):.1f} pontos percentuais")

print("\n--- edge declarado vs edge realizado ---")
d["edgeReal"] = d["win"] - d["ask"]
eb = [0.05,0.08,0.12,0.20,0.40,1.0]
d["eB"] = pd.cut(d["edge"], eb, right=False)
ge = d.groupby("eB", observed=True).agg(n=("win","size"), edgeDeclarado=("edge","mean"),
        edgeRealizado=("edgeReal","mean"), WR=("win","mean"), ask=("ask","mean"), pnl=("pnl_hold","mean")).round(4)
print(ge.to_string())
print("\n==> se o edge fosse informativo, edgeRealizado deveria CRESCER com edgeDeclarado.")
c = np.corrcoef(d["edge"], d["win"])[0,1]
print(f"    corr(edge declarado, vitoria) = {c:+.4f}")
ca = np.corrcoef(d["ask"], d["win"])[0,1]
print(f"    corr(ask, vitoria)            = {ca:+.4f}")
cz = np.corrcoef(d["z"].clip(upper=10), d["win"])[0,1]
print(f"    corr(z, vitoria)              = {cz:+.4f}")

print("\n\n=== 2. VALIDACAO NA JANELA NUNCA MINERADA (2026-04-23 -> 2026-05-27) ===")
for s in ["PRE (nunca minerado)", "train (deles)", "holdout (deles)"]:
    ss = d[d["split"] == s]
    if not len(ss): continue
    daily = ss.groupby("day")["pnl_hold"].sum()
    w = ss[ss["pnl_hold"]>0]["pnl_hold"].sum(); l = -ss[ss["pnl_hold"]<0]["pnl_hold"].sum()
    print(f"  {s:24s} n={len(ss):4d} WR={ss['win'].mean():.3f} PnL=${ss['pnl_hold'].sum():7.1f} "
          f"exp={ss['pnl_hold'].mean():+.3f} PF={w/l if l else np.inf:.3f} diasPos={int((daily>0).sum())}/{len(daily)}")

print("\n\n=== 3. SAIDA ANTI-FLIP APLICADA AOS TRADES DO FLIP HUNT ===")
rows=[]
for v in EX:
    p = d[f"pnl_{v}"]; t = d[f"t_{v}"]
    daily = d.groupby("day")[f"pnl_{v}"].sum().sort_index(); eq = daily.cumsum()
    w = p[p>0].sum(); l = -p[p<0].sum()
    r = {"saida": v, "nExit": int(t.notna().sum()), "PnL": round(p.sum(),1), "exp": round(p.mean(),3),
         "PF": round(w/l,3) if l else np.inf, "maxDD": round((eq.cummax()-eq).max(),1),
         "piorDia": round(daily.min(),1), "diasPos": int((daily>0).sum())}
    for s in ["PRE (nunca minerado)","train (deles)","holdout (deles)"]:
        r[s.split()[0]] = round(d[d["split"]==s][f"pnl_{v}"].sum(),1)
    rows.append(r)
print(pd.DataFrame(rows).sort_values("PnL",ascending=False).to_string(index=False))

print("\n--- eficiencia: so onde a saida disparou (lead_bid40) ---")
for v in ["lead","lead_bid40","lead_bid45"]:
    m = d[f"t_{v}"].notna(); s = d[m]
    if not m.sum(): continue
    print(f"  {v:12s} n={m.sum():4d} | WR se segurasse={s['win'].mean():.3f} | "
          f"hold ${s['pnl_hold'].sum():7.1f} -> ${s[f'pnl_{v}'].sum():7.1f} (recupera ${s[f'pnl_{v}'].sum()-s['pnl_hold'].sum():+.1f})")
    fp=s[s["win"]==1]; tp=s[s["win"]==0]
    print(f"               falso alarme n={len(fp)} custo ${(fp[f'pnl_{v}']-fp['pnl_hold']).sum():+.1f} | "
          f"acerto n={len(tp)} ganho ${(tp[f'pnl_{v}']-tp['pnl_hold']).sum():+.1f}")
    print(f"               antecedencia mediana {s[f't_{v}'].median():.1f}s")

print("\n\n=== 4. RE-RANKING POR CALIBRACAO EMPIRICA (substituir Phi por WR empirico) ===")
# calibracao empirica isotonica-ish por bin de z, ajustada SO no PRE+train, aplicada no holdout
tr = d[d["split"] != "holdout (deles)"]; ho = d[d["split"] == "holdout (deles)"]
zb = np.array([0,1.0,1.5,2.0,2.5,3.0,4.0,6.0,100])
tr_b = pd.cut(tr["z"], zb, right=False)
cal = tr.groupby(tr_b, observed=True)["win"].agg(["mean","size"])
print("calibracao empirica ajustada em PRE+train (nunca toca o holdout deles):")
cc = cal.copy(); cc["Phi_medio"] = tr.groupby(tr_b, observed=True)["pPhys"].mean()
cc["vies_pp"] = ((cc["Phi_medio"]-cc["mean"])*100).round(1)
print(cc.round(4).to_string())

def emp_p(z):
    i = np.searchsorted(zb, z, side="right")-1
    i = np.clip(i, 0, len(zb)-2)
    key = pd.Interval(zb[i], zb[i+1], closed="left")
    return cal["mean"].get(key, np.nan)

ho = ho.copy()
ho["pEmp"] = [emp_p(z) for z in ho["z"]]
ho["edgeEmp"] = ho["pEmp"] - ho["ask"]
print(f"\nholdout: n={len(ho)} PnL_base=${ho['pnl_hold'].sum():.1f} exp={ho['pnl_hold'].mean():+.3f}")
for thr in [0.0, 0.02, 0.05, 0.08]:
    k = ho[ho["edgeEmp"] >= thr]
    print(f"  gate edge EMPIRICO >= {thr:.2f}: mantem {len(k):3d} PnL=${k['pnl_hold'].sum():7.1f} "
          f"exp={k['pnl_hold'].mean() if len(k) else 0:+.3f} WR={k['win'].mean() if len(k) else 0:.3f}")
print("  (comparar com o gate atual: edge Phi >= 0.05, que e o que ja esta aplicado em todas as linhas)")

print("\n\n=== 5. QUAL FILTRO ESTA REALMENTE FAZENDO O TRABALHO? ===")
for feat, cuts in [("ask",[0.2,0.5,0.6,0.7,0.78]), ("z",[0,1.5,2.5,4,100]),
                   ("tau",[10,20,30,40,50]), ("dist",[8,15,30,60,1000])]:
    g = d.groupby(pd.cut(d[feat], cuts, right=False), observed=True).agg(
        n=("win","size"), WR=("win","mean"), exp=("pnl_hold","mean"), expExit=("pnl_lead_bid40","mean")).round(3)
    print(f"\n-- {feat} --"); print(g.to_string())
