import { el } from './dom.js';

let openTooltip = null;

function closeOpenTooltip() {
  if (!openTooltip) return;
  openTooltip.classList.remove('field-help--open');
  openTooltip.querySelector('button')?.setAttribute('aria-expanded', 'false');
  openTooltip = null;
}

document.addEventListener('click', (event) => {
  if (openTooltip && !openTooltip.contains(event.target)) {
    closeOpenTooltip();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeOpenTooltip();
});

function fieldHelp(helpText) {
  const help = el('span', { class: 'field-help' }, [
    el('button', {
      type: 'button',
      class: 'field-help__trigger',
      'aria-label': 'Ajuda',
      'aria-expanded': 'false',
      onclick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        const wasOpen = help.classList.contains('field-help--open');
        closeOpenTooltip();
        if (!wasOpen) {
          help.classList.add('field-help--open');
          help.querySelector('button').setAttribute('aria-expanded', 'true');
          openTooltip = help;
        }
      },
    }, '?'),
    el('span', { class: 'field-help__popover', role: 'tooltip' }, helpText),
  ]);
  return help;
}

export function fieldLabelWithHelp(label, helpText) {
  return el('span', { class: 'field__label-row' }, [
    el('span', { class: 'field__label' }, label),
    fieldHelp(helpText),
  ]);
}
