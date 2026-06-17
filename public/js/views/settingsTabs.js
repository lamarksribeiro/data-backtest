import { el } from '../utils/dom.js';

const TAB_STYLES = `
  .settings-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 12px 0 20px 0;
    padding: 5px;
    border-radius: 10px;
    background: rgba(13, 19, 32, 0.45);
    border: 1px solid var(--border);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    width: fit-content;
  }

  .settings-tabs__tab {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font-size: 13.5px;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .settings-tabs__tab:hover {
    color: var(--text-0);
    background: rgba(255, 255, 255, 0.04);
  }

  .settings-tabs__tab.is-active {
    color: var(--text-0);
    background: linear-gradient(135deg, var(--accent), var(--accent-strong));
    box-shadow: 0 4px 12px rgba(249, 115, 22, 0.25);
  }

  .settings-tabs__icon {
    font-size: 13px;
    transition: transform 0.25s ease;
  }

  .settings-tabs__tab:hover .settings-tabs__icon {
    transform: scale(1.1);
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
