import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WALK_FORWARD_FOLDS,
  selectTrainingVariant,
} from '../scripts/run-escada-adaptativa-walk-forward.js';

function inclusiveDays(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000) + 1;
}

test('walk-forward pré-registra dez folds de 21 dias + 7 dias sem sobreposição', () => {
  assert.equal(WALK_FORWARD_FOLDS.length, 10);
  for (const fold of WALK_FORWARD_FOLDS) {
    assert.equal(inclusiveDays(fold.trainFrom, fold.trainTo), 21);
    assert.equal(inclusiveDays(fold.validateFrom, fold.validateTo), 7);
    assert.ok(Date.parse(fold.validateFrom) > Date.parse(fold.trainTo));
  }
});

test('seletor elimina variante que viola o risco antes de comparar PnL', () => {
  const variants = [
    {
      id: 'unsafe',
      params: { minEdge: 0.04 },
      summary: {
        totalPnl: 100,
        maxObservedWorstLoss: 2.51,
        maxDrawdown: 1,
        entries: 70,
        daily: { days: 7, series: [{ pnl: 100 }] },
      },
    },
    {
      id: 'safe',
      params: { minEdge: 0.06 },
      summary: {
        totalPnl: 2,
        maxObservedWorstLoss: 2.5,
        maxDrawdown: 1,
        entries: 70,
        daily: { days: 7, series: [{ pnl: 2 }] },
      },
    },
  ];
  assert.equal(selectTrainingVariant(variants)?.id, 'safe');
});

test('desempate do treino prefere menor drawdown', () => {
  const variants = [
    {
      id: 'drawdown-high',
      summary: {
        totalPnl: 10,
        maxObservedWorstLoss: 2.5,
        maxDrawdown: 5,
        daily: { days: 2, series: [{ pnl: 1 }, { pnl: 1 }] },
      },
    },
    {
      id: 'drawdown-low',
      summary: {
        totalPnl: 10,
        maxObservedWorstLoss: 2.5,
        maxDrawdown: 2,
        daily: { days: 2, series: [{ pnl: 1 }, { pnl: 1 }] },
      },
    },
  ];
  assert.equal(selectTrainingVariant(variants)?.id, 'drawdown-low');
});
