import { el, mount } from '../utils/dom.js';
import { fetchHealthzCached } from '../utils/healthzCache.js';
import { renderUplotLine } from '../utils/uplotChart.js';
import { formatPnl } from '../utils/format.js';

export async function renderOverview(ctx) {
  ctx.setBreadcrumb('overview', null);
  ctx.renderContextBar?.();

  // 1. Layout inicial de carregamento / skeleton
  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Visão Geral'),
        el('p', { class: 'page-header__sub' }, 'Saúde do sistema, portfólio de estratégias e desempenho acumulado de backtests.'),
      ]),
      el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => ctx.navigate('studio') }, 'Abrir Estúdio'),
    ]),
    el('div', { class: 'grid grid--4', id: 'overview-stats' }, [
      el('div', { class: 'stat stat--idle' }, [el('span', { class: 'stat__label' }, 'Carregando'), el('span', { class: 'stat__value' }, '…')]),
    ]),
    el('div', { class: 'grid grid--7-3 gap-md', style: { marginTop: '16px', alignItems: 'stretch' } }, [
      el('section', { class: 'card', id: 'overview-chart-card' }, [
        el('h2', { class: 'card__title' }, 'Curva de Capital Consolidada'),
        el('p', { class: 'muted', style: { marginBottom: '16px' } }, 'Evolução acumulada do PnL de todas as simulações de backtest concluídas.'),
        el('div', { id: 'overview-equity-chart', class: 'studio-equity', style: { minHeight: '220px' } }),
      ]),
      el('section', { class: 'card', id: 'overview-actions-card', style: { display: 'flex', flexDirection: 'column', gap: '12px' } }),
    ]),
    el('div', { class: 'grid grid--2 gap-md', style: { marginTop: '16px' } }, [
      el('section', { class: 'card', id: 'overview-health-detail' }),
      el('section', { class: 'card', id: 'overview-top-runs' }),
    ]),
  ]);

  // Renderiza ações rápidas
  renderQuickActions(ctx);

  try {
    // 2. Chamadas de APIs paralelas
    const [healthRes, strategiesRes, runsRes] = await Promise.all([
      fetchHealthzCached({ force: true }),
      ctx.api.get('/api/strategies?stats=1'),
      ctx.api.get('/api/backtest/runs?limit=100'),
    ]);

    const health = healthRes.body || {};
    const stats = health.manifest || {};
    const strategies = strategiesRes.ok ? strategiesRes.data.strategies || [] : [];
    const runs = runsRes.ok ? runsRes.data.runs || [] : [];

    // Calcular estatísticas
    const completedRuns = runs.filter((r) => r.status === 'completed' && r.summary);
    const profitableRuns = completedRuns.filter((r) => Number(r.summary.totalPnl || 0) > 0);
    const globalWinRate = completedRuns.length ? Math.round((profitableRuns.length / completedRuns.length) * 100) : 0;
    const totalPnl = completedRuns.reduce((s, r) => s + Number(r.summary.totalPnl || 0), 0);
    const activeRunsCount = runs.filter((r) => r.status === 'running' || r.status === 'queued').length;

    // Atualizar os cards de estatísticas rápidas
    mount(document.getElementById('overview-stats'), [
      statCard('Status do Sistema', health.status === 'ok' ? 'Operacional' : 'Alerta', health.status === 'ok' ? 'ok' : 'warn'),
      statCard('Estratégias', `${strategies.length} definidas`, 'idle', `${strategies.reduce((acc, s) => acc + (s.versions_count || 1), 0)} versões`),
      statCard('Execuções de Backtest', `${runs.length} runs`, activeRunsCount > 0 ? 'warn' : 'idle', activeRunsCount > 0 ? `${activeRunsCount} ativas` : 'Nenhuma ativa'),
      statCard('Desempenho Geral', `${globalWinRate}% WR`, totalPnl >= 0 ? 'ok' : 'err', `Total PnL: ${formatPnl(totalPnl)}`),
    ]);

    // Renderizar gráfico da curva de capital consolidada
    const chartContainer = document.getElementById('overview-equity-chart');
    if (chartContainer) {
      const completedSorted = [...completedRuns].sort((a, b) => Number(a.id) - Number(b.id));
      if (completedSorted.length >= 2) {
        let cumPnl = 0;
        const equityData = completedSorted.map((r) => {
          cumPnl += Number(r.summary.totalPnl || 0);
          const time = r.created_at ? new Date(r.created_at).getTime() : Date.now();
          return [time, cumPnl];
        });
        renderUplotLine(chartContainer, equityData);
      } else {
        mount(chartContainer, el('div', { class: 'empty-state', style: { padding: '40px 0', textAlign: 'center' } }, [
          el('p', { class: 'muted' }, 'Dados insuficientes para desenhar a curva de capital. Execute pelo menos 2 backtests completos.'),
        ]));
      }
    }

    // Renderizar informações detalhadas de saúde
    mount(document.getElementById('overview-health-detail'), [
      el('h2', { class: 'card__title' }, 'Diagnósticos e Logs'),
      el('div', { class: 'health-detail-grid', style: { marginTop: '12px' } }, [
        detailRow('Lake root', health.lake_root || '-'),
        detailRow('State DB', health.state_db_path || '-'),
        detailRow('Fingerprint lake', health.lake_fingerprint || '-'),
        detailRow('Uptime', formatUptime(health.uptime_sec)),
      ]),
    ]);

    // Renderizar melhores execuções de backtest
    const bestRuns = [...completedRuns]
      .sort((a, b) => Number(b.summary.totalPnl || 0) - Number(a.summary.totalPnl || 0))
      .slice(0, 5);

    const runsSection = document.getElementById('overview-top-runs');
    if (runsSection) {
      mount(runsSection, [
        el('h2', { class: 'card__title' }, 'Melhores Execuções (Top 5)'),
        bestRuns.length
          ? el('div', { class: 'table-wrap', style: { marginTop: '12px' } }, [
              el('table', { class: 'table table--compact' }, [
                el('thead', {}, el('tr', {}, [el('th', {}, 'Run ID'), el('th', {}, 'Ativo'), el('th', {}, 'PnL'), el('th', {}, 'WR')])),
                el('tbody', {}, bestRuns.map((r) => el('tr', {}, [
                  el('td', {}, el('button', { type: 'button', class: 'btn btn--link btn--sm', style: { padding: 0 }, onclick: () => ctx.navigate(`studio?run=${r.id}`) }, `#${r.id}`)),
                  el('td', {}, `${r.underlying || '-'} ${r.interval || ''}`),
                  el('td', { class: (r.summary?.totalPnl || 0) >= 0 ? 'good' : 'bad' }, formatPnl(r.summary?.totalPnl)),
                  el('td', {}, `${r.summary?.winRate ? Math.round(r.summary.winRate * 100) : 0}%`),
                ]))),
              ]),
            ])
          : el('p', { class: 'muted', style: { marginTop: '12px' } }, 'Nenhum backtest concluído encontrado.'),
      ]);
    }

  } catch (err) {
    console.error('renderOverview failed:', err);
    ctx.toast.err('Erro ao carregar os dados da Visão Geral');
  }
}

function renderQuickActions(ctx) {
  const container = document.getElementById('overview-actions-card');
  if (!container) return;
  mount(container, [
    el('h2', { class: 'card__title' }, 'Ações Rápidas'),
    el('div', { class: 'quick-action-card', onclick: () => ctx.navigate('studio') }, [
      el('div', { class: 'quick-action-card__icon' }, el('i', { class: 'fa-solid fa-wand-magic-sparkles' })),
      el('div', { class: 'quick-action-card__content' }, [
        el('strong', {}, 'Executar Novo Backtest'),
        el('span', { class: 'muted' }, 'Configure parâmetros e simule estratégias GLS sobre o Lakehouse.'),
      ]),
    ]),
    el('div', { class: 'quick-action-card', onclick: () => ctx.navigate('strategies') }, [
      el('div', { class: 'quick-action-card__icon' }, el('i', { class: 'fa-solid fa-chess-knight' })),
      el('div', { class: 'quick-action-card__content' }, [
        el('strong', {}, 'Gerenciar Estratégias'),
        el('span', { class: 'muted' }, 'Edite código GLS, valide a sintaxe e publique novas versões de algoritmos.'),
      ]),
    ]),
    el('div', { class: 'quick-action-card', onclick: () => ctx.navigate('data') }, [
      el('div', { class: 'quick-action-card__icon' }, el('i', { class: 'fa-solid fa-database' })),
      el('div', { class: 'quick-action-card__content' }, [
        el('strong', {}, 'Sincronizar Parquets'),
        el('span', { class: 'muted' }, 'Monitore a cobertura de ticks do Lakehouse e execute correções de dados.'),
      ]),
    ]),
  ]);
}

function statCard(label, value, tone, hint) {
  return el('div', { class: `stat stat--${tone}` }, [
    el('span', { class: 'stat__label' }, label),
    el('span', { class: 'stat__value' }, value),
    hint ? el('span', { class: 'stat__hint' }, hint) : null,
  ]);
}

function formatUptime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '-';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function detailRow(label, value) {
  return el('div', { class: 'detail-row' }, [
    el('span', { class: 'detail-row__label muted' }, label),
    el('code', { class: 'detail-row__value' }, String(value)),
  ]);
}
