import { el } from '../utils/dom.js';

const TABS = [
  { id: 'sync', route: 'settings', label: 'Sincronização' },
  { id: 'cache', route: 'settings/cache', label: 'Cache' },
  { id: 'backup', route: 'settings/backup', label: 'Backup Telegram' },
];

export function renderSettingsTabs(activeTab) {
  return el('nav', { class: 'settings-tabs', 'aria-label': 'Seções de configuração' }, TABS.map((tab) => el('a', {
    class: `settings-tabs__tab${tab.id === activeTab ? ' is-active' : ''}`,
    href: `#/${tab.route}`,
    'aria-current': tab.id === activeTab ? 'page' : undefined,
  }, tab.label)));
}

export function renderSettingsPage(activeTab, content) {
  const nodes = Array.isArray(content) ? content : [content];
  return el('div', { class: 'settings-page' }, [
    renderSettingsTabs(activeTab),
    ...nodes,
  ]);
}
