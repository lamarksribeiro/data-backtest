"""Bootstrap pareado dos sweeps oficiais anti-flip da MIDAS.

Lê o results.json mais recente de cada janela disponível e compara cada
variante com gold-baseline no mesmo dia. O bootstrap reamostra deltas diários,
preservando o pareamento entre as estratégias.
"""

from __future__ import annotations

import glob
import json
import os
from pathlib import Path

import numpy as np


ROOT = Path(r"D:\Projetos\projeto-goldenlens\data-backtest")
REPORTS = ROOT / "reports" / "labs" / "midas-carry-v1"
OUT_JSON = ROOT / "scratch" / "midas-antiflip-sweeps-bootstrap.json"
OUT_MD = ROOT / "scratch" / "midas-antiflip-sweeps-bootstrap.md"
WINDOWS = ("blind", "june", "july")
BOOTSTRAPS = 50_000
SEED = 20260727


def latest_result(window: str) -> Path | None:
    candidates = sorted(
        glob.glob(str(REPORTS / f"*-antiflip-levers-{window}")),
        reverse=True,
    )
    if not candidates:
        return None
    result = Path(candidates[0]) / "results.json"
    return result if result.exists() else None


def load_window(window: str) -> dict | None:
    result_path = latest_result(window)
    if result_path is None:
        return None
    raw = json.loads(result_path.read_text(encoding="utf-8"))
    variants = raw.get("variants") or raw.get("results") or []
    daily = {}
    summaries = {}
    for variant in variants:
        variant_id = variant.get("id") or variant.get("variantId")
        daily[variant_id] = {
            row["dt"]: float(row["totalPnl"])
            for row in variant.get("daily", [])
        }
        summaries[variant_id] = variant.get("summary", {})
    return {
        "window": window,
        "path": os.path.relpath(result_path, ROOT),
        "daily": daily,
        "summaries": summaries,
    }


def paired_deltas(dataset: dict, variant_id: str) -> tuple[list[str], np.ndarray]:
    baseline = dataset["daily"]["gold-baseline"]
    variant = dataset["daily"][variant_id]
    days = sorted(set(baseline) & set(variant))
    return days, np.asarray([variant[day] - baseline[day] for day in days], dtype=float)


def bootstrap(deltas: np.ndarray, rng: np.random.Generator) -> dict:
    n = len(deltas)
    if n == 0:
        return {}
    draws = rng.choice(deltas, size=(BOOTSTRAPS, n), replace=True).sum(axis=1)
    low, high = np.quantile(draws, [0.025, 0.975])
    return {
        "days": n,
        "deltaPnl": float(deltas.sum()),
        "meanDeltaPerDay": float(deltas.mean()),
        "positiveDays": int((deltas > 0).sum()),
        "negativeDays": int((deltas < 0).sum()),
        "zeroDays": int((deltas == 0).sum()),
        "bootstrapCi95Total": [float(low), float(high)],
        "bootstrapProbabilityPositive": float((draws > 0).mean()),
    }


datasets = [dataset for window in WINDOWS if (dataset := load_window(window))]
if not datasets:
    raise SystemExit("Nenhum sweep anti-flip concluído.")

rng = np.random.default_rng(SEED)
variant_ids = sorted(
    set.intersection(*(set(dataset["daily"]) for dataset in datasets))
    - {"gold-baseline"}
)
rows = []
for variant_id in variant_ids:
    by_window = {}
    pooled = []
    for dataset in datasets:
        _, deltas = paired_deltas(dataset, variant_id)
        by_window[dataset["window"]] = bootstrap(deltas, rng)
        pooled.append(deltas)
    rows.append(
        {
            "variant": variant_id,
            "pooled": bootstrap(np.concatenate(pooled), rng),
            "byWindow": by_window,
        }
    )

rows.sort(key=lambda row: row["pooled"]["deltaPnl"], reverse=True)
report = {
    "generatedAt": np.datetime64("now").astype(str),
    "method": "paired daily nonparametric bootstrap",
    "bootstraps": BOOTSTRAPS,
    "seed": SEED,
    "windows": [
        {"window": dataset["window"], "results": dataset["path"]}
        for dataset in datasets
    ],
    "variants": rows,
}
OUT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

lines = [
    "# MIDAS anti-flip — bootstrap pareado por dia",
    "",
    f"Janelas: {', '.join(dataset['window'] for dataset in datasets)}. "
    f"Reamostragens: {BOOTSTRAPS:,}.",
    "",
    "| variante | ΔPnL | dias + | dias − | IC95% bootstrap | P(Δ>0) |",
    "|---|---:|---:|---:|---:|---:|",
]
for row in rows:
    pooled = row["pooled"]
    low, high = pooled["bootstrapCi95Total"]
    lines.append(
        f"| `{row['variant']}` | {pooled['deltaPnl']:+.2f} | "
        f"{pooled['positiveDays']}/{pooled['days']} | "
        f"{pooled['negativeDays']}/{pooled['days']} | "
        f"[{low:+.2f}; {high:+.2f}] | "
        f"{pooled['bootstrapProbabilityPositive']:.1%} |"
    )
OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(OUT_MD)
