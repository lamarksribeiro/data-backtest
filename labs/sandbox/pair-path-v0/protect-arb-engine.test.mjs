import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProtectArbEngine,
  protectCosts,
  evaluateProtectTriggers,
  VARIANT_PRESETS,
  feeFor,
} from './protect-arb-engine.mjs';

test('protectCosts prefers sell when bid is strong', () => {
  const c = protectCosts({
    openAvg: 0.57,
    bidOpen: 0.5,
    askOpp: 0.55,
    shares: 5,
  });
  // sell loss ~0.07; hedge loss ~0.57+0.55-1=0.12 → prefer sell
  assert.equal(c.prefer, 'sell');
  assert.ok(c.sellCostPerShare < c.hedgeCostPerShare);
});

test('protectCosts prefers hedge when opposite is cheap', () => {
  const c = protectCosts({
    openAvg: 0.57,
    bidOpen: 0.2,
    askOpp: 0.35,
    shares: 5,
  });
  // sell loss ~0.37; hedge ~0.57+0.35-1=-0.08 → prefer hedge
  assert.equal(c.prefer, 'hedge');
});

test('v0-naked keeps residual when hedge never arrives', () => {
  const eng = createProtectArbEngine({
    ...VARIANT_PRESETS['v0-naked'],
    openShares: 5,
    maxEventNotional: 8,
  });
  // open DOWN @0.57
  eng.onTick({ tau: 200, upAsk: 0.44, downAsk: 0.57, upBid: 0.43, downBid: 0.56 });
  assert.equal(eng.state.mode, 'opened');
  // market runs against — UP expensive
  for (let tau = 190; tau >= 5; tau -= 5) {
    eng.onTick({
      tau,
      upAsk: 0.9,
      downAsk: 0.12,
      upBid: 0.89,
      downBid: 0.1,
    });
  }
  const r = eng.finish('UP');
  assert.ok(r.residual >= 5 - 1e-6);
  assert.ok(r.pnl < 0);
  assert.equal(r.nProtectSell, 0);
  assert.equal(r.nProtectHedge, 0);
});

test('prot-min does not protect early on mild spread', () => {
  const eng = createProtectArbEngine({
    ...VARIANT_PRESETS['prot-min'],
    openShares: 5,
    maxEventNotional: 8,
    tauForceProtect: 20,
    protectTimeoutSec: 45,
    protectAdverseCents: 4,
  });
  eng.onTick({ tau: 200, upAsk: 0.44, downAsk: 0.57, upBid: 0.43, downBid: 0.56 });
  assert.equal(eng.state.mode, 'opened');
  // mild 1¢ drop — same as dry-run smoke; should wait
  eng.onTick({
    tau: 198,
    upAsk: 0.43,
    downAsk: 0.57,
    upBid: 0.42,
    downBid: 0.57,
  });
  const r = eng.finish('UP');
  assert.equal(r.nProtectSell, 0);
  assert.equal(r.nProtectHedge, 0);
  assert.ok(r.residual >= 5 - 1e-6);
});

test('prot-min protects after timeout without cheap hedge', () => {
  const eng = createProtectArbEngine({
    ...VARIANT_PRESETS['prot-min'],
    openShares: 5,
    maxEventNotional: 8,
    protectTimeoutSec: 45,
    tauForceProtect: 5,
  });
  eng.onTick({ tau: 200, upAsk: 0.44, downAsk: 0.57, upBid: 0.43, downBid: 0.56 });
  assert.equal(eng.state.mode, 'opened');
  for (let tau = 195; tau >= 150; tau -= 5) {
    eng.onTick({
      tau,
      upAsk: 0.44,
      downAsk: 0.57,
      upBid: 0.43,
      downBid: 0.56,
    });
  }
  const r = eng.finish('UP');
  assert.ok(r.nProtectSell + r.nProtectHedge >= 1);
  assert.ok(r.residual < 1e-6);
});

test('prot-min chooses sell when bid better than expensive hedge', () => {
  const eng = createProtectArbEngine({
    ...VARIANT_PRESETS['prot-min'],
    openShares: 5,
    maxEventNotional: 8,
    tauForceProtect: 50,
  });
  eng.onTick({ tau: 200, upAsk: 0.44, downAsk: 0.57, upBid: 0.43, downBid: 0.56 });
  assert.equal(eng.state.mode, 'opened');
  // adverse: DOWN bid still 0.40, UP ask 0.70 → sell better than hedge
  eng.onTick({
    tau: 40,
    upAsk: 0.7,
    downAsk: 0.32,
    upBid: 0.69,
    downBid: 0.4,
  });
  const r = eng.finish('UP');
  assert.ok(r.nProtectSell >= 1, `sell=${r.nProtectSell} hedge=${r.nProtectHedge}`);
  assert.ok(r.residual < 1e-6, `residual=${r.residual}`);
});

test('prot-min chooses hedge when opposite is cheaper than sell', () => {
  const eng = createProtectArbEngine({
    ...VARIANT_PRESETS['prot-min'],
    openShares: 5,
    maxEventNotional: 12,
    tauForceProtect: 50,
  });
  eng.onTick({ tau: 200, upAsk: 0.44, downAsk: 0.57, upBid: 0.43, downBid: 0.56 });
  assert.equal(eng.state.mode, 'opened');
  // DOWN collapsed — bid 0.05; UP ask 0.50 → hedge cost better than sell
  eng.onTick({
    tau: 40,
    upAsk: 0.5,
    downAsk: 0.52,
    upBid: 0.49,
    downBid: 0.05,
  });
  const r = eng.finish('UP');
  assert.ok(r.nProtectHedge >= 1, `expected protect_hedge got sell=${r.nProtectSell}`);
  assert.ok(r.residual < 1e-6);
});

test('force protect at low tau even with avgSum > 1', () => {
  const eng = createProtectArbEngine({
    ...VARIANT_PRESETS['prot-hedge'],
    openShares: 5,
    maxEventNotional: 20,
    tauForceProtect: 20,
    protectAvgSumMax: 1.0,
  });
  eng.onTick({ tau: 200, upAsk: 0.44, downAsk: 0.57, upBid: 0.43, downBid: 0.56 });
  eng.onTick({
    tau: 15,
    upAsk: 0.8,
    downAsk: 0.22,
    upBid: 0.79,
    downBid: 0.2,
  });
  const r = eng.finish('UP');
  assert.ok(r.nProtectHedge >= 1);
  assert.ok(r.residual < 1e-6);
});

test('arb-atomic rejects sum above 1-eps after fees', () => {
  const eng = createProtectArbEngine({
    ...VARIANT_PRESETS['arb-atomic'],
    openShares: 5,
  });
  eng.onTick({ tau: 200, upAsk: 0.55, downAsk: 0.48, upBid: 0.54, downBid: 0.47 });
  assert.equal(eng.state.mode, 'idle');
  const r = eng.finish(null);
  assert.ok((r.blockCounts.ATOMIC_NOT_CHEAP || 0) >= 1);
});

test('arb-atomic fills both legs when pair is cheap', () => {
  const eng = createProtectArbEngine({
    ...VARIANT_PRESETS['arb-atomic'],
    openShares: 5,
    maxEventNotional: 10,
    atomicEps: 0.02,
  });
  // 0.40+0.40 + fees ≈ 0.80 + ~0.033 < 0.98
  eng.onTick({ tau: 200, upAsk: 0.4, downAsk: 0.4, upBid: 0.39, downBid: 0.39 });
  assert.equal(eng.state.mode, 'done');
  const r = eng.finish('UP');
  assert.ok(r.residual < 1e-6);
  assert.ok(r.pnl > 0);
});

test('feeFor matches crypto formula', () => {
  const f = feeFor(0.55, 5, 0.07);
  assert.ok(Math.abs(f - 0.07 * 0.55 * 0.45 * 5) < 1e-9);
});

test('good path: open + cheap hedge equalizes without protect', () => {
  const eng = createProtectArbEngine({
    ...VARIANT_PRESETS['prot-min'],
    openShares: 5,
    maxEventNotional: 8,
  });
  eng.onTick({ tau: 180, upAsk: 0.56, downAsk: 0.45, upBid: 0.55, downBid: 0.44 });
  assert.equal(eng.state.sideOpen, 'UP');
  eng.onTick({ tau: 160, upAsk: 0.62, downAsk: 0.38, upBid: 0.61, downBid: 0.37 });
  const r = eng.finish('UP');
  assert.ok(r.residual < 1e-6);
  assert.equal(r.nProtectSell, 0);
  assert.ok(r.fills.some((f) => f.kind === 'hedge'));
  assert.ok(r.pnl > 0);
});
