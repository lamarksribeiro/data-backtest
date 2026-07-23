import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createStrategy, validateStrategySource } from '../src/backtestStudio/state/strategies.js';
import { buildCompiledArtifact } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { createHash } from 'node:crypto';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

try {
  let strategy = db.prepare("SELECT * FROM strategy_definitions WHERE slug = 'abrupt-spike-scalper'").get();
  if (!strategy) {
    strategy = createStrategy(db, { slug: 'abrupt-spike-scalper', name: 'Abrupt Spike Scalper' });
  }

  const v5SourceCode = `export default strategy({
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

  const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: v5SourceCode, db });
  const compiled = validation.ok ? buildCompiledArtifact(v5SourceCode) : null;
  const checksum = createHash('sha256').update(String(v5SourceCode)).digest('hex');

  // Insert or update version 5
  const existingV5 = db.prepare('SELECT id FROM strategy_versions WHERE strategy_id = ? AND version = 5').get(strategy.id);

  if (existingV5) {
    db.prepare(`
      UPDATE strategy_versions
      SET language = 'strategy-js-v1', source_code = ?, params_schema_json = ?, compiled_json = ?, validation_json = ?, checksum = ?, notes = ?
      WHERE id = ?
    `).run(
      v5SourceCode,
      JSON.stringify(validation.params_schema || {}),
      compiled ? JSON.stringify(compiled) : null,
      JSON.stringify(validation),
      checksum,
      'v5 - AbruptSpikeScalper calibrada (minSpikeAbs=2.5)',
      existingV5.id
    );
    console.log('Versão 5 atualizada com sucesso no banco (id:', existingV5.id, ')');
  } else {
    const res = db.prepare(`
      INSERT INTO strategy_versions (
        strategy_id, version, language, source_code, params_schema_json, compiled_json, validation_json, checksum, notes
      ) VALUES (?, 5, 'strategy-js-v1', ?, ?, ?, ?, ?, ?)
    `).run(
      strategy.id,
      v5SourceCode,
      JSON.stringify(validation.params_schema || {}),
      compiled ? JSON.stringify(compiled) : null,
      JSON.stringify(validation),
      checksum,
      'v5 - AbruptSpikeScalper calibrada (minSpikeAbs=2.5)'
    );
    console.log('Versão 5 inserida com sucesso no banco (id:', res.lastInsertRowid, ')');
  }

  // Update default_version_id
  const v5Row = db.prepare('SELECT id FROM strategy_versions WHERE strategy_id = ? AND version = 5').get(strategy.id);
  db.prepare("UPDATE strategy_definitions SET default_version_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(v5Row.id, strategy.id);
  console.log('Versão 5 definida como versão padrão!');

} catch (err) {
  console.error('Erro:', err);
} finally {
  closeStateDatabase(db);
}
