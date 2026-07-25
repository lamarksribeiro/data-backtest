import { el } from './dom.js';
import {
  applyDateSelectionDefaults,
  clampToAvailableEnd,
  contextDateKey,
  normalizeContextDateTime,
} from './dateRange.js';

/**
 * Campo datetime-local com botão de calendário visível e defaults de horário.
 * @param {{ name: string, value?: string, end?: boolean, className?: string, inputClass?: string, getInterval?: () => string }} opts
 */
export function datetimeField({
  name,
  value = '',
  end = false,
  className = 'datetime-field',
  inputClass = 'field__input datetime-field__input',
  getInterval = () => '5m',
} = {}) {
  const resolveInterval = () => getInterval() || '5m';
  const initial = normalizeContextDateTime(value, { end, interval: resolveInterval() });
  const wrap = el('div', { class: className });
  const input = el('input', {
    type: 'datetime-local',
    name,
    value: initial,
    class: inputClass,
    title: end
      ? 'Data e hora final (incluso), até o último evento completo do intervalo. Clique no calendário para escolher.'
      : 'Data e hora inicial. Clique no calendário para escolher.',
  });
  const pickerBtn = el('button', {
    type: 'button',
    class: 'datetime-field__button',
    title: 'Abrir seletor de data e hora',
    'aria-label': 'Abrir seletor de data e hora',
  }, el('i', { class: 'fa-regular fa-calendar', 'aria-hidden': 'true' }));

  let previousDateKey = contextDateKey(initial);

  pickerBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openDateTimePicker(input);
  });

  input.addEventListener('change', () => {
    const next = applyDateSelectionDefaults(input.value, {
      end,
      previousDateKey,
      interval: resolveInterval(),
    });
    if (next !== input.value) {
      input.value = next;
    }
    previousDateKey = contextDateKey(input.value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  wrap.append(input, pickerBtn);
  return wrap;
}

/** Liga defaults de horário em inputs datetime-local já montados (ex.: context-bar). */
export function bindDateTimeDefaults(root, {
  fromName = 'from',
  toName = 'to',
  intervalName = 'interval',
} = {}) {
  const scope = root || document;
  const getInterval = () => scope.querySelector(`[name="${intervalName}"]`)?.value || '5m';
  bindOne(scope.querySelector(`[name="${fromName}"]`), { end: false, getInterval });
  bindOne(scope.querySelector(`[name="${toName}"]`), { end: true, getInterval });

  const intervalInput = scope.querySelector(`[name="${intervalName}"]`);
  const toInput = scope.querySelector(`[name="${toName}"]`);
  if (intervalInput && toInput && intervalInput.dataset.datetimeIntervalBound !== '1') {
    intervalInput.dataset.datetimeIntervalBound = '1';
    intervalInput.addEventListener('change', () => {
      const next = clampToAvailableEnd(toInput.value, new Date(), getInterval());
      if (next !== toInput.value) toInput.value = next;
    });
  }
}

function bindOne(input, { end, getInterval }) {
  if (!input || input.dataset.datetimeDefaultsBound === '1') return;
  input.dataset.datetimeDefaultsBound = '1';
  input.classList.add('datetime-field__input');
  let previousDateKey = contextDateKey(input.value);

  const parent = input.parentElement;
  if (parent && !parent.classList.contains('datetime-field')) {
    const wrap = document.createElement('div');
    wrap.className = parent.classList.contains('context-bar__field')
      ? 'datetime-field datetime-field--inline'
      : 'datetime-field';
    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    const pickerBtn = document.createElement('button');
    pickerBtn.type = 'button';
    pickerBtn.className = 'datetime-field__button';
    pickerBtn.title = 'Abrir seletor de data e hora';
    pickerBtn.setAttribute('aria-label', 'Abrir seletor de data e hora');
    pickerBtn.innerHTML = '<i class="fa-regular fa-calendar" aria-hidden="true"></i>';
    pickerBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDateTimePicker(input);
    });
    wrap.appendChild(pickerBtn);
  }

  input.addEventListener('change', () => {
    const next = applyDateSelectionDefaults(input.value, {
      end,
      previousDateKey,
      interval: getInterval() || '5m',
    });
    if (next !== input.value) {
      input.value = next;
    }
    previousDateKey = contextDateKey(input.value);
  });
}

function openDateTimePicker(input) {
  if (typeof input.showPicker === 'function') {
    try {
      input.showPicker();
      return;
    } catch {
      // showPicker pode falhar sem gesto de usuário / browser antigo
    }
  }
  input.focus();
  input.click();
}
