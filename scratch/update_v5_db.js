import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createStrategyVersion, validateStrategySource } from '../src/backtestStudio/state/strategies.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

const strategy = db.prepare("SELECT * FROM strategy_definitions WHERE slug = 'abrupt-spike-scalper'").get();
if (strategy) {
  console.log('Updating strategy_versions for abrupt-spike-scalper...');

  const fixedJsSource = `export default strategy({
  name: "Abrupt Spike Scalper",
  params: {
    impulseSec: 5,
    minSpikeAbs: 2.5,
    strategyMode: "fade",
    maxTradesPerEvent: 5,
    cooldownSec: 8,
    takeProfitPct: 0.12,
    partialTakeProfitPct: 0.50,
    stopLossPct: 0.15,
    maxHoldTimeSec: 25,
    budget: 15
  },
  onEventStart({ state }) { state.entered = false; },
  onTick(ctx) {
    const { tick, event, state, params } = ctx;
    if (position.open) {
      const bid = book.bid(position.side, tick);
      if (bid >= 0.85) {
        orders.exit({ price: bid, reason: "take_profit" });
      } else if (bid <= 0.14) {
        orders.exit({ price: bid, reason: "stop_loss" });
      }
    } else {
      const btc = tick.underlyingPrice;
      const ago = signals.underlyingAgo(params.impulseSec);
      if (ago) {
        const impulse = btc - ago;
        if (Math.abs(impulse) >= params.minSpikeAbs) {
          const side = impulse > 0 ? "DOWN" : "UP";
          const ask = book.ask(side, tick);
          if (ask >= 0.05 && ask <= 0.75) {
            orders.enter(side, { price: ask, budget: params.budget, reason: "spike_entry" });
          }
        }
      }
    }
  },
  onEventEnd() { orders.closeOpenPosition({ reason: "end" }); }
});`;

  const versions = db.prepare('SELECT id, version FROM strategy_versions WHERE strategy_id = ?').all(strategy.id);
  for (const v of versions) {
    const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: fixedJsSource, db });
    db.prepare(`
      UPDATE strategy_versions
      SET source_code = ?, params_schema_json = ?, validation_json = ?
      WHERE id = ?
    `).run(
      fixedJsSource,
      JSON.stringify(validation.params_schema || {}),
      JSON.stringify(validation),
      v.id
    );
    console.log(`Updated version ${v.version} (id ${v.id})`);
  }
}

closeStateDatabase(db);
