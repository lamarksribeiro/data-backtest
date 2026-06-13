import assert from 'node:assert/strict';
import test from 'node:test';

import { getEdgeSniperV2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { loadPreset, listPresets } from '../labs/shared/presets.js';
import { renderPresetGls } from '../labs/shared/renderPresetGls.js';

test('listPresets loads edge-sniper-v2 winners', () => {
  const presets = listPresets();
  assert.ok(presets.length >= 5);
  assert.ok(presets.some((item) => item.id === 'near-default-loose'));
});

test('loadPreset merges defaults with overrides', () => {
  const { preset, params } = loadPreset('near-default-loose');
  assert.equal(preset.studioSlug, 'esv2-near-default-loose');
  assert.equal(params.entryWindowStart, 180);
  assert.equal(params.walletSize, 100);
  assert.equal(params.minDistanceAbs, 40);
});

test('renderPresetGls patches param defaults in source', () => {
  const source = getEdgeSniperV2GlsSource();
  const rendered = renderPresetGls(source, {
    entryWindowStart: 180,
    minDistanceAbs: 40,
    minEdge: 0,
  }, 'Edge Sniper V2 · Test');
  assert.match(rendered, /strategy "Edge Sniper V2 · Test"/);
  assert.match(rendered, /param entryWindowStart = 180/);
  assert.match(rendered, /param minDistanceAbs = 40/);
  assert.match(rendered, /param minEdge = 0/);
});
