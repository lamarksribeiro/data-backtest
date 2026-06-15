import { el } from '../utils/dom.js';

const TAB_STYLES = `
  .settings-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 18px 0 0;
    padding-bottom: 2px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .settings-tabs__tab {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 10px 10px 0 0;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  }

  .settings-tabs__tab:hover {
    color: var(--text-0);
    background: rgba(255, 255, 255, 0.03);
  }

  .settings-tabs__tab.is-active {
    color: var(--text-0);
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.08);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .settings-tabs__icon {
    opacity: 0.8;
    font-size: 12px;
  }
`;

const TABS = [
  { id: 'sync', route: 'settings', label: 'Sincronização Parquet', icon: 'fa-clock' },
  { id: 'cache', route: 'settings/cache', label: 'Cache de backtest', icon: 'fa-bolt' },
  { id: 'backup', route: 'settings/backup', label: 'Backup Telegram', icon: 'fa-paper-plane' },
];

export function ensureSettingsTabStyles() {
  if (!document.getElementById('settings-tabs-styles')) {
    document.head.appendChild(el('style', { id: 'settings-tabs-styles' }, TAB_STYLES));
  }
}

export function renderSettingsTabs(activeTab) {
  ensureSettingsTabStyles();
  return el('nav', { class: 'settings-tabs', 'aria-label': 'Seções de configuração' }, TABS.map((tab) => {
    const link = el('a', {
      class: `settings-tabs__tab${tab.id === activeTab ? ' is-active' : ''}`,
      href: `#/${tab.route}`,
    }, [
      el('span', { class: 'settings-tabs__icon', 'aria-hidden': 'true' }, el('i', { class: `fa-solid ${tab.icon}` })),
      tab.label,
    ]);
    return link;
  }));
}
