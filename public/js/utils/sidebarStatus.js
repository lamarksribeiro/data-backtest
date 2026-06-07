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
    const usable = manifest.usable ?? ((manifest.by_status?.valid ?? 0) + (manifest.by_status?.accepted ?? 0));
    const warnings = manifest.warnings ?? (manifest.by_status?.accepted ?? 0);
    const suffix = warnings ? ` · ${warnings} com aviso` : '';
    ctx.setConnection('ok', partitions
      ? `${usable}/${partitions} partições prontas${suffix}`
      : 'Lakehouse ok · sem partições');
  } catch {
    ctx.setConnection('err', 'Sem conexão ao servidor');
  }
}
