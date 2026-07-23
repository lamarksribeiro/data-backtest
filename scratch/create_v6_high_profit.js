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

  const v6HighProfitCode = `export default strategy({
  name: "Abrupt Spike Scalper (High Profit Carry)",
  params: {
    entryWindowStart: 120,
    entryWindowEnd: 25,
    minDistancePtb: 35,
    impulseSec: 5,
    minDipAbs: 2.5,
    maxAsk: 0.72,
    minAsk: 0.20,
    maxSpread: 0.04,
    takeProfitBid: 0.82,
    stopLossBid: 0.35,
    maxHoldSec: 25,
    budget: 15
  },
  onEventStart({ state }) {
    state.entered = false;
  },
  onTick(ctx) {
    const { tick, event, state, params } = ctx;
    const secsLeft = time.secondsUntil(event.end, tick.ts);

    if (position.open) {
      const bid = book.bid(position.side, tick);
      if (bid >= params.takeProfitBid) {
        orders.exit({ price: bid, reason: "tp_target_bid" });
      } else if (bid <= params.stopLossBid) {
        orders.exit({ price: bid, reason: "sl_floor" });
      } else if (time.secondsSince(position.entryTime, tick.ts) >= params.maxHoldSec) {
        orders.exit({ price: bid, reason: "max_hold_timeout" });
      }
    } else {
      if (time.inWindow(secsLeft, params.entryWindowStart, params.entryWindowEnd)) {
        const btc = tick.underlyingPrice;
        const ptb = event.priceToBeat;
        const distPtb = btc - ptb;
        const absDist = Math.abs(distPtb);

        if (absDist >= params.minDistancePtb) {
          const ago = signals.underlyingAgo(params.impulseSec);
          if (ago) {
            const deltaBtc = btc - ago;
            const isUpDip = distPtb >= params.minDistancePtb && deltaBtc <= -params.minDipAbs;
            const isDownDip = distPtb <= -params.minDistancePtb && deltaBtc >= params.minDipAbs;

            if (isUpDip) {
              const ask = book.ask("UP", tick);
              const bid = book.bid("UP", tick);
              const spread = ask - bid;
              if (ask >= params.minAsk && ask <= params.maxAsk && spread <= params.maxSpread) {
                orders.enter("UP", { price: ask, budget: params.budget, reason: "dip_carry_entry" });
              }
            } else if (isDownDip) {
              const ask = book.ask("DOWN", tick);
              const bid = book.bid("DOWN", tick);
              const spread = ask - bid;
              if (ask >= params.minAsk && ask <= params.maxAsk && spread <= params.maxSpread) {
                orders.enter("DOWN", { price: ask, budget: params.budget, reason: "dip_carry_entry" });
              }
            }
          }
        }
      }
    }
  },
  onEventEnd() {
    orders.closeOpenPosition({ reason: "event_end" });
  }
});`;

  const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: v6HighProfitCode, db });
  const compiled = validation.ok ? buildCompiledArtifact(v6HighProfitCode) : null;
  const checksum = createHash('sha256').update(String(v6HighProfitCode)).digest('hex');

  const existingV6 = db.prepare('SELECT id FROM strategy_versions WHERE strategy_id = ? AND version = 6').get(strategy.id);

  if (existingV6) {
    db.prepare(`
      UPDATE strategy_versions
      SET language = 'strategy-js-v1', source_code = ?, params_schema_json = ?, compiled_json = ?, validation_json = ?, checksum = ?, notes = ?
      WHERE id = ?
    `).run(
      v6HighProfitCode,
      JSON.stringify(validation.params_schema || {}),
      compiled ? JSON.stringify(compiled) : null,
      JSON.stringify(validation),
      checksum,
      'v6 - AbruptSpikeScalper (Alta Lucratividade Carry Dip)',
      existingV6.id
    );
    console.log('Versão 6 atualizada com sucesso (id:', existingV6.id, ')');
  } else {
    const res = db.prepare(`
      INSERT INTO strategy_versions (
        strategy_id, version, language, source_code, params_schema_json, compiled_json, validation_json, checksum, notes
      ) VALUES (?, 6, 'strategy-js-v1', ?, ?, ?, ?, ?, ?)
    `).run(
      strategy.id,
      v6HighProfitCode,
      JSON.stringify(validation.params_schema || {}),
      compiled ? JSON.stringify(compiled) : null,
      JSON.stringify(validation),
      checksum,
      'v6 - AbruptSpikeScalper (Alta Lucratividade Carry Dip)'
    );
    console.log('Versão 6 criada com sucesso (id:', res.lastInsertRowid, ')');
  }

  // Set version 6 as default version
  const v6Row = db.prepare('SELECT id FROM strategy_versions WHERE strategy_id = ? AND version = 6').get(strategy.id);
  db.prepare("UPDATE strategy_definitions SET default_version_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(v6Row.id, strategy.id);
  console.log('Versão 6 definida como versão padrão!');

} catch (err) {
  console.error('Erro ao criar v6:', err);
} finally {
  closeStateDatabase(db);
}
