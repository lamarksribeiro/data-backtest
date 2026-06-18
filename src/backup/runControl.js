/** @type {Map<string, { isCancelled: () => boolean, cancel: () => void }>} */
const runControllers = new Map();

export function registerTelegramRunControl(runId) {
  let cancelled = false;
  const control = {
    isCancelled: () => cancelled,
    cancel: () => { cancelled = true; },
  };
  runControllers.set(runId, control);
  return control;
}

export function releaseTelegramRunControl(runId) {
  runControllers.delete(runId);
}

export function requestCancelTelegramRun(runId) {
  const control = runControllers.get(runId);
  if (!control) return false;
  control.cancel();
  return true;
}

export function cancelAllTelegramRunControls() {
  for (const control of runControllers.values()) {
    control.cancel();
  }
}

export function listActiveTelegramRunControlIds() {
  return [...runControllers.keys()];
}
