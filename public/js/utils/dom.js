export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset' && typeof v === 'object') {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, v);
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(parent, children) {
  if (children == null || children === false) return;
  if (Array.isArray(children)) {
    for (const c of children) appendChildren(parent, c);
    return;
  }
  if (children instanceof Node) {
    parent.appendChild(children);
    return;
  }
  parent.appendChild(document.createTextNode(String(children)));
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(target, content) {
  clear(target);
  appendChildren(target, content);
  enhanceResponsiveTables(target);
}

export function enhanceResponsiveTables(root = document) {
  if (!root) return;
  const tables = [];
  if (root instanceof HTMLTableElement) tables.push(root);
  if (root.querySelectorAll) tables.push(...root.querySelectorAll('table'));
  for (const table of tables) {
    const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim()).filter(Boolean);
    if (!headers.length) continue;
    table.dataset.responsiveCard = 'true';
    for (const row of table.querySelectorAll('tbody tr')) {
      let headerIndex = 0;
      for (const cell of row.children) {
        if (!(cell instanceof HTMLTableCellElement)) continue;
        const colspan = Number(cell.getAttribute('colspan') || 1);
        if (colspan === 1 && !cell.hasAttribute('data-label') && headers[headerIndex]) {
          cell.setAttribute('data-label', headers[headerIndex]);
        }
        headerIndex += colspan;
      }
    }
  }
}

export function emptyState(message) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty__icon', 'aria-hidden': 'true' }, '∅'),
    el('p', { class: 'empty__text' }, message),
  ]);
}
