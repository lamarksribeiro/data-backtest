# Legacy Strategy Runners

This directory stores portable runner snapshots ported from `polymarket-test`.

They are kept outside `src` because they are migration/reference artifacts, not the runtime source of truth. The Backtest Studio loads validated runner libraries from `data/strategy-libraries` and SQLite through `src/backtestStudio/strategyLibrary`.

Regenerate these snapshots with `scripts/port-from-polymarket.js` when porting from the read-only legacy repository.
