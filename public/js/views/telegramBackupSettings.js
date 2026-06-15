import { el, mount } from '../utils/dom.js';
import { confirmDialog } from '../utils/confirm.js';
import { renderSettingsTabs } from './settingsTabs.js';

const backupStyles = `
  .backup-page { margin-top: 18px; }
  .backup-hint { margin: 2px 0 0; color: var(--text-3); font-size: 11.5px; line-height: 1.45; }
  .backup-form { display: flex; flex-direction: column; gap: 14px; margin-top: 14px; }
  .backup-form label.field { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--text-2); }
  .backup-form__row { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; }
  .backup-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; background: rgba(255,255,255,0.02); }
  .backup-toggle__label { color: var(--text-0); font-size: 12.5px; font-weight: 600; }
  .backup-toggle__hint { color: var(--text-3); font-size: 11px; margin-top: 3px; }
  .backup-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .backup-runs { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
  .backup-run-row { padding: 10px 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; font-size: 11.5px; color: var(--text-2); }
  .backup-advanced { margin-top: 8px; }
  .backup-advanced summary { cursor: pointer; color: var(--text-2); font-size: 12px; font-weight: 600; }
`;

export async function renderTelegramBackupSettings(ctx) {
  ctx.setBreadcrumb('settings', 'Backup Telegram');
  ctx.renderContextBar?.();

  if (!document.getElementById('telegram-backup-settings-styles')) {
    document.head.appendChild(el('style', { id: 'telegram-backup-settings-styles' }, backupStyles));
  }

  mount(ctx.contentEl, el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Carregando backup…')));
  await refreshTelegramBackupSettings(ctx);
}

async function refreshTelegramBackupSettings(ctx) {
  const [settingsRes, runsRes] = await Promise.all([
    ctx.api.get('/api/settings/telegram-backup'),
    ctx.api.get('/api/backup/telegram/runs?limit=10'),
  ]);
  if (!settingsRes.ok) {
    mount(ctx.contentEl, el('p', { class: 'bad' }, settingsRes.error?.message || 'Falha ao carregar backup'));
    return;
  }
  renderTelegramBackupPage(ctx, settingsRes.data, runsRes.ok ? runsRes.data.runs : []);
}

function renderTelegramBackupPage(ctx, data, runs) {
  const settings = data.settings || {};
  const lastRun = data.last_run;
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
    max_chunk_mb: settings.max_chunk_mb || 48,
    rate_limit_ms: settings.rate_limit_ms || 3000,
  };

  const enabledInput = el('input', { type: 'checkbox' });
  enabledInput.checked = formState.enabled;
  enabledInput.onchange = () => { formState.enabled = enabledInput.checked; };

  const tokenInput = el('input', {
    type: 'password',
    class: 'input',
    placeholder: settings.bot_token_set ? settings.bot_token : '123456789:ABC...',
  });
  tokenInput.oninput = () => { formState.bot_token = tokenInput.value; };

  const chatInput = el('input', { type: 'text', class: 'input', value: formState.chat_id, placeholder: '-100xxxxxxxxxx' });
  chatInput.oninput = () => { formState.chat_id = chatInput.value; };

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Configurações'),
        el('p', { class: 'page-header__sub' }, 'Backup de backtest_ticks no Telegram — canal privado com catálogo recuperável.'),
      ]),
    ]),
    renderSettingsTabs('backup'),
    el('section', { class: 'card backup-page' }, [
      el('div', { class: 'card__header' }, [
        el('div', {}, [
          el('h2', { class: 'card__title' }, 'Backup Telegram'),
          el('p', { class: 'backup-hint' }, 'Crie um bot (@BotFather), canal privado e adicione o bot como admin com permissão de postar.'),
        ]),
        el('span', { class: `badge badge--${statusBadge[0]}` }, statusBadge[1]),
      ]),
      el('div', { class: 'backup-form' }, [
        toggleRow('Backup habilitado', 'Interruptor geral do envio automático e manual.', enabledInput),
        el('div', { class: 'backup-form__row' }, [
          field('Token do bot', tokenInput, 'Deixe em branco para manter o token salvo.'),
          field('Chat ID do canal', chatInput, 'ID numérico do canal (-100…) ou @canal.'),
        ]),
        el('div', { class: 'backup-actions' }, [
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => testConnection(ctx) }, 'Testar conexão'),
          el('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => saveSettings(ctx, formState) }, 'Salvar'),
        ]),
        el('h3', { style: { margin: '8px 0 0', fontSize: '13px' } }, 'Comportamento'),
        ...behaviorToggles(formState),
        el('details', { class: 'backup-advanced' }, [
          el('summary', {}, 'Avançado'),
          el('div', { class: 'backup-form__row', style: { marginTop: '10px' } }, [
            field('Chunk máximo (MB)', numberInput(formState, 'max_chunk_mb'), 'Padrão 48 MB (limite Telegram ~50 MB).'),
            field('Intervalo entre uploads (ms)', numberInput(formState, 'rate_limit_ms'), 'Padrão 3000 ms.'),
          ]),
        ]),
        el('h3', { style: { margin: '12px 0 0', fontSize: '13px' } }, 'Status'),
        el('p', { class: 'backup-hint' }, lastRun
          ? `Último backup: ${lastRun.completed_at || lastRun.created_at} · ${lastRun.status} · ${lastRun.result?.stats?.uploaded ?? '—'} enviados`
          : 'Nenhum backup concluído ainda.'),
        lastRun?.result?.master_catalog?.message_id
          ? el('p', { class: 'backup-hint' }, `Catálogo mestre message_id=${lastRun.result.master_catalog.message_id} · file_id=${lastRun.result.master_catalog.file_id || '—'}`)
          : null,
        el('div', { class: 'backup-actions' }, [
          el('button', {
            type: 'button',
            class: 'btn btn--secondary btn--sm',
            disabled: !settings.configured,
            onclick: () => openBackupModal(ctx, settings),
          }, 'Backup agora'),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm btn--danger',
            disabled: !settings.configured,
            onclick: () => openRestoreModal(ctx, lastRun),
          }, 'Restaurar'),
        ]),
        runs.length ? el('div', { class: 'backup-runs' }, [
          el('h3', { style: { fontSize: '13px', margin: 0 } }, 'Histórico recente'),
          ...runs.map((run) => el('div', { class: 'backup-run-row' }, [
            el('strong', { style: { color: 'var(--text-0)' } }, run.id),
            ` · ${run.status} · ${run.mode} · ${run.completed_at || run.created_at}`,
            run.result?.stats ? ` · up=${run.result.stats.uploaded} skip=${run.result.stats.skipped}` : '',
          ])),
        ]) : null,
      ]),
    ]),
  ]);
}

function behaviorToggles(formState) {
  const defs = [
    ['auto_after_asset_sync', 'Backup após sync de ativo', 'Dispara backup incremental quando um agendamento de atualização concluir.'],
    ['auto_schedule_enabled', 'Agendamento diário', 'Backup incremental de todos os ativos no horário UTC.'],
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
    el('label', { class: 'field' }, [
      el('span', {}, 'Horário UTC (agendamento)'),
      (() => {
        const input = el('input', { type: 'time', class: 'input', value: formState.auto_schedule_time_utc });
        input.oninput = () => { formState.auto_schedule_time_utc = input.value; };
        return input;
      })(),
    ]),
  ]);
}

function toggleRow(label, hint, input) {
  return el('div', { class: 'backup-toggle' }, [
    el('div', {}, [
      el('div', { class: 'backup-toggle__label' }, label),
      el('div', { class: 'backup-toggle__hint' }, hint),
    ]),
    input,
  ]);
}

function field(label, control, hint) {
  return el('label', { class: 'field' }, [el('span', {}, label), control, hint ? el('span', { class: 'backup-hint' }, hint) : null]);
}

function numberInput(formState, key) {
  const input = el('input', { type: 'number', class: 'input', value: String(formState[key]) });
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

async function testConnection(ctx) {
  const res = await ctx.api.post('/api/settings/telegram-backup/test', {});
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Teste falhou');
    return;
  }
  ctx.toast.ok(`Conexão OK (message_id=${res.data.message_id})`);
}

async function openBackupModal(ctx, settings) {
  const underlying = window.prompt('Underlying (ex.: BTC) ou deixe vazio para todos:', 'BTC');
  if (underlying === null) return;
  const dryRun = await confirmDialog({
    title: 'Dry-run?',
    message: 'Executar em modo dry-run (sem enviar ao Telegram)?',
    confirmLabel: 'Dry-run',
    cancelLabel: 'Enviar de verdade',
  });
  const res = await ctx.api.post('/api/backup/telegram/runs', {
    underlying: underlying.trim() || undefined,
    all_underlyings: !underlying.trim(),
    incremental: settings.incremental_default,
    dry_run: dryRun,
    force: !settings.incremental_default,
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao iniciar backup');
    return;
  }
  ctx.toast.ok(`Backup enfileirado: ${res.data.run_id}`);
  pollRun(ctx, res.data.run_id);
}

async function pollRun(ctx, runId) {
  for (let i = 0; i < 120; i += 1) {
    await sleep(2000);
    const res = await ctx.api.get(`/api/backup/telegram/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) continue;
    const run = res.data.run;
    if (run.status === 'completed') {
      ctx.toast.ok('Backup concluído');
      await refreshTelegramBackupSettings(ctx);
      return;
    }
    if (run.status === 'failed') {
      ctx.toast.err(run.error || 'Backup falhou');
      await refreshTelegramBackupSettings(ctx);
      return;
    }
  }
  ctx.toast.err('Timeout aguardando backup');
}

async function openRestoreModal(ctx, lastRun) {
  const ok = await confirmDialog({
    title: 'Restaurar do Telegram',
    message: 'Isso sobrescreve Parquets locais e atualiza o manifest a partir do último catálogo. Continuar?',
    confirmLabel: 'Restaurar',
    danger: true,
  });
  if (!ok) return;
  const res = await ctx.api.post('/api/backup/telegram/restore', {
    confirm: true,
    run_id: lastRun?.id ?? undefined,
    master_file_id: lastRun?.result?.master_catalog?.file_id ?? undefined,
    dry_run: false,
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || res.message || 'Restore falhou');
    return;
  }
  ctx.toast.ok(`Restore OK — ${res.data.restored?.partitions ?? 0} partições`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
