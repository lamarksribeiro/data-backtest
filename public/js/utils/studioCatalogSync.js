import { invalidateStrategyPickerCache } from './strategyPicker.js';
import { cacheInvalidate } from './apiCache.js';

/** @type {(() => void | Promise<void>) | null} */
let studioRefreshCallback = null;

/** @type {(() => void | Promise<void>) | null} */
let strategiesRefreshCallback = null;

export function registerStudioRefresh(callback) {
  studioRefreshCallback = callback;
}

export function registerStrategiesRefresh(callback) {
  strategiesRefreshCallback = callback;
}

function invokeRefresh(callback, label) {
  if (!callback) return;
  void Promise.resolve(callback()).catch((err) => {
    console.error(`${label} refresh failed:`, err);
  });
}

/** Invalida caches do Estúdio e atualiza a tela se ela estiver montada. */
export function notifyStudioCatalogChanged() {
  invalidateStrategyPickerCache();
  cacheInvalidate('runs');
  invokeRefresh(studioRefreshCallback, 'studio catalog');
}

/** Invalida caches de runs/stats e atualiza Estúdio e Estratégias se montados. */
export function notifyRunDataChanged() {
  cacheInvalidate('runs');
  invokeRefresh(studioRefreshCallback, 'studio runs');
  invokeRefresh(strategiesRefreshCallback, 'strategies runs');
}
