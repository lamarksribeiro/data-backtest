import { initRouter, navigate, getRouteToken } from './js/router.js';
import { destroyActiveChart } from './js/utils/chart.js';
import { cancelBacktestPolls } from './js/views/backtests.js';
import { api } from './js/api.js';
import { toast } from './js/utils/toast.js';
import { applyContextOptions, contextBarOptions, loadContext, renderContextBar as renderContextControls } from './js/utils/context.js';
import { fetchContextOptionsCached } from './js/utils/contextOptionsCache.js';
import { startSidebarStatus } from './js/utils/sidebarStatus.js';
import { renderOverview } from './js/views/overview.js';
import { renderLakehouse } from './js/views/lakehouse.js';
import { renderJobs } from './js/views/jobs.js';
import { renderBacktests } from './js/views/backtests.js';
import { renderRunDetail } from './js/views/run-detail.js';
import { renderEventDetail } from './js/views/event-detail.js';
import { renderStudio, redirectLegacyBacktestRoute } from './js/views/studio.js';
import { renderStrategies } from './js/views/strategies.js';

const contentEl = document.getElementById('content');
const backButton = document.getElementById('nav-back');
const crumbSection = document.getElementById('crumb-section');
const crumbDetail = document.getElementById('crumb-detail');
const crumbSep = document.getElementById('crumb-sep');
const topbarActions = document.getElementById('topbar-actions');

const SECTIONS = {
  studio: 'Estúdio',
  overview: 'Visão Geral',
  data: 'Dados',
  jobs: 'Jobs',
  backtests: 'Backtests',
  strategies: 'Estratégias',
};

const SECTION_ROUTES = {
  studio: 'studio',
  overview: 'overview',
  data: 'data',
  jobs: 'jobs',
  backtests: 'backtests',
  strategies: 'strategies',
};

let currentRoute = '';
let previousRoute = '';
let currentSection = 'overview';

function topLevelRoute(route) {
  const path = String(route || '').split('?')[0].replace(/^\/+/, '');
  return path && !path.includes('/');
}

function parentRouteFor(route) {
  const path = String(route || '').split('?')[0];
  if (path.startsWith('backtests/') && path.includes('/events/')) {
    const runId = path.split('/')[1];
    return `backtests/${runId}`;
  }
  if (path.startsWith('backtests/')) return 'backtests';
  if (path.startsWith('strategies/')) return 'strategies';
  return SECTION_ROUTES[currentSection] || 'overview';
}

function navigateBack() {
  if (previousRoute && previousRoute !== currentRoute) {
    history.back();
    return;
  }
  navigate(parentRouteFor(currentRoute));
}

function updateBackButton(route) {
  if (!backButton) return;
  const show = !topLevelRoute(route);
  backButton.hidden = !show;
  
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.classList.toggle('has-back-route', show);
  }
}

backButton?.addEventListener('click', navigateBack);

const ctx = {
  contentEl,
  topbarActions,
  setBreadcrumb(section, detail) {
    currentSection = section;
    const route = SECTION_ROUTES[section] || section;
    crumbSection.textContent = SECTIONS[section] || section;
    crumbSection.disabled = !route || currentRoute === route;
    crumbSection.onclick = route ? () => navigate(route) : null;
    if (detail) {
      crumbDetail.hidden = false;
      crumbSep.hidden = false;
      crumbDetail.textContent = detail;
    } else {
      crumbDetail.hidden = true;
      crumbSep.hidden = true;
      crumbDetail.textContent = '';
    }
  },
  setConnection(status, label) {
    document.querySelectorAll('.connection-dot').forEach((dot) => {
      dot.className = `dot dot--${status} connection-dot` + (status === 'ok' ? ' dot--pulse' : '');
    });
    document.querySelectorAll('.connection-label').forEach((el) => {
      el.textContent = label;
    });
  },
  renderContextBar() {
    renderTopContextBar();
  },
  toast,
  api,
  navigate,
  getRouteToken,
};

ctx.setConnection('idle', 'Conectando…');

async function renderTopContextBar() {
  if (!topbarActions) return;
  const route = String(currentRoute || '').split('?')[0].split('/')[0];
  if (route !== 'studio' && route !== 'backtests') {
    topbarActions.innerHTML = '';
    return;
  }
  const apiOptions = await fetchContextOptionsCached(api);
  const fieldOptions = contextBarOptions(apiOptions);
  const formCtx = applyContextOptions(loadContext(), fieldOptions);
  topbarActions.innerHTML = '';
  topbarActions.appendChild(renderContextControls(formCtx, (next) => {
    if (route === 'studio') renderStudio(ctx);
    else renderBacktests(ctx);
  }, fieldOptions));
}

async function bootstrap() {
  const meRes = await api.get('/api/me');
  if (!meRes.ok) {
    location.href = '/login';
    return;
  }

  startSidebarStatus(ctx);
  initRouter({
    routes: {
      studio: () => renderStudio(ctx),
      overview: () => renderOverview(ctx),
      data: () => renderLakehouse(ctx),
      jobs: () => renderJobs(ctx),
      backtests: () => renderBacktests(ctx),
      'backtests/:id': (params) => redirectLegacyBacktestRoute({ id: params.id }),
      'backtests/:id/events/:eventId': (params) => redirectLegacyBacktestRoute({ id: params.id, eventId: params.eventId }),
      strategies: () => renderStrategies(ctx),
      'strategies/:id': (params) => renderStrategies(ctx, params),
      'strategies/:id/:versionId': (params) => renderStrategies(ctx, params),
    },
    fallback: 'studio',
    onLeave(path) {
      const top = String(path || '').split('?')[0].split('/')[0];
      if (top !== 'backtests') cancelBacktestPolls();
      if (!String(path || '').startsWith('backtests/')) destroyActiveChart();
    },
    onChange: highlightNav,
  });
}

function initMobileNav() {
  const menuBtn = document.getElementById('menu-btn');
  const mobileNav = document.getElementById('mobile-nav');
  if (!menuBtn || !mobileNav) return;

  const backdrop = mobileNav.querySelector('.mobile-nav__backdrop');
  const closeBtn = mobileNav.querySelector('.mobile-nav__close');

  function setOpen(open) {
    mobileNav.classList.toggle('is-open', open);
    menuBtn.classList.toggle('is-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    mobileNav.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('nav-open', open);
  }

  menuBtn.addEventListener('click', () => setOpen(!mobileNav.classList.contains('is-open')));
  backdrop?.addEventListener('click', () => setOpen(false));
  closeBtn?.addEventListener('click', () => setOpen(false));
  mobileNav.querySelectorAll('.navlink').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });
  window.addEventListener('hashchange', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
}

function highlightNav(route) {
  if (route !== currentRoute) {
    previousRoute = currentRoute;
    currentRoute = route;
  }
  updateBackButton(route);
  const top = route.split('?')[0].split('/')[0];
  document.querySelectorAll('.navlink').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.route === top);
  });
}

document.querySelectorAll('[data-action="logout"]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await api.post('/api/logout');
    location.href = '/login';
  });
});

initMobileNav();
bootstrap();
