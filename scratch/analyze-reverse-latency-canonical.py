"""Bootstrap pareado da reversão anti-flip canônica."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(r"D:\Projetos\projeto-goldenlens\data-backtest")
INPUT = ROOT / "scratch" / "reverse-latency-canonical.csv"
OUT_JSON = ROOT / "scratch" / "reverse-latency-canonical-stats.json"
OUT_MD = ROOT / "scratch" / "reverse-latency-canonical-stats.md"
DELAYS = ("0", "0p5", "1", "2")
MAX_ASKS = ("65", "68", "70", "72", "78", "101")
BOOTSTRAPS = 50_000
SEED = 20260727


def compare(frame: pd.DataFrame, left: str, right: str, seed: int) -> dict:
    delta = frame[f"pnl_{left}"] - frame[f"pnl_{right}"]
    daily = (
        frame.assign(delta=delta)
        .groupby("day", sort=True)["delta"]
        .sum()
        .to_numpy(float)
    )
    rng = np.random.default_rng(seed)
    draws = rng.choice(daily, size=(BOOTSTRAPS, len(daily)), replace=True).sum(axis=1)
    low, high = np.quantile(draws, [0.025, 0.975])
    return {
        "left": left,
        "right": right,
        "deltaPnl": float(delta.sum()),
        "positiveDays": int((daily > 0).sum()),
        "negativeDays": int((daily < 0).sum()),
        "zeroDays": int((daily == 0).sum()),
        "bootstrapCi95Total": [float(low), float(high)],
        "bootstrapProbabilityPositive": float((draws > 0).mean()),
    }


frame = pd.read_csv(INPUT)
rows = []
seed = SEED
for delay in DELAYS:
    exit_name = f"exit_delay{delay}"
    naive_name = f"reverse101_delay{delay}"
    for max_ask in MAX_ASKS:
        reverse_name = f"reverse{max_ask}_delay{delay}"
        seed += 1
        vs_exit = compare(frame, reverse_name, exit_name, seed)
        seed += 1
        vs_naive = compare(frame, reverse_name, naive_name, seed)
        rows.append(
            {
                "delaySeconds": float(delay.replace("p", ".")),
                "maxAsk": int(max_ask) / 100,
                "vsExit": vs_exit,
                "vsNaive": vs_naive,
            }
        )

report = {
    "generatedAt": pd.Timestamp.utcnow().isoformat(),
    "input": str(INPUT.relative_to(ROOT)),
    "method": "paired nonparametric bootstrap over daily PnL differences",
    "bootstraps": BOOTSTRAPS,
    "rows": rows,
}
OUT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

lines = [
    "# Reversão anti-flip canônica — bootstrap de latência",
    "",
    "| atraso | teto ask | Δ vs saída | dias +/− | IC95% vs saída | Δ vs reversão sem teto | IC95% vs sem teto |",
    "|---:|---:|---:|---:|---:|---:|---:|",
]
for row in rows:
    if row["maxAsk"] not in (0.70, 0.78, 1.01):
        continue
    exit_row = row["vsExit"]
    naive_row = row["vsNaive"]
    exit_low, exit_high = exit_row["bootstrapCi95Total"]
    naive_low, naive_high = naive_row["bootstrapCi95Total"]
    lines.append(
        f"| {row['delaySeconds']:.1f} s | {row['maxAsk']:.2f} | "
        f"{exit_row['deltaPnl']:+.2f} | "
        f"{exit_row['positiveDays']}/{exit_row['negativeDays']} | "
        f"[{exit_low:+.2f}; {exit_high:+.2f}] | "
        f"{naive_row['deltaPnl']:+.2f} | "
        f"[{naive_low:+.2f}; {naive_high:+.2f}] |"
    )
OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(OUT_MD)
