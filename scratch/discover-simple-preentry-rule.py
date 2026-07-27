"""Descobre uma aproximação simples do alerta pré-entrada anti-flip.

Seleção usa somente 2026-04-27..2026-06-21. A janela 2026-06-22..2026-07-26
é avaliada depois. O objetivo é uma regra interpretável, não substituir o
walk-forward do modelo calibrado.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(r"D:\Projetos\projeto-goldenlens\data-backtest")
INPUT = ROOT / "scratch" / "flip-features-canonical.csv"
OUT_JSON = ROOT / "scratch" / "simple-preentry-flip-rule.json"
OUT_MD = ROOT / "scratch" / "simple-preentry-flip-rule.md"
TEST_START = "2026-06-22"
BUDGET = 10.0
SETTLE = 0.995
BOOTSTRAPS = 50_000
SEED = 20260727


def max_drawdown(values: np.ndarray) -> float:
    if not len(values):
        return 0.0
    equity = np.cumsum(values)
    peaks = np.maximum.accumulate(np.r_[0.0, equity])[:-1]
    return float(np.max(peaks - equity))


def evaluate(frame: pd.DataFrame, signal: np.ndarray) -> dict:
    blocked = frame.loc[signal]
    kept = frame.loc[~signal]
    daily = (
        frame.assign(delta=np.where(signal, -frame["realizedPnl"], 0.0))
        .groupby("day", sort=True)["delta"]
        .sum()
        .to_numpy(float)
    )
    rng = np.random.default_rng(SEED)
    draws = rng.choice(daily, size=(BOOTSTRAPS, len(daily)), replace=True).sum(axis=1)
    low, high = np.quantile(draws, [0.025, 0.975])
    return {
        "entries": int(len(frame)),
        "baseFlipRate": float(frame["flip"].mean()),
        "basePnl": float(frame["realizedPnl"].sum()),
        "baseMaxDrawdown": max_drawdown(frame["realizedPnl"].to_numpy(float)),
        "blocked": int(len(blocked)),
        "blockRate": float(len(blocked) / len(frame)),
        "precision": float(blocked["flip"].mean()) if len(blocked) else None,
        "pnlDelta": float(-blocked["realizedPnl"].sum()),
        "newPnl": float(kept["realizedPnl"].sum()),
        "newMaxDrawdown": max_drawdown(kept["realizedPnl"].to_numpy(float)),
        "positiveDays": int((daily > 0).sum()),
        "negativeDays": int((daily < 0).sum()),
        "bootstrapCi95Total": [float(low), float(high)],
        "bootstrapProbabilityPositive": float((draws > 0).mean()),
        "signalMedians": {
            "favAsk": float(blocked["favAsk"].median()),
            "z": float(blocked["z"].median()),
            "dMid15": float(blocked["dMid15"].median()),
        } if len(blocked) else {},
    }


raw = pd.read_csv(INPUT)
frame = raw[
    (raw["tau"] == 30)
    & raw["favAsk"].between(0.55, 0.94, inclusive="both")
    & (raw["dist"].abs() < 40)
    & (raw["spread"] <= 0.03)
    & raw["oddsSum"].between(0.98, 1.06, inclusive="both")
].copy()
frame["date"] = pd.to_datetime(frame["day"])
frame.sort_values("event_start", inplace=True)
ask = frame["favAsk"].to_numpy(float)
shares = BUDGET / ask
fee = shares * 0.07 * ask * (1.0 - ask)
frame["realizedPnl"] = np.where(
    frame["flip"].to_numpy(int) == 1,
    -BUDGET - fee,
    shares * SETTLE - BUDGET - fee,
)

development = frame[frame["date"] < TEST_START].copy()
test = frame[frame["date"] >= TEST_START].copy()
candidates = []
for min_drop in (-0.05, -0.08, -0.10, -0.12, -0.15, -0.18, -0.20):
    for max_z in (0.25, 0.50, 0.75, 1.0, 1.5, 2.0):
        for max_ask in (0.60, 0.62, 0.65, 0.68, 0.70, 0.75):
            signal = (
                (development["dMid15"] <= min_drop)
                & (development["z"] <= max_z)
                & (development["favAsk"] <= max_ask)
            ).to_numpy(bool)
            blocked = development.loc[signal]
            if len(blocked) < 40:
                continue
            precision = float(blocked["flip"].mean())
            if precision < 0.45:
                continue
            candidates.append(
                {
                    "minDrop15": min_drop,
                    "maxZ": max_z,
                    "maxAsk": max_ask,
                    "blocked": int(len(blocked)),
                    "precision": precision,
                    "pnlDelta": float(-blocked["realizedPnl"].sum()),
                }
            )

if not candidates:
    raise SystemExit("Nenhuma regra atingiu suporte e precisão mínimos.")
selected = max(candidates, key=lambda row: row["pnlDelta"])


def signal_for(selected_frame: pd.DataFrame, include_z: bool = True) -> np.ndarray:
    signal = (
        (selected_frame["dMid15"] <= selected["minDrop15"])
        & (selected_frame["favAsk"] <= selected["maxAsk"])
    )
    if include_z:
        signal &= selected_frame["z"] <= selected["maxZ"]
    return signal.to_numpy(bool)


results = {
    "development": evaluate(development, signal_for(development)),
    "test": evaluate(test, signal_for(test)),
    "all": evaluate(frame, signal_for(frame)),
}
controls = {
    "withoutPhysicalZConfirmation": {
        "development": evaluate(development, signal_for(development, include_z=False)),
        "test": evaluate(test, signal_for(test, include_z=False)),
    },
    "bookDropOnly": {
        "development": evaluate(
            development,
            (development["dMid15"] <= selected["minDrop15"]).to_numpy(bool),
        ),
        "test": evaluate(
            test,
            (test["dMid15"] <= selected["minDrop15"]).to_numpy(bool),
        ),
    },
}
report = {
    "generatedAt": pd.Timestamp.utcnow().isoformat(),
    "input": str(INPUT.relative_to(ROOT)),
    "selectionWindow": f"{frame['day'].min()}..2026-06-21",
    "testWindow": f"{TEST_START}..{frame['day'].max()}",
    "selectionCriterion": (
        "maximize development pnlDelta with at least 40 signals and 45% precision"
    ),
    "candidatesTested": len(candidates),
    "selectedRule": selected,
    "results": results,
    "controls": controls,
    "warning": (
        "Exploratory analyst holdout: the calendar was used by earlier anti-flip work, "
        "although this exact rule was selected without its outcomes."
    ),
}
OUT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

lines = [
    "# Regra simples de alerta pré-entrada",
    "",
    "Selecionada antes de ler o teste:",
    "",
    "```text",
    f"tau = 30 s",
    f"favMid caiu >= {abs(selected['minDrop15']):.2f} em 15 s",
    f"z físico <= {selected['maxZ']:.2f}",
    f"favAsk <= {selected['maxAsk']:.2f}",
    "=> não entrar",
    "```",
    "",
    "| janela | bloqueadas | flip base → sinal | ΔPnL | PnL base → novo | DD base → novo | IC95% Δ |",
    "|---|---:|---:|---:|---:|---:|---:|",
]
for name in ("development", "test", "all"):
    row = results[name]
    low, high = row["bootstrapCi95Total"]
    lines.append(
        f"| {name} | {row['blocked']} ({row['blockRate']:.1%}) | "
        f"{row['baseFlipRate']:.1%} → {row['precision']:.1%} | "
        f"{row['pnlDelta']:+.2f} | {row['basePnl']:+.2f} → {row['newPnl']:+.2f} | "
        f"{row['baseMaxDrawdown']:.2f} → {row['newMaxDrawdown']:.2f} | "
        f"[{low:+.2f}; {high:+.2f}] |"
    )
lines.extend(
    [
        "",
        "No teste posterior, o sinal mediano ocorreu com ask "
        f"{results['test']['signalMedians']['favAsk']:.2f}, z "
        f"{results['test']['signalMedians']['z']:.2f} e queda de mid "
        f"{abs(results['test']['signalMedians']['dMid15']):.2f}.",
        "",
        "O `z` é a confirmação física: distância do PTB normalizada pela "
        "volatilidade e pelo tempo restante. Retirá-lo aumenta cobertura, mas "
        "reduz a concentração de flips.",
    ]
)
OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(OUT_MD)
