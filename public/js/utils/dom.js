import { destroyChartsIn } from './uplotChart.js';

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'innerHTML') {
      node.innerHTML = v;
    } else if (k === 'dataset' && typeof v === 'object') {
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
  if (node) destroyChartsIn(node);
  while (node?.firstChild) node.removeChild(node.firstChild);
}

const tableEnhancements = new WeakMap();

export function mount(target, content) {
  teardownEnhancedTables(target);
  clear(target);
  appendChildren(target, content);
  enhanceResponsiveTables(target);
}

export function teardownEnhancedTables(root) {
  if (!root) return;
  const tables = [];
  if (root instanceof HTMLTableElement) tables.push(root);
  if (root.querySelectorAll) tables.push(...root.querySelectorAll('table'));
  for (const table of tables) {
    const cleanup = tableEnhancements.get(table);
    if (cleanup) {
      cleanup();
      tableEnhancements.delete(table);
    }
  }
}

export function enhanceResponsiveTables(root = document) {
  if (!root) return;
  const tables = [];
  if (root instanceof HTMLTableElement) tables.push(root);
  if (root.querySelectorAll) tables.push(...root.querySelectorAll('table'));
  for (const table of tables) {
    enhanceDataTable(table);
    const headers = [...(table.querySelector('thead tr')?.querySelectorAll('th') || [])]
      .map((th) => th.textContent.trim())
      .filter(Boolean);
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

function shouldSkipTableEnhance(table) {
  return table.classList.contains('strategy-history-table')
    || table.dataset.tableEnhance === 'off';
}

function enhanceDataTable(table) {
  if (shouldSkipTableEnhance(table)) return;
  if (table.dataset.controlsEnhanced === 'true') return;
  const headerRow = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  if (!headerRow || !tbody) return;

  const headers = [...headerRow.querySelectorAll('th')].map((th) => th.textContent.trim());
  if (!headers.length) return;

  table.dataset.controlsEnhanced = 'true';
  const state = {
    filters: headers.map(() => ''),
    page: 1,
    pageSize: 25,
  };

  const filterRow = el('tr', { class: 'table-filter-row' }, headers.map((header, index) => el('th', {}, [
    el('input', {
      class: 'table-filter-input',
      type: 'search',
      placeholder: header ? `Filtrar ${header}` : 'Filtrar',
      oninput: (event) => {
        state.filters[index] = event.target.value.trim().toLowerCase();
        state.page = 1;
        render();
      },
    }),
  ])));
  table.querySelector('thead')?.appendChild(filterRow);

  const pageSizeSelect = el('select', { class: 'table-page-size' }, [10, 25, 50, 100, 'all'].map((value) => {
    const option = el('option', { value: String(value) }, value === 'all' ? 'Todos' : String(value));
    if (value === 25) option.selected = true;
    return option;
  }));
  pageSizeSelect.addEventListener('change', () => {
    state.pageSize = pageSizeSelect.value === 'all' ? Infinity : Number(pageSizeSelect.value);
    state.page = 1;
    render();
  });

  const previousButton = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Anterior');
  const nextButton = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Próxima');
  const info = el('span', { class: 'table-pagination__info' }, '');
  previousButton.addEventListener('click', () => {
    state.page = Math.max(1, state.page - 1);
    render();
  });
  nextButton.addEventListener('click', () => {
    state.page += 1;
    render();
  });

  const controls = el('div', { class: 'table-controls' }, [
    el('div', { class: 'table-controls__left' }, [
      el('span', { class: 'muted' }, 'Linhas'),
      pageSizeSelect,
    ]),
    el('div', { class: 'table-pagination' }, [previousButton, info, nextButton]),
  ]);
  table.parentNode?.insertBefore(controls, table.nextSibling);

  const observer = new MutationObserver(() => render());
  observer.observe(tbody, { childList: true });
  tableEnhancements.set(table, () => {
    observer.disconnect();
    controls.remove();
    filterRow.remove();
    delete table.dataset.controlsEnhanced;
    delete table.dataset.responsiveCard;
  });
  render();

  function render() {
    const rows = [...tbody.querySelectorAll('tr')];
    const filtered = rows.filter((row) => rowMatchesFilters(row, state.filters));
    const totalPages = state.pageSize === Infinity ? 1 : Math.max(1, Math.ceil(filtered.length / state.pageSize));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const start = state.pageSize === Infinity ? 0 : (state.page - 1) * state.pageSize;
    const end = state.pageSize === Infinity ? filtered.length : start + state.pageSize;
    const visible = new Set(filtered.slice(start, end));

    for (const row of rows) row.hidden = !visible.has(row);

    previousButton.disabled = state.page <= 1;
    nextButton.disabled = state.page >= totalPages;
    info.textContent = `${filtered.length} de ${rows.length} linhas · página ${state.page}/${totalPages}`;
  }
}

function rowMatchesFilters(row, filters) {
  return filters.every((filter, index) => {
    if (!filter) return true;
    const cell = row.children[index];
    return String(cell?.textContent || '').toLowerCase().includes(filter);
  });
}

export function emptyState(message) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty__icon', 'aria-hidden': 'true' }, '∅'),
    el('p', { class: 'empty__text' }, message),
  ]);
}
