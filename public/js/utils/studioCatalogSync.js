import { invalidateStrategyPickerCache } from './strategyPicker.js';
import { cacheInvalidate } from './apiCache.js';

/** @type {(() => void | Promise<void>) | null} */
let studioRefreshCallback = null;

export function registerStudioRefresh(callback) {
  studioRefreshCallback = callback;
}

/** Invalida caches do Estúdio e atualiza a tela se ela estiver montada. */
export function notifyStudioCatalogChanged() {
  invalidateStrategyPickerCache();
  cacheInvalidate('runs');
  if (!studioRefreshCallback) return;
  void Promise.resolve(studioRefreshCallback()).catch((err) => {
    console.error('studio catalog refresh failed:', err);
  });
}
