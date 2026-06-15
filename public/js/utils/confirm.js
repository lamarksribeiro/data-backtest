import { el } from './dom.js';

/** @type {((value: boolean) => void) | null} */
let activeClose = null;

export function getModalRoot() {
  let root = document.getElementById('modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    document.body.appendChild(root);
  }
  return root;
}

export function confirmDialog({
  title = 'Confirmar ação',
  message,
  detail,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'danger',
}) {
  return new Promise((resolve) => {
    if (activeClose) activeClose(false);
    const root = getModalRoot();
    const confirmClass = tone === 'danger' ? 'btn btn--danger' : 'btn btn--primary';

    function close(result) {
      if (activeClose !== close) return;
      activeClose = null;
      overlay.remove();
      root.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    activeClose = close;

    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    const bodyChildren = [el('p', { class: 'modal__message' }, message)];
    if (detail) bodyChildren.push(el('p', { class: 'modal__detail' }, detail));

    const overlay = el('div', {
      class: 'modal-overlay',
      onclick: (e) => { if (e.target === overlay) close(false); },
    }, [
      el('div', {
        class: `modal modal--${tone}`,
        role: 'dialog',
        'aria-modal': 'true',
        onclick: (e) => e.stopPropagation(),
      }, [
        el('div', { class: 'modal__header' }, [
          el('span', { class: 'modal__icon', 'aria-hidden': 'true' }, tone === 'danger' ? '⚠' : '?'),
          el('h2', { class: 'modal__title' }, title),
        ]),
        el('div', { class: 'modal__body' }, bodyChildren),
        el('div', { class: 'modal__footer' }, [
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => close(false) }, cancelLabel),
          el('button', { class: confirmClass, type: 'button', onclick: () => close(true) }, confirmLabel),
        ]),
      ]),
    ]);

    root.setAttribute('aria-hidden', 'false');
    root.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.btn--ghost')?.focus();
  });
}

export function promptDialog({
  title = 'Confirmação',
  message,
  placeholder = '',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
}) {
  return new Promise((resolve) => {
    if (activeClose) activeClose(false);
    const root = getModalRoot();
    const input = el('input', { class: 'field__input', type: 'text', placeholder });

    function close(result) {
      if (activeClose !== close) return;
      activeClose = null;
      overlay.remove();
      root.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    activeClose = close;

    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
    };

    const overlay = el('div', {
      class: 'modal-overlay',
      onclick: (e) => { if (e.target === overlay) close(null); },
    }, [
      el('div', { class: 'modal modal--primary', role: 'dialog', 'aria-modal': 'true', onclick: (e) => e.stopPropagation() }, [
        el('div', { class: 'modal__header' }, [el('h2', { class: 'modal__title' }, title)]),
        el('div', { class: 'modal__body' }, [
          el('p', { class: 'modal__message' }, message),
          el('div', { class: 'field', style: { marginTop: '12px' } }, [input]),
        ]),
        el('div', { class: 'modal__footer' }, [
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => close(null) }, cancelLabel),
          el('button', { class: 'btn btn--primary', type: 'button', onclick: () => close(input.value) }, confirmLabel),
        ]),
      ]),
    ]);

    root.setAttribute('aria-hidden', 'false');
    root.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    input.focus();
  });
}

/**
 * Modal genérico com conteúdo customizado. Retorna Promise que resolve quando fechado.
 * @param {{ title: string, body: HTMLElement | HTMLElement[], footer?: HTMLElement | HTMLElement[], tone?: string, onMount?: (close: (result?: unknown) => void) => void }} opts
 */
export function customDialog({ title, body, footer, tone = 'primary', onMount }) {
  return new Promise((resolve) => {
    if (activeClose) activeClose(false);
    const root = getModalRoot();

    function close(result = null) {
      if (activeClose !== close) return;
      activeClose = null;
      overlay.remove();
      root.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    activeClose = close;

    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const bodyNodes = Array.isArray(body) ? body : [body];
    const footerNodes = footer != null
      ? (Array.isArray(footer) ? footer : [footer])
      : [el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => close(null) }, 'Fechar')];

    const overlay = el('div', {
      class: 'modal-overlay',
      onclick: (e) => { if (e.target === overlay) close(null); },
    }, [
      el('div', {
        class: `modal modal--${tone}`,
        role: 'dialog',
        'aria-modal': 'true',
        onclick: (e) => e.stopPropagation(),
      }, [
        el('div', { class: 'modal__header' }, [el('h2', { class: 'modal__title' }, title)]),
        el('div', { class: 'modal__body' }, bodyNodes),
        el('div', { class: 'modal__footer' }, footerNodes),
      ]),
    ]);

    root.setAttribute('aria-hidden', 'false');
    root.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    onMount?.(close);
  });
}

const DEFAULT_CONFIRM_PHRASES = [
  'apagar historico',
  'limpar registros',
  'confirmo exclusao',
  'sim limpar tudo',
  'apagar backup local',
  'remover historico',
];

/**
 * Confirmação destrutiva: exige digitar uma frase aleatória exatamente como exibida.
 * @param {{ title?: string, message: string, detail?: string, phrases?: string[], confirmLabel?: string, cancelLabel?: string }} opts
 * @returns {Promise<boolean>}
 */
export function phraseConfirmDialog({
  title = 'Confirmar ação',
  message,
  detail,
  phrases = DEFAULT_CONFIRM_PHRASES,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
}) {
  const phrase = phrases[Math.floor(Math.random() * phrases.length)];

  return new Promise((resolve) => {
    if (activeClose) activeClose(false);
    const root = getModalRoot();
    const input = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Digite a frase acima',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const confirmBtn = el('button', {
      class: 'btn btn--danger',
      type: 'button',
      disabled: true,
    }, confirmLabel);

    function matches() {
      return input.value.trim() === phrase;
    }

    function syncConfirm() {
      confirmBtn.disabled = !matches();
    }

    input.oninput = syncConfirm;

    function close(result) {
      if (activeClose !== close) return;
      activeClose = null;
      overlay.remove();
      root.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    activeClose = close;

    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && matches()) {
        e.preventDefault();
        close(true);
      }
    };

    const bodyChildren = [
      el('p', { class: 'modal__message' }, message),
      detail ? el('p', { class: 'modal__detail' }, detail) : null,
      el('p', { class: 'modal__detail', style: { marginTop: '12px' } }, [
        'Para confirmar, digite exatamente: ',
        el('code', {
          style: {
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-0)',
            userSelect: 'all',
          },
        }, phrase),
      ]),
      el('label', { class: 'field', style: { marginTop: '10px' } }, [input]),
    ].filter(Boolean);

    const overlay = el('div', {
      class: 'modal-overlay',
      onclick: (e) => { if (e.target === overlay) close(false); },
    }, [
      el('div', {
        class: 'modal modal--danger',
        role: 'dialog',
        'aria-modal': 'true',
        onclick: (e) => e.stopPropagation(),
      }, [
        el('div', { class: 'modal__header' }, [
          el('span', { class: 'modal__icon', 'aria-hidden': 'true' }, '⚠'),
          el('h2', { class: 'modal__title' }, title),
        ]),
        el('div', { class: 'modal__body' }, bodyChildren),
        el('div', { class: 'modal__footer' }, [
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => close(false) }, cancelLabel),
          confirmBtn,
        ]),
      ]),
    ]);

    confirmBtn.onclick = () => { if (matches()) close(true); };

    root.setAttribute('aria-hidden', 'false');
    root.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    input.focus();
  });
}
