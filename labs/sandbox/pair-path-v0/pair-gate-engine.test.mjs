import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPairGateEngine,
  projectPairCost,
  feePerShare,
  DEFAULT_PARAMS,
} from './pair-gate-engine.mjs';

/** Defaults de teste: C1 frouxo; C2 explícito por caso. */
const BASE = {
  openShares: 5,
  openAskLo: 0.52,
  openAskHi: 0.62,
  openTriggerCents: 55,
  openCapCents: 2,
  hedgeAskMax: 0.4,
  hedgeCapCents: 2,
  epsCents: 1,
  bufferCents: 1,
  T_hedge_sec: 8,
  SL_usd: 0.4,
  latencyTicks: 1,
  maxEventNotional: 20,
  esperaLimiteC: 99,
  tauOpenMin: 40,
  tauOpenMax: 240,
  maxOpenAttempts: 3,
};

function play(engine, ticks, winner = null) {
  let ts = 0;
  for (const t of ticks) {
    ts += t.dt ?? 1;
    engine.onTick({
      tau: t.tau,
      upAsk: t.up,
      downAsk: t.dn,
      ts: t.ts ?? ts,
      upBid: t.upBid,
      downBid: t.dnBid,
    });
  }
  return engine.finish(winner);
}

test('projectPairCost: fees + buffer + eps gate', () => {
  assert.ok(feePerShare(0.5) > 0);
  const okPair = projectPairCost(0.55, 0.39, { epsCents: 1, bufferCents: 1 });
  assert.equal(okPair.ok, true, `proj=${okPair.proj}`);
  const bad = projectPairCost(0.55, 0.42, {
    epsCents: DEFAULT_PARAMS.epsCents,
    bufferCents: DEFAULT_PARAMS.bufferCents,
  });
  assert.equal(bad.ok, false, `default gate must reject 55+42; proj=${bad.proj}`);
});

test('defaults do contrato rejeitam open clássico 55¢+42¢', () => {
  const engine = createPairGateEngine({
    ...DEFAULT_PARAMS,
    esperaLimiteC: 99,
    maxEventNotional: 20,
  });
  const r = play(engine, [
    { tau: 120, up: 0.55, dn: 0.42 },
    { tau: 119, up: 0.55, dn: 0.42 },
    { tau: 118, up: 0.55, dn: 0.42 },
  ]);
  assert.equal(r.fills.length, 0);
  assert.ok(Object.keys(r.skipCounts).some((k) => k.startsWith('SKIP_C2')));
});

test('C2: proj alto → SKIP_C2 e não abre', () => {
  const engine = createPairGateEngine({
    ...BASE,
    hedgeAskMax: 0.48,
    epsCents: 3,
    bufferCents: 2,
  });
  const r = play(engine, [
    { tau: 100, up: 0.56, dn: 0.48 },
    { tau: 99, up: 0.56, dn: 0.48 },
    { tau: 98, up: 0.56, dn: 0.48 },
  ]);
  assert.equal(r.fills.length, 0);
  assert.ok(Object.keys(r.skipCounts).some((k) => k.startsWith('SKIP_C2')));
});

test('path feliz: open + hedge → done com avgSum < 1', () => {
  const engine = createPairGateEngine({ ...BASE, hedgeAskMax: 0.39 });
  const r = play(
    engine,
    [
      { tau: 120, up: 0.55, dn: 0.39 },
      { tau: 119, up: 0.55, dn: 0.39 },
      { tau: 118, up: 0.55, dn: 0.39 },
      { tau: 117, up: 0.55, dn: 0.39 },
    ],
    'UP',
  );
  assert.equal(r.mode, 'done');
  assert.equal(r.residual.shares, 0);
  assert.equal(r.fills.filter((f) => f.kind === 'open').length, 1);
  assert.equal(r.fills.filter((f) => f.kind === 'hedge').length, 1);
  assert.ok(r.avgSum != null && r.avgSum < 1);
  assert.ok(r.pnl > 0, `expected +pnl, got ${r.pnl}`);
});

test('OPEN_MISS por cap não gasta openAttempts', () => {
  const engine = createPairGateEngine({
    ...BASE,
    hedgeAskMax: 0.39,
    openCapCents: 1,
    T_hedge_sec: 60, // não abortar no meio do teste
  });
  let ts = 0;
  for (const t of [
    { tau: 120, up: 0.55, dn: 0.39 },
    { tau: 119, up: 0.58, dn: 0.39 }, // miss
    { tau: 118, up: 0.55, dn: 0.39 }, // re-decide
    { tau: 117, up: 0.55, dn: 0.39 }, // fill
  ]) {
    ts += 1;
    engine.onTick({ tau: t.tau, upAsk: t.up, downAsk: t.dn, ts });
  }
  const misses = engine.state.events.filter((e) => e.kind === 'OPEN_MISS');
  assert.ok(misses.length >= 1);
  assert.equal(engine.state.openAttempts, 1);
  assert.equal(engine.state.mode, 'open');
});

test('proíbe segundo open no mesmo evento', () => {
  const engine = createPairGateEngine({
    ...BASE,
    hedgeAskMax: 0.39,
    T_hedge_sec: 60,
  });
  let ts = 0;
  for (const t of [
    { tau: 120, up: 0.55, dn: 0.5 },
    { tau: 119, up: 0.55, dn: 0.5 },
    { tau: 118, up: 0.55, dn: 0.5 },
    { tau: 117, up: 0.55, dn: 0.5 },
  ]) {
    ts += 1;
    engine.onTick({ tau: t.tau, upAsk: t.up, downAsk: t.dn, ts });
  }
  assert.equal(engine.state.mode, 'open');
  assert.equal(engine.state.fills.filter((f) => f.kind === 'open').length, 1);
  assert.equal(engine.state.fills.filter((f) => f.kind === 'hedge').length, 0);
});

test('hedge re-gate: avgOpen alto → não hedgeia', () => {
  const engine = createPairGateEngine({
    ...BASE,
    openAskHi: 0.7,
    hedgeAskMax: 0.42,
    epsCents: 2,
    bufferCents: 1,
  });
  // open pode ser SKIP_C2; se abrir a 0.62, hedge @0.35 ainda falha re-gate
  const r = play(engine, [
    { tau: 120, up: 0.62, dn: 0.35 },
    { tau: 119, up: 0.62, dn: 0.35 },
    { tau: 118, up: 0.62, dn: 0.35 },
    { tau: 117, up: 0.62, dn: 0.35 },
  ]);
  assert.equal(r.fills.filter((f) => f.kind === 'hedge').length, 0);
});

test('abort por timeout da perna nua', () => {
  const engine = createPairGateEngine({
    ...BASE,
    hedgeAskMax: 0.39,
    T_hedge_sec: 3,
    abortPreferSell: true,
    holdOnlyIfDust: false,
  });
  // dn sempre 0.50 → hedge ask > max; timeout vende
  const r = play(engine, [
    { tau: 120, up: 0.55, dn: 0.5, dt: 1 },
    { tau: 119, up: 0.55, dn: 0.5, dt: 1 },
    { tau: 118, up: 0.55, dn: 0.5, dt: 1 },
    { tau: 117, up: 0.55, dn: 0.5, dt: 1 },
    { tau: 116, up: 0.55, dn: 0.5, dt: 1 },
    { tau: 115, up: 0.55, dn: 0.5, dt: 1 },
  ]);
  assert.equal(r.mode, 'aborted');
  assert.ok(r.events.some((e) => e.kind === 'ABORT' && e.reason === 'timeout'));
});

test('espera abertura >70¢ bloqueia até gatilho', () => {
  const engine = createPairGateEngine({
    ...BASE,
    esperaLimiteC: 70,
    esperaGatilhoC: 55,
  });
  const r = play(engine, [
    { tau: 200, up: 0.78, dn: 0.22 },
    { tau: 199, up: 0.78, dn: 0.22 },
    { tau: 198, up: 0.7, dn: 0.3 },
  ]);
  assert.equal(r.fills.length, 0);
  assert.ok(Object.keys(r.skipCounts).some((k) => k.includes('espera')));
});
