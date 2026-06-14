import { el, mount, emptyState } from '../utils/dom.js';
import { confirmDialog } from '../utils/confirm.js';
import { applyContextOptions, contextBarOptions, loadContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';

const settingsStyles = `
  .settings-grid {
    display: grid;
    grid-template-columns: minmax(300px, 420px) 1fr;
    gap: 24px;
    align-items: start;
    margin-top: 18px;
  }

  @media (max-width: 1050px) {
    .settings-grid { grid-template-columns: 1fr; }
  }

  .settings-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .settings-form label.field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-weight: 500;
    font-size: 12.5px;
    color: var(--text-2);
  }

  .settings-form__row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  @media (max-width: 640px) {
    .settings-form__row { grid-template-columns: 1fr; }
  }

  .settings-hint {
    margin: 2px 0 0;
    color: var(--text-3);
    font-size: 11.5px;
    line-height: 1.45;
  }

  .schedule-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .schedule-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: var(--radius);
    background: linear-gradient(180deg, rgba(30, 41, 59, 0.54), rgba(15, 23, 42, 0.42));
  }

  .schedule-card.is-disabled { opacity: 0.62; }

  .schedule-card__head {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    align-items: flex-start;
  }

  .schedule-card__title {
    margin: 0;
    font-size: 15px;
    color: var(--text-0);
  }

  .schedule-card__meta {
    margin: 5px 0 0;
    color: var(--text-2);
    font-size: 12px;
  }

  .schedule-card__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
  }

  .schedule-stat {
    padding: 10px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.025);
  }

  .schedule-stat__label {
    display: block;
    color: var(--text-3);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-bottom: 5px;
  }

  .schedule-stat__value {
    color: var(--text-0);
    font-size: 12px;
    font-family: var(--font-mono, monospace);
  }

  .schedule-card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  @media (max-width: 480px) {
    .schedule-card__head {
      flex-direction: column;
      align-items: stretch;
    }

    .schedule-card__grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  .schedule-run-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .schedule-run {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-2);
    font-size: 11.5px;
  }

  .schedule-run code { color: var(--text-0); }
`;

export async function renderSettings(ctx) {
  ctx.setBreadcrumb('settings', 'Configurações');
  ctx.renderContextBar?.();

  if (!document.getElementById('settings-custom-styles')) {
    document.head.appendChild(el('style', { id: 'settings-custom-styles' }, settingsStyles));
  }

  mount(ctx.contentEl, el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Carregando configurações…')));
  const apiOptions = await fetchContextOptionsCached(ctx.api);
  const fieldOptions = contextBarOptions(apiOptions);
  const formCtx = applyContextOptions(loadContext(), fieldOptions);
  await refreshSettings(ctx, fieldOptions, formCtx);
}

async function refreshSettings(ctx, fieldOptions, formCtx = loadContext()) {
  const res = await ctx.api.get('/api/settings/asset-update-schedules');
  if (!res.ok) {
    mount(ctx.contentEl, el('p', { class: 'bad' }, res.error?.message || 'Falha ao carregar configurações'));
    return;
  }
  renderSettingsPage(ctx, fieldOptions, formCtx, res.data.schedules || [], res.data.target_to_date);
}

function renderSettingsPage(ctx, fieldOptions, formCtx, schedules, targetToDate) {
  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Configurações'),
        el('p', { class: 'page-header__sub' }, 'Automatize a preparação dos ativos antes dos backtests.'),
      ]),
    ]),
    el('div', { class: 'settings-grid' }, [
      el('section', { class: 'card' }, [
        el('h2', { class: 'card__title' }, 'Novo agendamento'),
        el('p', { class: 'settings-hint' }, `Cada execução atualiza somente até ${targetToDate || 'o último dia fechado'} e reaproveita o mesmo pipeline dos jobs manuais.`),
        renderScheduleForm(ctx, fieldOptions, formCtx),
      ]),
      el('section', { class: 'card' }, [
        el('div', { class: 'card__header' }, [
          el('div', {}, [
            el('h2', { class: 'card__title' }, 'Agendamentos ativos'),
            el('p', { class: 'settings-hint' }, 'Use um agendamento por combinação de ativo, intervalo e book.'),
          ]),
          el('span', { class: 'badge badge--ok' }, `Alvo: ${targetToDate || 'ontem UTC'}`),
        ]),
        schedules.length ? el('div', { class: 'schedule-list' }, schedules.map((schedule) => renderScheduleCard(ctx, schedule, fieldOptions, formCtx))) : emptyState('Nenhum agendamento criado.'),
      ]),
    ]),
  ]);
}

function renderScheduleForm(ctx, fieldOptions, formCtx) {
  const frequencySelect = simpleSelect('frequency', [
    ['daily', 'Diária'],
    ['every_hours', 'A cada N horas'],
  ], 'daily');

  const form = el('form', { class: 'settings-form', id: 'asset-update-schedule-form' }, [
    el('label', { class: 'field' }, ['Nome ', el('input', { class: 'field__input', name: 'name', value: `${formCtx.underlying} ${formCtx.interval} automático` })]),
    el('div', { class: 'settings-form__row' }, [
      el('label', { class: 'field' }, ['Ativo ', selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying)]),
      el('label', { class: 'field' }, ['Intervalo ', selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval)]),
    ]),
    el('div', { class: 'settings-form__row' }, [
      el('label', { class: 'field' }, ['Book ', selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth)]),
      el('label', { class: 'field' }, ['Cobrir desde ', el('input', { class: 'field__input', type: 'date', name: 'start_date', value: formCtx.from })]),
    ]),
    el('div', { class: 'settings-form__row' }, [
      el('label', { class: 'field' }, ['Frequência ', frequencySelect]),
      el('label', { class: 'field' }, ['Horário UTC ', el('input', { class: 'field__input', type: 'time', name: 'time_utc', value: '03:00' })]),
    ]),
    el('label', { class: 'field' }, ['Intervalo em horas ', el('input', { class: 'field__input', type: 'number', min: '1', max: '168', name: 'every_hours', value: '24' })]),
    el('label', { class: 'field field--checkbox' }, [
      el('input', { type: 'checkbox', name: 'enabled', value: '1', checked: true }),
      ' Ativar após criar',
    ]),
    el('p', { class: 'settings-hint' }, 'O agendamento nunca tenta preparar o dia corrente. Se hoje é dia 13 UTC, o limite automático é dia 12.'),
    el('button', { type: 'submit', class: 'btn btn--primary' }, 'Criar agendamento'),
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

function renderScheduleCard(ctx, schedule, fieldOptions, formCtx) {
  const activeRun = schedule.active_run;
  return el('article', { class: `schedule-card${schedule.enabled ? '' : ' is-disabled'}` }, [
    el('div', { class: 'schedule-card__head' }, [
      el('div', {}, [
        el('h3', { class: 'schedule-card__title' }, schedule.name),
        el('p', { class: 'schedule-card__meta' }, `${schedule.underlying} · ${schedule.interval} · book ${schedule.book_depth}`),
      ]),
      el('span', { class: `badge badge--${schedule.enabled ? 'ok' : 'warn'}` }, schedule.enabled ? 'Ativo' : 'Pausado'),
    ]),
    el('div', { class: 'schedule-card__grid' }, [
      stat('Cobertura', `${schedule.start_date} → ontem UTC`),
      stat('Frequência', frequencyLabel(schedule)),
      stat('Próxima', formatDateTime(schedule.next_run_at) || 'pausado'),
      stat('Último sucesso', formatDateTime(schedule.last_success_at) || 'nunca'),
    ]),
    schedule.last_error ? el('p', { class: 'bad', style: { margin: 0, fontSize: '12px' } }, schedule.last_error) : null,
    activeRun ? el('p', { class: 'settings-hint' }, `Execução ativa: ${activeRun.status}${activeRun.prepare_job_id ? ` · job #${activeRun.prepare_job_id}` : ''}`) : null,
    el('div', { class: 'schedule-card__actions' }, [
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
    renderRecentRuns(schedule.recent_runs || []),
  ]);
}

function renderRecentRuns(runs) {
  if (!runs.length) return null;
  return el('div', { class: 'schedule-run-list' }, runs.slice(0, 3).map((run) => el('div', { class: 'schedule-run' }, [
    el('span', {}, [el('code', {}, run.status), ` · ${run.from_date} → ${run.to_date}`]),
    el('span', {}, run.prepare_job_id ? `job #${run.prepare_job_id}` : formatDateTime(run.completed_at || run.created_at)),
  ])));
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
  return el('div', { class: 'schedule-stat' }, [
    el('span', { class: 'schedule-stat__label' }, label),
    el('span', { class: 'schedule-stat__value' }, value),
  ]);
}

function frequencyLabel(schedule) {
  if (schedule.frequency === 'every_hours') return `a cada ${schedule.every_hours}h`;
  return `diária ${schedule.time_utc} UTC`;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function simpleSelect(name, options, selected) {
  const select = el('select', { class: 'field__input', name }, options.map(([value, label]) => {
    const option = el('option', { value }, label);
    if (String(value) === String(selected)) option.selected = true;
    return option;
  }));
  return select;
}
