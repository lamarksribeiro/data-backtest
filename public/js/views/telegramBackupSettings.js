import { el, mount, emptyState } from '../utils/dom.js';
import { confirmDialog, customDialog, phraseConfirmDialog } from '../utils/confirm.js';
import { renderSettingsPage } from './settingsTabs.js';
import { listedUnderlyings } from '../../shared/underlyingAssets.js';

const POLL_INTERVAL_MS = 2000;
/** @type {{ timer: ReturnType<typeof setInterval> | null, runId: string | null, panelEl: HTMLElement | null }} */
const activePoll = { timer: null, runId: null, panelEl: null };

export async function renderTelegramBackupSettings(ctx) {
  ctx.setBreadcrumb('settings', 'Backup Telegram');
  ctx.renderContextBar?.();

  mount(ctx.contentEl, buildBackupLoadingShell());
  await refreshTelegramBackupSettings(ctx);
}

function buildBackupLoadingShell() {
  return renderSettingsPage('backup', el('div', { class: 'backup-page' }, [
    el('section', { class: 'card' }, el('p', { class: 'muted' }, 'Carregando…')),
  ]));
}

async function refreshTelegramBackupSettings(ctx) {
  const [settingsRes, runsRes] = await Promise.all([
    ctx.api.get('/api/settings/telegram-backup'),
    ctx.api.get('/api/backup/telegram/runs?limit=15'),
  ]);
  if (!settingsRes.ok) {
    mount(ctx.contentEl, el('p', { class: 'bad' }, settingsRes.error?.message || 'Falha ao carregar backup'));
    return;
  }
  const runs = runsRes.ok ? runsRes.data.runs : [];

  renderTelegramBackupPage(ctx, settingsRes.data, runs);

  const active = runs.find((r) => r.status === 'queued' || r.status === 'running');
  if (active) {
    attachProgressPanel(ctx, active.id, active.request?.kind === 'restore' ? 'restore' : 'backup');
    startPolling(ctx, active.id);
  }
}

function renderTelegramBackupPage(ctx, data, runs) {
  const settings = data.settings || {};
  const baseline = data.incremental_baseline || { ready: false };
  const timezoneLabel = formatSchedulerTimezoneLabel(data.scheduler_timezone);
  const lastRun = data.last_run;
  const channelCatalog = data.channel_catalog;
  const completedRuns = runs.filter((r) => r.status === 'completed' && r.result?.master_catalog?.file_id);
  const statusBadge = !settings.configured
    ? ['warn', 'Não configurado']
    : settings.enabled
      ? ['ok', 'Ativo']
      : ['warn', 'Desligado'];

  const formState = {
    enabled: settings.enabled,
    bot_token: '',
    chat_id: settings.chat_id || '',
    auto_after_asset_sync: settings.auto_after_asset_sync,
    auto_schedule_enabled: settings.auto_schedule_enabled,
    auto_schedule_time_utc: settings.auto_schedule_time_utc || '04:00',
    pin_master_catalog: settings.pin_master_catalog,
    incremental_default: settings.incremental_default,
    silent_uploads: settings.silent_uploads,
    max_chunk_mb: settings.max_chunk_mb || 18,
    rate_limit_ms: settings.rate_limit_ms || 3000,
  };

  const progressSlot = el('div', { id: 'backup-progress-slot' });

  mount(ctx.contentEl, renderSettingsPage('backup', [
    el('div', { class: 'backup-page' }, [
      renderBackupAlertBanner(settings, baseline),
      el('div', { class: 'backup-config-split' }, [
        renderConnectionCard(formState, settings, ctx, statusBadge),
        renderBehaviorCard(formState, timezoneLabel),
      ]),
      renderConfigFooter(ctx, formState),
      el('div', { class: 'backup-ops-split' }, [
        renderOperationsCard(ctx, {
          settings,
          baseline,
          lastRun,
          channelCatalog,
          completedRuns,
          progressSlot,
        }),
        renderHistoryCard(ctx, runs, completedRuns, channelCatalog),
      ]),
    ]),
  ]));

  activePoll.panelEl = document.getElementById('backup-progress-slot');
}

function renderBackupAlertBanner(settings, baseline) {
  const alerts = [];
  if (settings.configured && !settings.enabled) {
    alerts.push(el('div', { class: 'backup-alert backup-alert--warn' }, [
      el('strong', {}, 'Backup desligado'),
      el('span', {}, ' — automações estão desligadas. Marque “Backup habilitado” e salve para reativar o agendamento. O envio manual pelo botão “Iniciar backup” continua disponível.'),
    ]));
  }
  if (!baseline.ready) {
    alerts.push(el('div', { class: 'backup-alert backup-alert--info' }, [
      el('strong', {}, 'Sem baseline incremental local'),
      el('span', {}, ' — após limpar histórico ou primeiro envio, o próximo backup será completo (todas as partições + catálogos).'),
    ]));
  }
  if (!alerts.length) return null;
  return el('div', { class: 'backup-alerts' }, alerts);
}

function sectionHead(title, hint) {
  return el('div', { class: 'settings-card__head' }, [
    el('h2', { class: 'card__title' }, title),
    hint ? el('p', { class: 'card__sub' }, hint) : null,
  ]);
}

function renderConfigFooter(ctx, formState) {
  return el('div', { class: 'backup-config-footer' }, [
    el('p', { class: 'field__hint' }, 'Conexão e comportamento são salvos juntos.'),
    el('div', { class: 'backup-config-footer__actions' }, [
      el('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => testConnection(ctx) }, 'Testar conexão'),
      el('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => saveSettings(ctx, formState) }, 'Salvar configurações'),
    ]),
  ]);
}

function renderConnectionCard(formState, settings, ctx, statusBadge) {
  const enabledInput = el('input', { type: 'checkbox' });
  enabledInput.checked = formState.enabled;
  enabledInput.onchange = () => { formState.enabled = enabledInput.checked; };

  const tokenInput = el('input', { type: 'password', class: 'field__input', placeholder: settings.bot_token_set ? settings.bot_token : '123456789:ABC...', autocomplete: 'off' });
  tokenInput.oninput = () => { formState.bot_token = tokenInput.value; };

  const chatInput = el('input', { type: 'text', class: 'field__input', value: formState.chat_id, placeholder: '-100xxxxxxxxxx' });
  chatInput.oninput = () => { formState.chat_id = chatInput.value; };

  return el('section', { class: 'card backup-card' }, [
    el('div', { class: 'settings-card__head settings-card__head--row' }, [
      el('div', {}, [
        el('h2', { class: 'card__title' }, 'Conexão Telegram'),
        el('p', { class: 'card__sub' }, 'Bot no @BotFather, canal privado e credenciais.'),
      ]),
      el('span', { class: `badge badge--${statusBadge[0]}` }, statusBadge[1]),
    ]),
    el('form', {
      class: 'backup-form',
      onsubmit: (event) => event.preventDefault(),
    }, [
      toggleRow('Backup habilitado', 'Envio automático e manual.', enabledInput, { compact: true }),
      el('div', { class: 'backup-form__row' }, [
        field('Token do bot', passwordField(tokenInput), 'Em branco = manter o token salvo.'),
        field('Chat ID do canal', chatInput, 'ID numérico (-100…) ou @canal.'),
      ]),
    ]),
  ]);
}

function renderBehaviorCard(formState, timezoneLabel) {
  return el('section', { class: 'card backup-card' }, [
    sectionHead('Comportamento', 'Automação e preferências de envio.'),
    el('div', { class: 'backup-toggle-grid' }, behaviorToggles(formState, timezoneLabel)),
    el('details', { class: 'backup-advanced' }, [
      el('summary', {}, 'Avançado'),
      el('div', { class: 'backup-advanced__body' }, [
        el('div', { class: 'backup-form__row' }, [
          field('Chunk máximo (MB)', numberInput(formState, 'max_chunk_mb'), 'Padrão 18 MB.'),
          field('Intervalo entre uploads (ms)', numberInput(formState, 'rate_limit_ms'), 'Padrão 3000 ms.'),
        ]),
      ]),
    ]),
  ]);
}

function renderOperationsCard(ctx, { settings, baseline, lastRun, channelCatalog, completedRuns, progressSlot }) {
  const busy = Boolean(activePoll.runId);
  const configured = settings.configured;
  const channelFound = Boolean(channelCatalog?.ok && channelCatalog?.master_file_id);
  const canRestore = configured && !busy && (channelFound || completedRuns.length > 0);

  return el('section', { class: 'card backup-ops-card' }, [
    sectionHead('Operações', 'Envie, restaure ou interrompa o backup no canal.'),
    progressSlot,
    el('div', { class: 'backup-ops-toolbar' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        disabled: !configured || busy,
        onclick: () => openBackupStartModal(ctx, settings, baseline),
      }, 'Iniciar backup'),
      busy ? el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm btn--danger',
        onclick: () => cancelActiveBackup(ctx, activePoll.runId),
      }, 'Cancelar operação') : null,
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        disabled: !canRestore,
        onclick: () => openRestoreModal(ctx, {
          lastRun,
          completedRuns,
          channelCatalog,
          preselectSource: channelFound && !lastRun ? 'channel' : null,
        }),
      }, 'Restaurar'),
      configured ? el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        disabled: busy,
        onclick: () => discoverChannelBackups(ctx),
      }, 'Atualizar detecção') : null,
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm btn--danger',
        onclick: () => stopAndResetBackup(ctx),
      }, 'Parar e limpar tudo'),
    ].filter(Boolean)),
    renderBackupStatusCard(settings, channelCatalog, lastRun),
  ]);
}

function renderHistoryCard(ctx, runs, completedRuns, channelCatalog) {
  const hasRuns = runs.length > 0;

  return el('section', { class: 'card' }, [
    el('div', { class: 'card__header' }, [
      el('div', {}, [
        el('h2', { class: 'card__title' }, 'Histórico'),
        el('p', { class: 'backup-hint' }, hasRuns
          ? 'Clique em um run concluído para restaurar a partir dele.'
          : 'Nenhum run nesta instalação — use Restaurar para recuperar do canal.'),
      ]),
      el('div', { class: 'backup-history-actions' }, [
        hasRuns ? el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm btn--danger',
          onclick: () => clearLocalBackupHistory(ctx),
        }, 'Limpar histórico') : null,
      ].filter(Boolean)),
    ]),
    hasRuns
      ? el('div', { class: 'backup-history-list' }, runs.map((run) => renderRunRow(run, ctx, completedRuns, channelCatalog)))
      : emptyState('Nenhum backup ou restore registrado nesta instalação.'),
  ]);
}

function renderBackupStatusCard(settings, channelCatalog, lastRun) {
  if (!settings.configured) {
    return statusPanel('neutral', 'Canal não configurado', 'Informe token e chat_id, salve e teste a conexão.');
  }

  const channelFound = Boolean(channelCatalog?.ok && channelCatalog?.master_file_id);
  const localBackup = lastRun?.request?.kind !== 'restore' ? lastRun : null;
  const sameBackup = channelFound && localBackup
    && channelCatalog.backup_run_id
    && localBackup.id === channelCatalog.backup_run_id;

  if (channelFound) {
    const assets = channelCatalog.underlyings?.length
      ? channelCatalog.underlyings.join(', ')
      : (channelCatalog.asset_count != null ? `${channelCatalog.asset_count} ativo(s)` : '—');
    const sub = [
      channelCatalog.chat_title || null,
      channelCatalog.source === 'pinned' ? 'catálogo fixado' : 'catálogo detectado',
      channelCatalog.discovered_at ? `visto ${formatDateTime(channelCatalog.discovered_at)}` : null,
    ].filter(Boolean).join(' · ');

    return statusPanel('found', 'Backup disponível no canal', sub, [
      statusStat('Run', channelCatalog.backup_run_id || '—'),
      statusStat('Data', channelCatalog.created_at ? formatDateTime(channelCatalog.created_at) : '—'),
      statusStat('Partições', channelCatalog.partition_count != null ? String(channelCatalog.partition_count) : '—'),
      statusStat('Ativos', assets),
    ], sameBackup && localBackup?.result?.stats
      ? `Último envio nesta instalação: ${localBackup.result.stats.uploaded ?? 0} partições enviadas.`
      : null);
  }

  if (localBackup) {
    return statusPanel('neutral', 'Último backup nesta instalação', null, [
      statusStat('Run', localBackup.id),
      statusStat('Concluído', formatDateTime(localBackup.completed_at || localBackup.created_at)),
      statusStat('Enviados', String(localBackup.result?.stats?.uploaded ?? '—')),
      statusStat('Pulados', String(localBackup.result?.stats?.skipped ?? '—')),
    ], 'Nenhum catálogo fixado detectado no canal. Fixe o master_catalog ou use file_id manual no restore.');
  }

  return statusPanel(
    'missing',
    'Nenhum backup detectado',
    channelCatalog?.message || 'Fixe o master_catalog.json no canal ou rode o primeiro backup.',
  );
}

function statusPanel(tone, title, sub, stats = null, footnote = null) {
  const toneClass = tone === 'found' ? 'is-found' : (tone === 'missing' ? 'is-missing' : '');
  return el('div', { class: `backup-status-panel ${toneClass}`.trim(), style: { marginTop: '16px' } }, [
    el('div', { class: 'backup-status-panel__head' }, [
      el('p', { class: 'backup-status-panel__title' }, title),
      sub ? el('p', { class: 'backup-status-panel__sub' }, sub) : null,
    ]),
    stats ? el('div', { class: 'backup-status-grid' }, stats) : null,
    footnote ? el('p', { class: 'backup-hint', style: { margin: 0 } }, footnote) : null,
  ]);
}

function statusStat(label, value) {
  return el('div', { class: 'backup-status-stat' }, [
    el('span', { class: 'backup-status-stat__label' }, label),
    el('span', { class: 'backup-status-stat__value' }, value),
  ]);
}

function renderRunRow(run, ctx, completedRuns, channelCatalog) {
  let statusClass = 'idle';
  if (run.status === 'completed') statusClass = 'ok';
  else if (run.status === 'failed') statusClass = 'err';
  else if (run.status === 'cancelled') statusClass = 'idle';
  else if (run.status === 'running' || run.status === 'queued') statusClass = 'warn';

  const isRestore = run.request?.kind === 'restore';
  const label = isRestore ? 'restore' : run.mode;
  const statsText = run.result?.stats
    ? `↑ ${run.result.stats.uploaded} enviados · ↷ ${run.result.stats.skipped} pulados${run.result.stats.errors ? ` · ✕ ${run.result.stats.errors} falhas` : ''}${run.result.stats.catalogs_reused ? ` · cat. reutilizados ${run.result.stats.catalogs_reused}` : ''}`
    : run.result?.restored
      ? `${run.result.restored.partitions} partições restauradas`
      : run.error || null;

  return el('div', {
    class: `backup-run-row backup-run-row--${statusClass}`,
    onclick: () => {
      if (run.status === 'running' || run.status === 'queued') {
        attachProgressPanel(ctx, run.id, isRestore ? 'restore' : 'backup');
        startPolling(ctx, run.id);
        return;
      }
      if (run.status === 'completed' && run.result?.master_catalog?.file_id) {
        openRestoreModal(ctx, { lastRun: run, completedRuns, channelCatalog, preselectRunId: run.id });
      }
    },
  }, [
    el('div', { class: 'backup-run-row__main' }, [
      el('div', { class: 'backup-run-row__top' }, [
        el('code', { class: 'backup-run-row__id' }, run.id),
        el('span', { class: 'backup-run-row__meta' }, `${label} · ${formatDateTime(run.completed_at || run.created_at)}`),
      ]),
      statsText ? el('span', { class: 'backup-run-row__stats' }, statsText) : null,
    ]),
    el('span', { class: `badge badge--${statusClass} badge--compact` }, run.status),
  ]);
}

function attachProgressPanel(ctx, runId, kind) {
  const slot = document.getElementById('backup-progress-slot') || activePoll.panelEl;
  if (!slot) return;
  activePoll.runId = runId;
  activePoll.panelEl = slot;
  slot.replaceChildren(buildProgressCard(ctx, runId, kind, null));
}

function buildProgressCard(ctx, runId, kind, run) {
  const progress = run?.progress || {};
  const isRestore = kind === 'restore' || progress.kind === 'restore';
  const processed = Number(progress.processed || 0);
  const total = Number(progress.total || 0);
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : (run?.status === 'running' ? 5 : 0);
  const stats = progress.stats || run?.result?.stats;
  const statusLabel = run?.status || 'running';
  const statusTone = statusLabel === 'failed' ? 'err' : (statusLabel === 'cancelled' ? 'idle' : 'warn');

  return el('div', { class: 'backup-progress-card', id: 'backup-progress-card' }, [
    el('div', { class: 'backup-progress-card__head' }, [
      el('div', { class: 'backup-progress-card__title-wrap' }, [
        el('strong', {}, isRestore ? 'Restauração em andamento' : 'Backup em andamento'),
        el('span', { class: `badge badge--${statusTone} badge--compact` }, statusLabel),
      ]),
    ]),
    el('div', { class: 'backup-progress-bar' }, [el('span', { style: { width: `${pct}%` } })]),
    el('div', { class: 'backup-progress-meta' }, [
      el('div', {}, `Fase: ${formatPhase(progress.phase, isRestore)}`),
      total > 0 ? el('div', {}, `Progresso: ${processed} / ${total} (${pct}%)`) : el('div', {}, 'Calculando total de partições…'),
      progress.underlying ? el('div', {}, `Ativo: ${progress.underlying}${progress.dt ? ` · ${progress.dt}` : ''}`) : null,
      stats ? el('div', {}, `Enviados: ${stats.uploaded ?? 0} · Pulados: ${stats.skipped ?? 0} · Erros: ${stats.errors ?? 0}${stats.catalogs_reused ? ` · Catálogos reutilizados: ${stats.catalogs_reused}` : ''}`) : null,
      run?.error ? el('div', { class: 'backup-progress-error' }, run.error) : null,
      el('div', {}, ['Run: ', el('code', {}, runId)]),
    ]),
    (run?.status === 'queued' || run?.status === 'running' || !run) ? el('div', { class: 'backup-progress-card__footer' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm btn--danger',
        onclick: () => cancelActiveBackup(ctx, runId),
      }, 'Cancelar operação'),
    ]) : null,
  ]);
}

function updateProgressCard(ctx, run) {
  const card = document.getElementById('backup-progress-card');
  const slot = document.getElementById('backup-progress-slot');
  if (!slot || !card) return;
  const kind = run.request?.kind === 'restore' ? 'restore' : 'backup';
  slot.replaceChildren(buildProgressCard(ctx, run.id, kind, run));
}

function startPolling(ctx, runId) {
  if (activePoll.timer && activePoll.runId === runId) return;
  stopPolling();
  activePoll.runId = runId;

  const tick = async () => {
    const res = await ctx.api.get(`/api/backup/telegram/runs/${encodeURIComponent(runId)}`, { timeoutMs: 60_000 });
    if (!res.ok) return;
    const run = res.data.run;
    updateProgressCard(ctx, run);

    if (run.status === 'completed') {
      stopPolling();
      const isRestore = run.request?.kind === 'restore';
      if (isRestore) {
        const n = run.result?.restored?.partitions ?? 0;
        ctx.toast.ok(`Restore concluído — ${n} partições`);
      } else {
        ctx.toast.ok(`Backup concluído — ${run.result?.stats?.uploaded ?? 0} enviados`);
      }
      await refreshTelegramBackupSettings(ctx);
      return;
    }
    if (run.status === 'failed') {
      stopPolling();
      const uploaded = run.result?.stats?.uploaded ?? 0;
      const errors = run.result?.stats?.errors ?? 0;
      ctx.toast.err(run.error || (errors ? `Backup falhou — ${errors} partição(ões) com erro (${uploaded} enviadas)` : 'Operação falhou'));
      await refreshTelegramBackupSettings(ctx);
      return;
    }
    if (run.status === 'cancelled') {
      stopPolling();
      ctx.toast.ok('Operação cancelada');
      await refreshTelegramBackupSettings(ctx);
    }
  };

  void tick();
  activePoll.timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
}

function stopPolling() {
  if (activePoll.timer) {
    clearInterval(activePoll.timer);
    activePoll.timer = null;
  }
}

async function openBackupStartModal(ctx, settings, baseline = { ready: false }) {
  const state = {
    scope: 'single',
    underlying: 'BTC',
    incremental: baseline.ready ? settings.incremental_default : false,
    dryRun: false,
  };

  const underlyingSelect = el('select', { class: 'field__select' }, [
    ...listedUnderlyings().map((u) => el('option', { value: u }, u)),
  ]);
  underlyingSelect.value = state.underlying;
  underlyingSelect.onchange = () => { state.underlying = underlyingSelect.value; };

  const allRadio = el('input', { type: 'radio', name: 'backup-scope', value: 'all' });
  const singleRadio = el('input', { type: 'radio', name: 'backup-scope', value: 'single', checked: true });
  const incrementalCb = el('input', { type: 'checkbox' });
  incrementalCb.checked = state.incremental;
  incrementalCb.disabled = !baseline.ready;
  incrementalCb.onchange = () => { state.incremental = incrementalCb.checked; };
  const dryRunCb = el('input', { type: 'checkbox' });
  dryRunCb.onchange = () => { state.dryRun = dryRunCb.checked; };

  const underlyingWrap = el('label', { class: 'field' }, [
    el('span', {}, 'Ativo'),
    underlyingSelect,
  ]);

  function syncScope() {
    state.scope = allRadio.checked ? 'all' : 'single';
    underlyingWrap.style.display = state.scope === 'all' ? 'none' : 'flex';
  }
  allRadio.onchange = syncScope;
  singleRadio.onchange = syncScope;

  await customDialog({
    title: 'Iniciar backup',
    tone: 'primary',
    body: [
      el('p', { class: 'modal__message' }, 'Envia partições backtest_ticks válidas para o canal Telegram com catálogo recuperável.'),
      el('div', { class: 'backup-modal-options' }, [
        optionRow(singleRadio, 'Um ativo', 'Backup de um underlying específico.'),
        optionRow(allRadio, 'Todos os ativos', 'Inclui todas as combinações com partições válidas.'),
      ]),
      underlyingWrap,
      el('label', { class: 'backup-toggle', style: { marginTop: '8px' } }, [
        el('span', {}, 'Incremental (pular inalterados)'),
        incrementalCb,
      ]),
      !baseline.ready ? el('p', { class: 'backup-hint', style: { marginTop: '8px' } }, 'Histórico local vazio: o envio será completo, mesmo com incremental marcado.') : null,
      el('label', { class: 'backup-toggle' }, [
        el('span', {}, 'Dry-run (simular sem enviar)'),
        dryRunCb,
      ]),
    ],
    footer: [],
    onMount: (close) => {
      const overlay = document.querySelector('.modal-overlay');
      const footer = overlay?.querySelector('.modal__footer');
      if (!footer) return;
      footer.replaceChildren(
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => close(null) }, 'Cancelar'),
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          onclick: async () => {
            syncScope();
            close(null);
            await startBackup(ctx, state);
          },
        }, 'Iniciar'),
      );
    },
  });
}

async function startBackup(ctx, state) {
  const incremental = Boolean(state.incremental);
  const res = await ctx.api.post('/api/backup/telegram/runs', {
    underlying: state.scope === 'single' ? state.underlying : undefined,
    all_underlyings: state.scope === 'all',
    incremental,
    dry_run: state.dryRun,
    force: !incremental,
    manual: true,
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao iniciar backup');
    return;
  }
  ctx.toast.ok(state.dryRun ? 'Dry-run enfileirado' : 'Backup iniciado');
  attachProgressPanel(ctx, res.data.run_id, 'backup');
  startPolling(ctx, res.data.run_id);
}

async function openRestoreModal(ctx, { lastRun, completedRuns, channelCatalog, preselectRunId = null, preselectSource = null }) {
  const hasChannel = Boolean(channelCatalog?.ok && channelCatalog?.master_file_id);
  const defaultRun = preselectRunId
    ? completedRuns.find((r) => r.id === preselectRunId) || lastRun
    : (lastRun?.result?.master_catalog?.file_id ? lastRun : completedRuns[0]);

  let defaultSource = 'manual';
  if (preselectSource === 'channel' && hasChannel) defaultSource = 'channel';
  else if (defaultRun) defaultSource = 'last';
  else if (hasChannel) defaultSource = 'channel';
  else if (completedRuns.length) defaultSource = 'history';

  const state = {
    source: defaultSource,
    runId: defaultRun?.id || '',
    masterFileId: defaultSource === 'channel'
      ? (channelCatalog?.master_file_id || '')
      : (defaultRun?.result?.master_catalog?.file_id || channelCatalog?.master_file_id || ''),
    underlying: '',
    dryRun: false,
  };

  const lastRadio = el('input', { type: 'radio', name: 'restore-source', value: 'last' });
  const historyRadio = el('input', { type: 'radio', name: 'restore-source', value: 'history' });
  const channelRadio = el('input', { type: 'radio', name: 'restore-source', value: 'channel' });
  const manualRadio = el('input', { type: 'radio', name: 'restore-source', value: 'manual' });

  const runSelect = el('select', { class: 'field__select' }, completedRuns.map((r) => el('option', {
    value: r.id,
    'data-file-id': r.result?.master_catalog?.file_id || '',
  }, `${r.id} · ${formatDateTime(r.completed_at || r.created_at)}`)));
  if (state.runId) runSelect.value = state.runId;
  runSelect.onchange = () => {
    state.runId = runSelect.value;
    const opt = runSelect.selectedOptions[0];
    state.masterFileId = opt?.dataset?.fileId || '';
  };

  const fileIdInput = el('input', { type: 'text', class: 'field__input', value: state.masterFileId, placeholder: 'file_id do master_catalog.json' });
  fileIdInput.oninput = () => { state.masterFileId = fileIdInput.value.trim(); };

  const underlyingInput = el('input', { type: 'text', class: 'field__input', placeholder: 'Opcional — ex.: BTC' });
  underlyingInput.oninput = () => { state.underlying = underlyingInput.value.trim().toUpperCase(); };

  const dryRunCb = el('input', { type: 'checkbox' });
  dryRunCb.onchange = () => { state.dryRun = dryRunCb.checked; };

  const historyFields = el('div', { class: 'backup-restore-fields' }, [
    el('label', { class: 'field' }, [el('span', {}, 'Backup concluído'), runSelect]),
  ]);
  const manualFields = el('div', { class: 'backup-restore-fields' }, [
    el('label', { class: 'field' }, [el('span', {}, 'file_id do catálogo mestre'), fileIdInput]),
    el('p', { class: 'backup-hint' }, 'Use quando estiver restaurando em máquina nova sem histórico local. O file_id está na mensagem de resumo do backup no canal.'),
  ]);

  const channelFields = el('div', { class: 'backup-restore-fields' }, [
    el('p', { class: 'backup-hint', style: { margin: 0 } }, hasChannel
      ? [
        'Catálogo lido do canal',
        channelCatalog.backup_run_id ? ` (${channelCatalog.backup_run_id})` : '',
        channelCatalog.partition_count != null ? ` · ${channelCatalog.partition_count} partições` : '',
        channelCatalog.source === 'pinned' ? ' · fixado' : '',
      ].join('')
      : 'Indisponível — use “Atualizar detecção” ou file_id manual.'),
  ]);

  function syncSource() {
    state.source = lastRadio.checked ? 'last'
      : (historyRadio.checked ? 'history' : (channelRadio.checked ? 'channel' : 'manual'));
    historyFields.classList.toggle('is-visible', state.source === 'history');
    channelFields.classList.toggle('is-visible', state.source === 'channel');
    manualFields.classList.toggle('is-visible', state.source === 'manual');
    if (state.source === 'last' && defaultRun) {
      state.runId = defaultRun.id;
      state.masterFileId = defaultRun.result?.master_catalog?.file_id || '';
    }
    if (state.source === 'channel' && hasChannel) {
      state.masterFileId = channelCatalog.master_file_id;
    }
    if (state.source === 'history') {
      runSelect.dispatchEvent(new Event('change'));
    }
  }

  lastRadio.checked = state.source === 'last';
  historyRadio.checked = state.source === 'history';
  channelRadio.checked = state.source === 'channel';
  manualRadio.checked = state.source === 'manual';
  lastRadio.onchange = syncSource;
  historyRadio.onchange = syncSource;
  channelRadio.onchange = syncSource;
  manualRadio.onchange = syncSource;
  syncSource();
  state._syncSource = syncSource;

  if (!defaultRun) lastRadio.disabled = true;
  if (!completedRuns.length) historyRadio.disabled = true;
  if (!hasChannel) channelRadio.disabled = true;

  if (state.source === 'last' && lastRadio.disabled) {
    if (hasChannel) {
      channelRadio.checked = true;
      state.source = 'channel';
    } else if (completedRuns.length) {
      historyRadio.checked = true;
      state.source = 'history';
    } else {
      manualRadio.checked = true;
      state.source = 'manual';
    }
    syncSource();
  }

  await customDialog({
    title: 'Restaurar do Telegram',
    tone: 'danger',
    body: [
      el('p', { class: 'modal__message' }, 'Reconstrói Parquets locais e o manifest a partir do catálogo no canal. Dados atuais do lake serão sobrescritos.'),
      el('div', { class: 'backup-modal-options' }, [
        optionRow(lastRadio, 'Último backup concluído (local)', defaultRun
          ? `${defaultRun.id} · file_id disponível`
          : 'Indisponível nesta instalação'),
        optionRow(channelRadio, 'Backup detectado no canal', hasChannel
          ? `${channelCatalog.backup_run_id || 'master_catalog'} · ${channelCatalog.partition_count ?? '?'} partições`
          : 'Fixe master_catalog.json no canal ou atualize a detecção'),
        optionRow(historyRadio, 'Escolher do histórico local', `${completedRuns.length} backup(s) registrado(s) aqui`),
        optionRow(manualRadio, 'file_id manual', 'Cole o file_id do master_catalog.json'),
      ]),
      historyFields,
      channelFields,
      manualFields,
      el('label', { class: 'field', style: { marginTop: '8px' } }, [
        el('span', {}, 'Filtrar ativo (opcional)'),
        underlyingInput,
        el('span', { class: 'backup-hint' }, 'Deixe vazio para restaurar todos os ativos do catálogo.'),
      ]),
      el('label', { class: 'backup-toggle' }, [
        el('span', {}, 'Dry-run (apenas simular)'),
        dryRunCb,
      ]),
    ],
    footer: [],
    onMount: (close) => {
      const overlay = document.querySelector('.modal-overlay');
      const footer = overlay?.querySelector('.modal__footer');
      if (!footer) return;
      footer.replaceChildren(
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => close(null) }, 'Cancelar'),
        el('button', {
          class: 'btn btn--danger',
          type: 'button',
          onclick: async () => {
            close(null);
            await confirmAndRestore(ctx, state);
          },
        }, 'Continuar'),
      );
    },
  });
}

async function confirmAndRestore(ctx, state) {
  if (typeof state._syncSource === 'function') state._syncSource();

  const sourceLabel = state.source === 'manual' || state.source === 'channel'
    ? `catálogo no canal (${state.masterFileId ? `${state.masterFileId.slice(0, 16)}…` : 'vazio'})`
    : `run ${state.runId}`;

  const ok = await confirmDialog({
    title: 'Confirmar restauração',
    message: 'Esta ação sobrescreve Parquets e atualiza o manifest local.',
    detail: `Fonte: ${sourceLabel}${state.underlying ? ` · apenas ${state.underlying}` : ''}${state.dryRun ? ' · dry-run' : ''}`,
    confirmLabel: state.dryRun ? 'Simular restore' : 'Restaurar agora',
    danger: true,
  });
  if (!ok) return;

  const body = {
    confirm: true,
    dry_run: state.dryRun,
    underlying: state.underlying || undefined,
  };
  if (state.source === 'manual' || state.source === 'channel') {
    if (!state.masterFileId) {
      ctx.toast.err('Informe o file_id do catálogo mestre');
      return;
    }
    body.master_file_id = state.masterFileId;
  } else {
    body.run_id = state.runId;
  }

  const res = await ctx.api.post('/api/backup/telegram/restore', body);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao iniciar restore');
    return;
  }
  ctx.toast.ok(state.dryRun ? 'Simulação de restore iniciada' : 'Restore iniciado');
  attachProgressPanel(ctx, res.data.run_id, 'restore');
  startPolling(ctx, res.data.run_id);
}

async function cancelActiveBackup(ctx, runId) {
  const ok = await confirmDialog({
    title: 'Cancelar operação',
    message: 'Interrompe o backup ou restore em andamento.',
    confirmLabel: 'Cancelar operação',
    danger: true,
  });
  if (!ok) return;
  const res = await ctx.api.post(`/api/backup/telegram/runs/${encodeURIComponent(runId)}/cancel`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao cancelar');
    return;
  }
  ctx.toast.ok('Cancelamento solicitado');
  await refreshTelegramBackupSettings(ctx);
}

async function stopAndResetBackup(ctx) {
  const ok = await phraseConfirmDialog({
    title: 'Parar e limpar backup',
    message: 'Cancela qualquer operação em andamento, desliga automações e apaga o histórico local.',
    detail: 'Token/chat_id e mensagens no canal Telegram não são removidos. O backup ficará desligado até você salvar de novo com “Backup habilitado”.',
    confirmLabel: 'Parar e limpar',
  });
  if (!ok) return;
  const res = await ctx.api.post('/api/backup/telegram/stop-all', { confirm: true });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao parar backup');
    return;
  }
  const cancelled = res.data.cancelled_run_ids?.length ?? 0;
  const clearedRuns = res.data.cleared?.runs_removed ?? 0;
  stopPolling();
  ctx.toast.ok(`Backup parado${cancelled ? ` · ${cancelled} operação(ões) cancelada(s)` : ''}${clearedRuns ? ` · ${clearedRuns} run(s) removido(s)` : ''}`);
  await refreshTelegramBackupSettings(ctx);
}

async function clearLocalBackupHistory(ctx) {
  const ok = await phraseConfirmDialog({
    title: 'Limpar histórico local',
    message: 'Apaga runs de backup/restore e o registro incremental local (artifacts).',
    detail: 'Operações em andamento serão canceladas primeiro. Credenciais do Telegram e dados do lake não são alterados. Mensagens no canal continuam no Telegram — apague lá manualmente se quiser.',
    confirmLabel: 'Limpar tudo',
  });
  if (!ok) return;
  const res = await ctx.api.post('/api/backup/telegram/clear-local', { confirm: true });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao limpar histórico');
    return;
  }
  ctx.toast.ok(`Removidos ${res.data.runs_removed ?? 0} run(s) e ${res.data.artifacts_removed ?? 0} registro(s)`);
  stopPolling();
  await refreshTelegramBackupSettings(ctx);
}

function optionRow(input, title, hint) {
  return el('label', { class: 'backup-modal-option' }, [
    input,
    el('div', {}, [
      el('div', { class: 'backup-modal-option__title' }, title),
      el('div', { class: 'backup-modal-option__hint' }, hint),
    ]),
  ]);
}

function behaviorToggles(formState, timezoneLabel) {
  const scheduleTimeWrap = el('div', { class: 'backup-schedule-time' });
  const scheduleTimeField = el('label', { class: 'field backup-schedule-time__field' }, [
    el('span', { class: 'field__label' }, `Horário (${timezoneLabel})`),
    (() => {
      const input = el('input', { type: 'time', class: 'field__input', value: formState.auto_schedule_time_utc });
      input.oninput = () => { formState.auto_schedule_time_utc = input.value; };
      return input;
    })(),
  ]);

  const syncScheduleTimeVisibility = (enabled) => {
    scheduleTimeWrap.hidden = !enabled;
  };

  const defs = [
    ['auto_after_asset_sync', 'Após sync de ativo', 'Backup incremental ao concluir agendamento de dados.'],
    ['auto_schedule_enabled', 'Agendamento diário', 'Incremental de todos os ativos no horário local.', { extra: scheduleTimeWrap }],
    ['incremental_default', 'Incremental padrão', 'Runs manuais pulam partições inalteradas.'],
    ['pin_master_catalog', 'Fixar catálogo', 'Fixa master_catalog no canal.'],
    ['silent_uploads', 'Uploads silenciosos', 'Sem notificação push no canal.'],
  ];

  const rows = defs.map(([key, label, hint, opts]) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(formState[key]);
    input.onchange = () => {
      formState[key] = input.checked;
      if (key === 'auto_schedule_enabled') syncScheduleTimeVisibility(input.checked);
    };
    if (key === 'auto_schedule_enabled') syncScheduleTimeVisibility(input.checked);
    return toggleRow(label, hint, input, { compact: true, extra: opts?.extra });
  });

  scheduleTimeWrap.appendChild(scheduleTimeField);
  return rows;
}

function passwordField(input) {
  const toggle = el('button', {
    type: 'button',
    class: 'backup-password-toggle',
    'aria-label': 'Mostrar token',
  }, el('i', { class: 'fa-solid fa-eye' }));
  toggle.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.querySelector('i').className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    toggle.setAttribute('aria-label', show ? 'Ocultar token' : 'Mostrar token');
  };
  return el('div', { class: 'backup-password-wrap' }, [input, toggle]);
}

function toggleRow(label, hint, input, { compact = false, extra = null } = {}) {
  input.className = 'switch-field__input';
  const row = el('div', { class: `backup-toggle${compact ? ' backup-toggle--compact' : ''}` }, [
    el('div', { class: 'backup-toggle__copy' }, [
      el('div', { class: 'backup-toggle__label' }, label),
      hint ? el('div', { class: 'backup-toggle__hint' }, hint) : null,
      extra || null,
    ]),
    el('label', { class: 'switch-field backup-toggle__switch', style: { margin: 0 } }, [input, el('span', { class: 'switch-field__slider' })]),
  ]);
  return row;
}

function field(label, control, hint) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field__label' }, label),
    control,
    hint ? el('span', { class: 'field__hint' }, hint) : null,
  ]);
}

function numberInput(formState, key) {
  const input = el('input', { type: 'number', class: 'field__input', value: String(formState[key]) });
  input.oninput = () => { formState[key] = Number.parseInt(input.value, 10) || formState[key]; };
  return input;
}

async function saveSettings(ctx, formState) {
  const body = {
    enabled: formState.enabled,
    chat_id: formState.chat_id,
    auto_after_asset_sync: formState.auto_after_asset_sync,
    auto_schedule_enabled: formState.auto_schedule_enabled,
    auto_schedule_time_utc: formState.auto_schedule_time_utc,
    pin_master_catalog: formState.pin_master_catalog,
    incremental_default: formState.incremental_default,
    silent_uploads: formState.silent_uploads,
    max_chunk_mb: formState.max_chunk_mb,
    rate_limit_ms: formState.rate_limit_ms,
  };
  if (formState.bot_token?.trim()) body.bot_token = formState.bot_token.trim();
  const res = await ctx.api.put('/api/settings/telegram-backup', body);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao salvar');
    return;
  }
  ctx.toast.ok('Configurações de backup salvas');
  await refreshTelegramBackupSettings(ctx);
}

async function discoverChannelBackups(ctx) {
  const res = await ctx.api.post('/api/backup/telegram/discover', {}, { timeoutMs: 120_000 });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao detectar backup no canal');
    return;
  }
  const discovery = res.data.discovery;
  if (discovery?.ok) {
    const parts = discovery.partition_count != null ? `${discovery.partition_count} partições` : 'catálogo válido';
    ctx.toast.ok(`Backup detectado no canal (${parts})`);
  } else {
    ctx.toast.warn(discovery?.message || 'Nenhum backup detectado no canal');
  }
  await refreshTelegramBackupSettings(ctx);
}

async function testConnection(ctx) {
  const res = await ctx.api.post('/api/settings/telegram-backup/test', {}, { timeoutMs: 120_000 });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Teste falhou');
    return;
  }
  const discovery = res.data.discovery;
  if (discovery?.ok) {
    ctx.toast.ok(`Conexão OK · backup detectado (${discovery.backup_run_id || 'master_catalog'})`);
  } else {
    ctx.toast.ok(`Conexão OK (message_id=${res.data.message_id})`);
  }
  await refreshTelegramBackupSettings(ctx);
}

function formatPhase(phase, isRestore) {
  const map = {
    starting: 'Iniciando',
    upload: 'Enviando partições',
    catalog: 'Publicando catálogo do ativo',
    master_catalog: 'Finalizando catálogo mestre',
    restore: 'Restaurando partições',
    done: 'Concluído',
    failed: 'Falhou',
    cancelled: 'Cancelado',
  };
  if (!phase) return isRestore ? 'Preparando restore' : 'Preparando backup';
  return map[phase] || phase;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function formatSchedulerTimezoneLabel(timeZone) {
  return String(timeZone || 'America/Sao_Paulo').replace(/_/g, ' ');
}
