import { el, mount, emptyState } from '../utils/dom.js';
import { confirmDialog, customDialog, phraseConfirmDialog } from '../utils/confirm.js';
import { renderSettingsTabs } from './settingsTabs.js';
import { listedUnderlyings } from '../../shared/underlyingAssets.js';

const POLL_INTERVAL_MS = 2000;
/** @type {{ timer: ReturnType<typeof setInterval> | null, runId: string | null, panelEl: HTMLElement | null }} */
const activePoll = { timer: null, runId: null, panelEl: null };

const backupStyles = `
  .backup-grid {
    display: grid;
    grid-template-columns: minmax(300px, 420px) 1fr;
    gap: 24px;
    align-items: start;
    margin-top: 20px;
  }

  @media (max-width: 1050px) {
    .backup-grid { grid-template-columns: 1fr; }
  }

  .backup-col {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
  }

  .backup-hint {
    margin: 4px 0 0;
    color: var(--text-2);
    font-size: 12px;
    line-height: 1.5;
  }

  .backup-card-head {
    margin-bottom: 18px;
  }

  .backup-card-head .card__title {
    margin: 0;
  }

  .backup-ops-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 4px;
  }

  .backup-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .backup-form label.field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-weight: 600;
    font-size: 13px;
    color: var(--text-1);
  }

  .backup-form label.field > span:first-child {
    color: var(--text-0);
  }

  .backup-form__row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
    gap: 12px;
  }

  .backup-form__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding-top: 4px;
  }

  .backup-toggle-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .backup-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 13px 15px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--radius-sm);
    background: rgba(17, 24, 39, 0.72);
    transition: border-color 0.2s ease, background-color 0.2s ease;
  }

  .backup-toggle:hover {
    border-color: rgba(255, 255, 255, 0.14);
    background: rgba(17, 24, 39, 0.9);
  }

  .backup-toggle__label {
    color: var(--text-0);
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .backup-toggle__hint {
    color: var(--text-2);
    font-size: 12px;
    margin-top: 4px;
    line-height: 1.45;
  }

  .backup-password-wrap {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
  }

  .backup-password-wrap .field__input {
    padding-right: 44px;
  }

  .backup-password-wrap .field__input::-ms-reveal,
  .backup-password-wrap .field__input::-ms-clear {
    display: none;
  }

  .backup-password-toggle {
    position: absolute;
    right: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--text-1);
    cursor: pointer;
    transition: color 0.15s ease, background-color 0.15s ease;
  }

  .backup-password-toggle:hover {
    color: var(--text-0);
    background: rgba(255, 255, 255, 0.08);
  }

  .backup-password-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .backup-time-field {
    margin-top: 4px;
    padding: 12px 14px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: var(--radius-sm);
    background: rgba(13, 19, 32, 0.25);
  }

  .backup-advanced {
    margin-top: 6px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: var(--radius-sm);
    background: rgba(13, 19, 32, 0.2);
    overflow: hidden;
  }

  .backup-advanced summary {
    cursor: pointer;
    padding: 11px 14px;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: color 0.2s ease, background-color 0.2s ease;
  }

  .backup-advanced summary::-webkit-details-marker { display: none; }

  .backup-advanced summary::before {
    content: "▸";
    font-size: 11px;
    color: var(--accent);
    transition: transform 0.2s ease;
  }

  .backup-advanced[open] summary::before { transform: rotate(90deg); }

  .backup-advanced summary:hover {
    color: var(--text-0);
    background: rgba(255, 255, 255, 0.02);
  }

  .backup-advanced__body {
    padding: 0 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .backup-status-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 20px;
    border-radius: var(--radius-sm);
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: linear-gradient(180deg, rgba(22, 28, 45, 0.45) 0%, rgba(13, 19, 32, 0.6) 100%);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  .backup-status-panel.is-found {
    border-color: rgba(16, 185, 129, 0.28);
    background: linear-gradient(180deg, rgba(16, 185, 129, 0.1) 0%, rgba(13, 19, 32, 0.55) 100%);
  }

  .backup-status-panel.is-missing {
    border-color: rgba(245, 158, 11, 0.28);
    background: linear-gradient(180deg, rgba(245, 158, 11, 0.08) 0%, rgba(13, 19, 32, 0.55) 100%);
  }

  .backup-status-panel__head {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .backup-status-panel__title {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--text-0);
  }

  .backup-status-panel__sub {
    margin: 2px 0 0;
    font-size: 11.5px;
    color: var(--text-2);
    line-height: 1.4;
  }

  .backup-status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 8px;
  }

  .backup-status-stat {
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: var(--radius-sm);
    background: rgba(13, 19, 32, 0.4);
  }

  .backup-status-stat__label {
    display: block;
    font-size: 9.5px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .backup-status-stat__value {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-0);
    font-family: var(--font-mono, monospace);
    word-break: break-all;
  }

  .backup-progress-card {
    padding: 16px 18px;
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-sm);
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 10%, transparent) 0%, rgba(13, 19, 32, 0.5) 100%);
    box-shadow: 0 4px 18px rgba(249, 115, 22, 0.08);
  }

  .backup-progress-card__head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .backup-progress-card__head strong {
    color: var(--text-0);
    font-size: 13px;
  }

  .backup-progress-bar {
    height: 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }

  .backup-progress-bar span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-strong));
    border-radius: inherit;
    transition: width 0.35s ease;
    box-shadow: 0 0 12px rgba(249, 115, 22, 0.35);
  }

  .backup-progress-meta {
    margin-top: 12px;
    display: grid;
    gap: 5px;
    font-size: 11.5px;
    color: var(--text-2);
  }

  .backup-progress-meta code {
    font-family: var(--font-mono);
    color: var(--text-0);
    font-size: 11px;
  }

  .backup-history-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .backup-run-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-left: 3px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-2);
    background: rgba(13, 19, 32, 0.35);
    cursor: pointer;
    transition: border-color 0.2s ease, background-color 0.2s ease, transform 0.2s ease;
  }

  .backup-run-row--ok { border-left-color: var(--ok); }
  .backup-run-row--warn { border-left-color: var(--warn); }
  .backup-run-row--err { border-left-color: var(--err); }
  .backup-run-row--idle { border-left-color: var(--text-3); }

  .backup-run-row:hover {
    border-color: rgba(255, 255, 255, 0.1);
    background: rgba(13, 19, 32, 0.55);
    transform: translateX(2px);
  }

  .backup-run-row__main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .backup-run-row__top {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .backup-run-row__id {
    color: var(--text-0);
    padding: 2px 7px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 5px;
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .backup-run-row__meta {
    font-size: 11px;
    color: var(--text-3);
  }

  .backup-run-row__stats {
    font-size: 11px;
    color: var(--text-3);
  }

  .backup-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }

  .backup-modal-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }

  .backup-modal-option {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 12px 14px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: border-color 0.2s ease, background-color 0.2s ease;
  }

  .backup-modal-option:hover {
    border-color: rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.02);
  }

  .backup-modal-option:has(input:checked) {
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .backup-modal-option input { margin-top: 3px; accent-color: var(--accent); }

  .backup-modal-option__title {
    font-weight: 600;
    color: var(--text-0);
    font-size: 13px;
  }

  .backup-modal-option__hint {
    color: var(--text-2);
    font-size: 11.5px;
    margin-top: 3px;
    line-height: 1.45;
  }

  .backup-restore-fields {
    display: none;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }

  .backup-restore-fields.is-visible { display: flex; }

  .backup-setup-steps {
    margin-bottom: 4px;
    padding: 0;
    border: none;
    background: none;
  }

  .backup-setup-steps .backup-hint {
    margin: 0;
  }

  .backup-card-head .btn {
    flex-shrink: 0;
    align-self: flex-start;
    margin-top: 2px;
  }

  #backup-progress-slot:not(:empty) {
    margin-bottom: 14px;
  }
`;

export async function renderTelegramBackupSettings(ctx) {
  ctx.setBreadcrumb('settings', 'Backup Telegram');
  ctx.renderContextBar?.();

  if (!document.getElementById('telegram-backup-settings-styles')) {
    document.head.appendChild(el('style', { id: 'telegram-backup-settings-styles' }, backupStyles));
  }

  mount(ctx.contentEl, buildBackupLoadingShell());
  await refreshTelegramBackupSettings(ctx);
}

function buildBackupLoadingShell() {
  return [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Configurações'),
        el('p', { class: 'page-header__sub' }, 'Backup de backtest_ticks no Telegram — canal privado com catálogo recuperável.'),
      ]),
    ]),
    renderSettingsTabs('backup'),
    el('div', { class: 'backup-grid' }, [
      el('section', { class: 'card' }, el('p', { class: 'muted' }, 'Carregando…')),
    ]),
  ];
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

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Configurações'),
        el('p', { class: 'page-header__sub' }, 'Backup de backtest_ticks no Telegram — canal privado com catálogo recuperável.'),
      ]),
      el('span', { class: `badge badge--${statusBadge[0]}` }, statusBadge[1]),
    ]),
    renderSettingsTabs('backup'),
    el('div', { class: 'backup-grid' }, [
      el('div', { class: 'backup-col backup-col--left' }, [
        renderConnectionCard(formState, settings, ctx),
        renderBehaviorCard(formState, timezoneLabel),
      ]),
      el('div', { class: 'backup-col backup-col--right' }, [
        renderOperationsCard(ctx, {
          settings,
          lastRun,
          channelCatalog,
          completedRuns,
          progressSlot,
        }),
        renderHistoryCard(ctx, runs, completedRuns, channelCatalog),
      ]),
    ]),
  ]);

  activePoll.panelEl = document.getElementById('backup-progress-slot');
}

function sectionHead(title, hint) {
  return el('div', { class: 'backup-card-head' }, [
    el('h2', { class: 'card__title' }, title),
    hint ? el('p', { class: 'backup-hint' }, hint) : null,
  ]);
}

function renderConnectionCard(formState, settings, ctx) {
  const enabledInput = el('input', { type: 'checkbox' });
  enabledInput.checked = formState.enabled;
  enabledInput.onchange = () => { formState.enabled = enabledInput.checked; };

  const tokenInput = el('input', { type: 'password', class: 'field__input', placeholder: settings.bot_token_set ? settings.bot_token : '123456789:ABC...', autocomplete: 'off' });
  tokenInput.oninput = () => { formState.bot_token = tokenInput.value; };

  const chatInput = el('input', { type: 'text', class: 'field__input', value: formState.chat_id, placeholder: '-100xxxxxxxxxx' });
  chatInput.oninput = () => { formState.chat_id = chatInput.value; };

  return el('section', { class: 'card' }, [
    sectionHead('Conexão Telegram', 'Crie o bot no @BotFather, adicione-o ao canal privado e informe as credenciais.'),
    el('form', {
      class: 'backup-form',
      onsubmit: (event) => event.preventDefault(),
    }, [
      toggleRow('Backup habilitado', 'Interruptor geral do envio automático e manual.', enabledInput),
      el('div', { class: 'backup-form__row' }, [
        field('Token do bot', passwordField(tokenInput), 'Deixe em branco para manter o token salvo.'),
        field('Chat ID do canal', chatInput, 'ID numérico (-100…) ou @canal.'),
      ]),
      el('div', { class: 'backup-form__actions' }, [
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => testConnection(ctx) }, 'Testar conexão'),
        el('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => saveSettings(ctx, formState) }, 'Salvar'),
      ]),
    ]),
  ]);
}

function renderBehaviorCard(formState, timezoneLabel) {
  return el('section', { class: 'card' }, [
    sectionHead('Comportamento', 'Automação, incremental e preferências de envio.'),
    el('div', { class: 'backup-toggle-list' }, behaviorToggles(formState, timezoneLabel)),
    el('details', { class: 'backup-advanced' }, [
      el('summary', {}, 'Configurações avançadas'),
      el('div', { class: 'backup-advanced__body' }, [
        el('div', { class: 'backup-form__row' }, [
          field('Chunk máximo (MB)', numberInput(formState, 'max_chunk_mb'), 'Padrão 18 MB — limite de download no restore ~20 MB.'),
          field('Intervalo entre uploads (ms)', numberInput(formState, 'rate_limit_ms'), 'Padrão 3000 ms entre partições.'),
        ]),
      ]),
    ]),
  ]);
}

function renderOperationsCard(ctx, { settings, lastRun, channelCatalog, completedRuns, progressSlot }) {
  const busy = Boolean(activePoll.runId);
  const configured = settings.configured;
  const channelFound = Boolean(channelCatalog?.ok && channelCatalog?.master_file_id);
  const canRestore = configured && !busy && (channelFound || completedRuns.length > 0);

  return el('section', { class: 'card' }, [
    sectionHead('Operações', 'Envie, restaure ou atualize a detecção no canal.'),
    progressSlot,
    el('div', { class: 'backup-ops-toolbar' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        disabled: !configured || busy,
        onclick: () => openBackupStartModal(ctx, settings),
      }, 'Iniciar backup'),
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
    ].filter(Boolean)),
    renderBackupStatusCard(settings, channelCatalog, lastRun),
  ]);
}

function renderHistoryCard(ctx, runs, completedRuns, channelCatalog) {
  const busy = Boolean(activePoll.runId);
  const hasRuns = runs.length > 0;

  return el('section', { class: 'card' }, [
    el('div', { class: 'card__header' }, [
      el('div', {}, [
        el('h2', { class: 'card__title' }, 'Histórico'),
        el('p', { class: 'backup-hint' }, hasRuns
          ? 'Clique em um run concluído para restaurar a partir dele.'
          : 'Nenhum run nesta instalação — use Restaurar para recuperar do canal.'),
      ]),
      hasRuns ? el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm btn--danger',
        disabled: busy,
        onclick: () => clearLocalBackupHistory(ctx),
      }, 'Limpar histórico') : null,
    ]),
    hasRuns
      ? el('div', { class: 'backup-history-list' }, runs.map((run) => renderRunRow(run, ctx, completedRuns, channelCatalog)))
      : emptyState('Nenhum backup ou restore registrado nesta instalação.'),
  ]);
}

function renderBackupStatusCard(settings, channelCatalog, lastRun) {
  if (!settings.configured) {
    return statusPanel('neutral', 'Canal não configurado', 'Informe token e chat_id à esquerda, salve e teste a conexão.');
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
  else if (run.status === 'running' || run.status === 'queued') statusClass = 'warn';

  const isRestore = run.request?.kind === 'restore';
  const label = isRestore ? 'restore' : run.mode;
  const statsText = run.result?.stats
    ? `↑ ${run.result.stats.uploaded} enviados · ↷ ${run.result.stats.skipped} pulados`
    : run.result?.restored
      ? `${run.result.restored.partitions} partições restauradas`
      : null;

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
  slot.replaceChildren(buildProgressCard(runId, kind, null));
}

function buildProgressCard(runId, kind, run) {
  const progress = run?.progress || {};
  const isRestore = kind === 'restore' || progress.kind === 'restore';
  const processed = Number(progress.processed || 0);
  const total = Number(progress.total || 0);
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : (run?.status === 'running' ? 5 : 0);
  const stats = progress.stats || run?.result?.stats;

  return el('div', { class: 'backup-progress-card', id: 'backup-progress-card' }, [
    el('div', { class: 'backup-progress-card__head' }, [
      el('strong', {}, isRestore ? 'Restauração em andamento' : 'Backup em andamento'),
      el('span', { class: 'badge badge--warn badge--compact' }, run?.status || 'running'),
    ]),
    el('div', { class: 'backup-progress-bar' }, [el('span', { style: { width: `${pct}%` } })]),
    el('div', { class: 'backup-progress-meta' }, [
      el('div', {}, `Fase: ${formatPhase(progress.phase, isRestore)}`),
      total > 0 ? el('div', {}, `Progresso: ${processed} / ${total} (${pct}%)`) : el('div', {}, 'Calculando total de partições…'),
      progress.underlying ? el('div', {}, `Ativo: ${progress.underlying}${progress.dt ? ` · ${progress.dt}` : ''}`) : null,
      stats ? el('div', {}, `Enviados: ${stats.uploaded ?? 0} · Pulados: ${stats.skipped ?? 0} · Erros: ${stats.errors ?? 0}`) : null,
      el('div', {}, ['Run: ', el('code', {}, runId)]),
      el('div', { class: 'backup-hint' }, 'O processo continua em segundo plano. Você pode permanecer nesta página — não há limite de tempo.'),
    ]),
  ]);
}

function updateProgressCard(run) {
  const card = document.getElementById('backup-progress-card');
  const slot = document.getElementById('backup-progress-slot');
  if (!slot || !card) return;
  const kind = run.request?.kind === 'restore' ? 'restore' : 'backup';
  slot.replaceChildren(buildProgressCard(run.id, kind, run));
}

function startPolling(ctx, runId) {
  if (activePoll.timer && activePoll.runId === runId) return;
  stopPolling();
  activePoll.runId = runId;

  const tick = async () => {
    const res = await ctx.api.get(`/api/backup/telegram/runs/${encodeURIComponent(runId)}`, { timeoutMs: 60_000 });
    if (!res.ok) return;
    const run = res.data.run;
    updateProgressCard(run);

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
      ctx.toast.err(run.error || 'Operação falhou');
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

async function openBackupStartModal(ctx, settings) {
  const state = {
    scope: 'single',
    underlying: 'BTC',
    incremental: settings.incremental_default,
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
  const res = await ctx.api.post('/api/backup/telegram/runs', {
    underlying: state.scope === 'single' ? state.underlying : undefined,
    all_underlyings: state.scope === 'all',
    incremental: state.incremental,
    dry_run: state.dryRun,
    force: !state.incremental,
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

async function clearLocalBackupHistory(ctx) {
  const ok = await phraseConfirmDialog({
    title: 'Limpar histórico local',
    message: 'Apaga runs de backup/restore e o registro incremental local (artifacts).',
    detail: 'Credenciais do Telegram e dados do lake não são alterados. Mensagens no canal continuam no Telegram — apague lá manualmente se quiser.',
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
  const defs = [
    ['auto_after_asset_sync', 'Backup após sync de ativo', 'Dispara backup incremental quando um agendamento de atualização concluir.'],
    ['auto_schedule_enabled', 'Agendamento diário', `Backup incremental de todos os ativos no horário local (${timezoneLabel}).`],
    ['incremental_default', 'Incremental por padrão', 'Runs manuais pulam partições inalteradas (sha256).'],
    ['pin_master_catalog', 'Fixar catálogo mestre', 'Fixa a mensagem master_catalog no canal.'],
    ['silent_uploads', 'Uploads silenciosos', 'Sem notificação push no canal.'],
  ];
  return defs.map(([key, label, hint]) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(formState[key]);
    input.onchange = () => { formState[key] = input.checked; };
    return toggleRow(label, hint, input);
  }).concat([
    el('div', { class: 'backup-time-field' }, [
      el('label', { class: 'field', style: { margin: 0 } }, [
        el('span', {}, `Horário (${timezoneLabel})`),
        (() => {
          const input = el('input', { type: 'time', class: 'field__input', value: formState.auto_schedule_time_utc });
          input.oninput = () => { formState.auto_schedule_time_utc = input.value; };
          return input;
        })(),
        el('span', { class: 'backup-hint' }, 'Usado quando o agendamento diário estiver ativo.'),
      ]),
    ]),
  ]);
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

function toggleRow(label, hint, input) {
  input.className = 'switch-field__input';
  return el('div', { class: 'backup-toggle' }, [
    el('div', { style: { flex: 1 } }, [
      el('div', { class: 'backup-toggle__label' }, label),
      el('div', { class: 'backup-toggle__hint' }, hint),
    ]),
    el('label', { class: 'switch-field', style: { margin: 0 } }, [input, el('span', { class: 'switch-field__slider' })]),
  ]);
}

function field(label, control, hint) {
  return el('label', { class: 'field' }, [el('span', {}, label), control, hint ? el('span', { class: 'backup-hint' }, hint) : null]);
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
