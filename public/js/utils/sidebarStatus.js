import { fetchHealthzCached } from './healthzCache.js';

let pollTimer = null;

export function startSidebarStatus(ctx) {
  refreshSidebarStatus(ctx);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => refreshSidebarStatus(ctx), 15_000);
}

export async function refreshSidebarStatus(ctx) {
  try {
    const { ok, body } = await fetchHealthzCached();
    if (!ok) {
      ctx.setConnection('err', 'Serviço indisponível');
      return;
    }
    const manifest = body.manifest || {};
    const partitions = manifest.partitions ?? 0;
    const valid = manifest.by_status?.valid ?? 0;
    ctx.setConnection('ok', partitions
      ? `${valid}/${partitions} partições válidas`
      : 'Lakehouse ok · sem partições');
  } catch {
    ctx.setConnection('err', 'Sem conexão ao servidor');
  }
}
