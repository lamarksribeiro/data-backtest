import { el, mount, emptyState } from '../utils/dom.js';
import { confirmDialog } from '../utils/confirm.js';
import { applyContextOptions, contextBarOptions, loadContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';
import { renderSettingsPage } from './settingsTabs.js';

export async function renderSettings(ctx) {
  ctx.setBreadcrumb('settings', 'Sincronização');
  ctx.renderContextBar?.();

  mount(ctx.contentEl, renderSettingsPage('sync', el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Carregando configurações…'))));
  const apiOptions = await fetchContextOptionsCached(ctx.api);
  const fieldOptions = contextBarOptions(apiOptions);
  const formCtx = applyContextOptions(loadContext(), fieldOptions);
  await refreshSettings(ctx, fieldOptions, formCtx);
}

async function refreshSettings(ctx, fieldOptions, formCtx = loadContext()) {
  const schedulesRes = await ctx.api.get('/api/settings/asset-update-schedules');
  if (!schedulesRes.ok) {
    mount(ctx.contentEl, el('p', { class: 'bad' }, schedulesRes.error?.message || 'Falha ao carregar configurações'));
    return;
  }
  renderSettingsView(
    ctx,
    fieldOptions,
    formCtx,
    schedulesRes.data.schedules || [],
    schedulesRes.data.target_to_date,
    schedulesRes.data.scheduler_timezone,
  );
}

function renderSettingsView(ctx, fieldOptions, formCtx, schedules, targetToDate, schedulerTimezone) {
  const timezoneLabel = formatSchedulerTimezoneLabel(schedulerTimezone);
  mount(ctx.contentEl, renderSettingsPage('sync', [
    el('div', { class: 'settings-layout settings-layout--split' }, [
      el('section', { class: 'card' }, [
        el('div', { class: 'settings-card__head' }, [
          el('h2', { class: 'card__title' }, 'Novo agendamento'),
          el('p', { class: 'card__sub' }, `Atualiza até ${targetToDate || 'o último dia fechado (UTC)'}, usando o mesmo pipeline dos jobs manuais em Dados.`),
        ]),
        renderScheduleForm(ctx, fieldOptions, formCtx, timezoneLabel),
      ]),
      el('section', { class: 'card' }, [
        el('div', { class: 'settings-card__head settings-card__head--row' }, [
          el('div', {}, [
            el('h2', { class: 'card__title' }, 'Agendamentos'),
            el('p', { class: 'card__sub' }, 'Um agendamento por combinação de ativo, intervalo e book.'),
          ]),
          el('span', { class: 'badge badge--ok' }, `Alvo: ${targetToDate || 'ontem UTC'}`),
        ]),
        schedules.length
          ? el('div', { class: 'settings-schedule-list' }, schedules.map((schedule) => renderScheduleCard(ctx, schedule, fieldOptions, formCtx, timezoneLabel)))
          : emptyState('Nenhum agendamento criado.'),
      ]),
    ]),
  ]));
}

function renderScheduleForm(ctx, fieldOptions, formCtx, timezoneLabel) {
  const frequencySelect = simpleSelect('frequency', [
    ['daily', 'Diária'],
    ['every_hours', 'A cada N horas'],
  ], 'daily');

  const form = el('form', { class: 'settings-form', id: 'asset-update-schedule-form' }, [
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Nome'),
      el('input', { class: 'field__input', name: 'name', value: `${formCtx.underlying} ${formCtx.interval} automático` }),
    ]),
    el('div', { class: 'settings-form__row' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Ativo'),
        selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Intervalo'),
        selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval),
      ]),
    ]),
    el('div', { class: 'settings-form__row' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Book'),
        selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Cobrir desde'),
        el('input', { class: 'field__input', type: 'date', name: 'start_date', value: formCtx.from }),
      ]),
    ]),
    el('div', { class: 'settings-form__row' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Frequência'),
        frequencySelect,
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, `Horário (${timezoneLabel})`),
        el('input', { class: 'field__input', type: 'time', name: 'time_utc', value: '03:00' }),
      ]),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Intervalo em horas'),
      el('input', { class: 'field__input', type: 'number', min: '1', max: '168', name: 'every_hours', value: '24' }),
    ]),
    el('label', { class: 'switch-field' }, [
      el('input', { type: 'checkbox', name: 'enabled', value: '1', class: 'switch-field__input', checked: true }),
      el('span', { class: 'switch-field__slider' }),
      ' Ativar após criar',
    ]),
    el('p', { class: 'field__hint' }, 'O agendamento nunca prepara o dia corrente. Ex.: em 13 UTC, o limite automático é dia 12.'),
    el('div', { class: 'settings-form__actions' }, [
      el('button', { type: 'submit', class: 'btn btn--primary' }, 'Criar agendamento'),
    ]),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fd = new FormData(form);
    const payload = {
      name: fd.get('name'),
      underlying: fd.get('underlying'),
      interval: fd.get('interval'),
      book_depth: Number(fd.get('book_depth')),
      start_date: fd.get('start_date'),
      frequency: fd.get('frequency'),
      time_utc: fd.get('time_utc'),
      every_hours: Number(fd.get('every_hours')),
      enabled: fd.get('enabled') === '1',
    };
    const res = await ctx.api.post('/api/settings/asset-update-schedules', payload);
    if (!res.ok) {
      ctx.toast.err(res.error?.message || 'Falha ao criar agendamento');
      return;
    }
    ctx.toast.ok('Agendamento criado');
    await refreshSettings(ctx, fieldOptions, formCtx);
  });

  return form;
}

function renderScheduleCard(ctx, schedule, fieldOptions, formCtx, timezoneLabel) {
  const activeRun = schedule.active_run;
  return el('article', { class: `settings-schedule-card${schedule.enabled ? '' : ' is-disabled'}` }, [
    el('div', { class: 'settings-schedule-card__head' }, [
      el('div', {}, [
        el('h3', { class: 'settings-schedule-card__title' }, schedule.name),
        el('p', { class: 'settings-schedule-card__meta' }, `${schedule.underlying} · ${schedule.interval} · book ${schedule.book_depth}`),
      ]),
      el('span', { class: `badge badge--${schedule.enabled ? 'ok' : 'warn'}` }, schedule.enabled ? 'Ativo' : 'Pausado'),
    ]),
    el('div', { class: 'settings-stat-grid' }, [
      stat('Cobertura', `${schedule.start_date} → ontem UTC`),
      stat('Frequência', frequencyLabel(schedule, timezoneLabel)),
      stat('Próxima', formatDateTime(schedule.next_run_at) || 'pausado'),
      stat('Último sucesso', formatDateTime(schedule.last_success_at) || 'nunca'),
    ]),
    schedule.last_error ? el('p', { class: 'bad', style: { margin: 0, fontSize: '12px' } }, schedule.last_error) : null,
    activeRun ? el('p', { class: 'field__hint', style: { margin: 0 } }, `Execução ativa: ${activeRun.status}${activeRun.prepare_job_id ? ` · job #${activeRun.prepare_job_id}` : ''}`) : null,
    el('div', { class: 'settings-schedule-card__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        disabled: Boolean(activeRun),
        onclick: () => runScheduleNow(ctx, schedule, fieldOptions, formCtx),
      }, activeRun ? 'Executando…' : 'Executar agora'),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => toggleSchedule(ctx, schedule, fieldOptions, formCtx),
      }, schedule.enabled ? 'Pausar' : 'Ativar'),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm btn--danger',
        onclick: () => deleteSchedule(ctx, schedule, fieldOptions, formCtx),
      }, 'Excluir'),
    ]),
    renderRunHistory(schedule.recent_runs || []),
  ]);
}

const RUN_STATUS_LABELS = {
  completed: 'Concluído',
  failed: 'Falhou',
  running: 'Executando',
  queued: 'Na fila',
  skipped: 'Ignorado',
  cancelled: 'Cancelado',
};

function runStatusTone(status) {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'cancelled') return 'err';
  if (status === 'running' || status === 'queued') return 'warn';
  return 'idle';
}

function renderRunHistory(runs) {
  if (!runs.length) return null;
  const [latest, ...older] = runs;
  const latestRow = renderRunRow(latest, { label: 'Última execução' });
  if (!older.length) {
    return el('div', { class: 'settings-run-history' }, latestRow);
  }
  return el('div', { class: 'settings-run-history' }, [
    latestRow,
    el('details', { class: 'settings-run-history__details' }, [
      el('summary', { class: 'settings-run-history__summary' }, `${older.length} execuç${older.length === 1 ? 'ão' : 'ões'} anterior${older.length === 1 ? '' : 'es'}`),
      el('div', { class: 'settings-run-list' }, older.map((run) => renderRunRow(run))),
    ]),
  ]);
}

function renderRunRow(run, { label = null } = {}) {
  const status = run.status || 'completed';
  const statusLabel = RUN_STATUS_LABELS[status] || status;
  const when = formatDateTime(run.completed_at || run.started_at || run.created_at);
  const range = `${run.from_date} → ${run.to_date}`;
  const jobRef = run.prepare_job_id ? `job #${run.prepare_job_id}` : null;
  return el('div', { class: 'settings-run-row' }, [
    el('span', { class: 'settings-run-row__main' }, [
      label ? el('span', { class: 'settings-run-row__label' }, label) : null,
      el('span', { class: `badge badge--compact badge--${runStatusTone(status)}` }, statusLabel),
      el('span', { class: 'settings-run-row__range' }, range),
    ]),
    el('span', { class: 'settings-run-row__meta' }, [jobRef, when].filter(Boolean).join(' · ')),
  ]);
}

async function runScheduleNow(ctx, schedule, fieldOptions, formCtx) {
  const ok = await confirmDialog({
    title: `Executar ${schedule.name}`,
    message: 'Criar agora um job automático até o último dia fechado?',
    detail: `${schedule.underlying} ${schedule.interval} desde ${schedule.start_date}.`,
    confirmLabel: 'Executar agora',
  });
  if (!ok) return;
  const res = await ctx.api.post(`/api/settings/asset-update-schedules/${schedule.id}/run`, {});
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao executar agendamento');
    return;
  }
  ctx.toast.ok(res.data.job ? `Job #${res.data.job.id} criado` : 'Período já estava pronto');
  await refreshSettings(ctx, fieldOptions, formCtx);
}

async function toggleSchedule(ctx, schedule, fieldOptions, formCtx) {
  const res = await ctx.api.patch(`/api/settings/asset-update-schedules/${schedule.id}`, { enabled: !schedule.enabled });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao atualizar agendamento');
    return;
  }
  ctx.toast.ok(schedule.enabled ? 'Agendamento pausado' : 'Agendamento ativado');
  await refreshSettings(ctx, fieldOptions, formCtx);
}

async function deleteSchedule(ctx, schedule, fieldOptions, formCtx) {
  const ok = await confirmDialog({
    title: `Excluir ${schedule.name}`,
    message: 'Remover este agendamento automático?',
    confirmLabel: 'Excluir',
    tone: 'danger',
  });
  if (!ok) return;
  const res = await ctx.api.delete(`/api/settings/asset-update-schedules/${schedule.id}`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao excluir');
    return;
  }
  ctx.toast.ok('Agendamento excluído');
  await refreshSettings(ctx, fieldOptions, formCtx);
}

function stat(label, value) {
  return el('div', { class: 'settings-stat' }, [
    el('span', { class: 'settings-stat__label' }, label),
    el('span', { class: 'settings-stat__value' }, value),
  ]);
}

function frequencyLabel(schedule, timezoneLabel) {
  if (schedule.frequency === 'every_hours') return `a cada ${schedule.every_hours}h`;
  return `diária às ${schedule.time_utc} (${timezoneLabel})`;
}

function formatSchedulerTimezoneLabel(timeZone) {
  return String(timeZone || 'America/Sao_Paulo').replace(/_/g, ' ');
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function simpleSelect(name, options, selected) {
  return el('select', { class: 'field__select', name }, options.map(([value, label]) => {
    const option = el('option', { value }, label);
    if (String(value) === String(selected)) option.selected = true;
    return option;
  }));
}
