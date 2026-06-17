import { el, mount } from '../utils/dom.js';
import { fetchHealthzCached } from '../utils/healthzCache.js';
import { formatPnl } from '../utils/format.js';
import { renderUplotSparkline } from '../utils/uplotChart.js';

// Injeção de estilo CSS premium para o Overview
const overviewStyles = `
  .portfolio-analysis-container {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    margin-top: 20px;
  }
  @media (max-width: 640px) {
    .portfolio-analysis-container {
      grid-template-columns: 1fr;
      gap: 32px;
    }
  }

  .portfolio-chart-section {
    display: flex;
    align-items: center;
    gap: 24px;
    background: rgba(255, 255, 255, 0.01);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }
  @media (max-width: 480px) {
    .portfolio-chart-section {
      flex-direction: column;
      align-items: flex-start;
      gap: 16px;
    }
  }

  .portfolio-legend {
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-width: 140px;
  }
  .portfolio-legend__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
  }
  .portfolio-legend__label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-2);
  }
  .portfolio-legend__value {
    font-weight: 700;
    color: var(--text-0);
  }
  .portfolio-legend__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Estatísticas superiores com frisos coloridos */
  .stat-premium {
    position: relative;
    overflow: hidden;
  }
  .stat-premium::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 4px;
    height: 100%;
    background: var(--idle);
  }
  .stat-premium--validated::before { background: var(--ok); }
  .stat-premium--pipeline::before { background: var(--warn); }
  .stat-premium--health::before { background: var(--ok); }
  
  .stat-premium--system.stat--ok::before { background: var(--ok); }
  .stat-premium--system.stat--warn::before { background: var(--warn); }
  .stat-premium--system.stat--err::before { background: var(--err); }

  .portfolio-insights {
    grid-column: span 2;
    margin-top: 16px;
    padding: 16px 20px;
    background: linear-gradient(90deg, rgba(249, 115, 22, 0.05), rgba(59, 130, 246, 0.02));
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-1);
    position: relative;
  }
  @media (max-width: 640px) {
    .portfolio-insights {
      grid-column: span 1;
    }
  }
  .portfolio-insights::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    width: 60px;
    height: 100%;
    background: radial-gradient(circle at top right, rgba(249, 115, 22, 0.08), transparent 70%);
    pointer-events: none;
  }
  .portfolio-insights__title {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--text-0);
    margin: 0 0 6px 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .portfolio-insights__text {
    font-size: 12.5px;
    color: var(--text-2);
    line-height: 1.5;
    margin: 0;
  }

  .table-premium td {
    vertical-align: middle;
  }

  .overview-spark {
    width: 100px;
    height: 36px;
    min-height: 36px;
    overflow: hidden;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.2);
  }

  @media (max-width: 768px) {
    .portfolio-chart-section {
      justify-content: center;
    }

    .portfolio-legend {
      width: 100%;
    }

    .portfolio-chart-section > svg {
      margin: 0 auto;
    }
  }

  @media (max-width: 480px) {
    .portfolio-insights {
      padding: 14px 16px;
    }

    .stat-premium .stat__hint {
      font-size: 11px;
      line-height: 1.4;
    }
  }
`;

export async function renderOverview(ctx) {
  ctx.setBreadcrumb('overview', null);
  ctx.renderContextBar?.();

  // Injetar a tag style se ainda não foi injetada
  if (!document.getElementById('overview-custom-styles')) {
    const styleEl = el('style', { id: 'overview-custom-styles' }, overviewStyles);
    document.head.appendChild(styleEl);
  }

  // 1. Layout inicial de carregamento / skeleton
  mount(ctx.contentEl, [
    el('div', { class: 'grid grid--4', id: 'overview-stats', style: { marginTop: '12px' } }, [
      el('div', { class: 'stat stat--idle stat-premium' }, [el('span', { class: 'stat__label' }, 'Carregando'), el('span', { class: 'stat__value' }, '…')]),
    ]),
    el('section', { class: 'card', id: 'overview-portfolio-card', style: { marginTop: '16px' } }, [
      el('h2', { class: 'card__title' }, 'Distribuição do Portfólio de Estratégias'),
      el('p', { class: 'muted', style: { marginBottom: '16px' } }, 'Análise visual do pipeline de desenvolvimento e do perfil de lucratividade de suas estratégias.'),
      el('div', { class: 'portfolio-analysis-container', id: 'portfolio-analysis-root' }, [
        el('div', { style: { padding: '40px 0', textAlign: 'center', gridColumn: 'span 2' } }, el('p', { class: 'muted' }, 'Carregando análise do portfólio...')),
      ]),
    ]),
    el('div', { class: 'grid grid--2 gap-md', style: { marginTop: '16px' } }, [
      el('section', { class: 'card', id: 'overview-health-detail' }),
      el('section', { class: 'card', id: 'overview-top-strategies' }),
    ]),
  ]);

  try {
    // 2. Chamadas de APIs paralelas
    const [healthRes, strategiesRes] = await Promise.all([
      fetchHealthzCached({ force: true }),
      ctx.api.get('/api/strategies?stats=1'),
    ]);

    const health = healthRes.body || {};
    const strategies = strategiesRes.ok ? strategiesRes.data.strategies || [] : [];

    // Calcular estatísticas das estratégias
    const totalStrategies = strategies.length;
    const validatedStrategies = strategies.filter((s) => s.status === 'validated');
    const draftStrategies = strategies.filter((s) => s.status === 'draft');
    const failedStrategies = strategies.filter((s) => s.status === 'failed');
    const archivedStrategies = strategies.filter((s) => s.status === 'archived');

    // Classificação de Lucratividade com base nas estatísticas das runs de cada estratégia
    const testedStrategies = strategies.filter((s) => (s.totals?.runs || 0) > 0);
    const profitableStrategies = testedStrategies.filter((s) => (s.totals?.avg_pnl || 0) > 0);
    const unprofitableStrategies = testedStrategies.filter((s) => (s.totals?.avg_pnl || 0) <= 0);
    const untestedStrategies = strategies.filter((s) => !(s.totals?.runs > 0));

    const profitablePct = testedStrategies.length
      ? Math.round((profitableStrategies.length / testedStrategies.length) * 100)
      : 0;

    // Atualizar os cards de estatísticas rápidas
    mount(document.getElementById('overview-stats'), [
      statCard(
        'Status do Sistema',
        health.status === 'ok' ? 'Operacional' : 'Alerta',
        health.status === 'ok' ? 'ok' : 'warn',
        `Uptime: ${formatUptime(health.uptime_sec)}`,
        'stat-premium--system'
      ),
      statCard(
        'Estratégias Validadas',
        `${validatedStrategies.length} aprovadas`,
        'ok',
        totalStrategies > 0 ? `${Math.round((validatedStrategies.length / totalStrategies) * 100)}% de taxa de aprovação` : 'Nenhuma estratégia criada',
        'stat-premium--validated'
      ),
      statCard(
        'Funil do Kanban',
        `${totalStrategies} definidas`,
        'warn',
        `${draftStrategies.length} testes · ${failedStrategies.length} falhas · ${archivedStrategies.length} arq`,
        'stat-premium--pipeline'
      ),
      statCard(
        'Saúde do Portfólio',
        testedStrategies.length > 0 ? `${profitablePct}% Lucrativas` : 'Sem dados',
        profitablePct >= 50 ? 'ok' : 'warn',
        testedStrategies.length > 0 ? `${profitableStrategies.length} lucrativas / ${unprofitableStrategies.length} perdedoras` : 'Execute backtests nas estratégias',
        'stat-premium--health'
      ),
    ]);

    // Renderizar seção de análise do portfólio (Donut + Stacked Bar + Insights)
    const analysisContainer = document.getElementById('portfolio-analysis-root');
    if (analysisContainer) {
      const donutSlices = [
        { label: 'Aprovadas', value: validatedStrategies.length, color: 'var(--ok)' },
        { label: 'Em Teste', value: draftStrategies.length, color: 'var(--warn)' },
        { label: 'Falharam', value: failedStrategies.length, color: 'var(--err)' },
        { label: 'Arquivadas', value: archivedStrategies.length, color: 'var(--idle)' },
      ];

      const barSegments = [
        { label: 'Lucrativas', value: profitableStrategies.length, color: 'var(--ok)' },
        { label: 'Perdedoras', value: unprofitableStrategies.length, color: 'var(--err)' },
        { label: 'Sem Testes', value: untestedStrategies.length, color: 'rgba(71, 85, 105, 0.4)' },
      ];

      // Gerar insights textuais dinâmicos
      let insightTitle = 'Métricas do Portfólio';
      let insightText = '';
      if (totalStrategies === 0) {
        insightText = 'Nenhuma estratégia foi criada ainda. Vá para a tela de Estratégias ou abra o Estúdio para programar suas primeiras lógicas GLS.';
      } else {
        const topProfitable = [...validatedStrategies].sort((a, b) => (b.totals?.avg_pnl || 0) - (a.totals?.avg_pnl || 0))[0];
        if (validatedStrategies.length === 0) {
          insightTitle = 'Pipeline Inicial';
          insightText = `Você possui <strong>${draftStrategies.length}</strong> estratégias em teste no Kanban, mas nenhuma aprovada ainda. Realize simulações no Estúdio de Backtests para validar o desempenho e movê-las de status.`;
        } else {
          insightTitle = 'Destaques e Saúde';
          insightText = `Das <strong>${testedStrategies.length}</strong> estratégias simuladas, <strong>${profitablePct}%</strong> têm PnL médio lucrativo. `;
          if (topProfitable && (topProfitable.totals?.avg_pnl || 0) > 0) {
            insightText += `A estratégia <strong>${topProfitable.name}</strong> é o maior destaque aprovado, com <strong>${Math.round((topProfitable.totals?.win_rate || 0) * 100)}% WR</strong> e média de <strong>${formatPnl(topProfitable.totals?.avg_pnl)}</strong> por execução.`;
          } else {
            insightText += `O portfólio possui estratégias aprovadas, mas continue monitorando para calibrar e melhorar a expectativa matemática.`;
          }
        }
      }

      mount(analysisContainer, [
        // Coluna 1: Distribuição de Status (Donut Chart)
        el('div', { class: 'portfolio-chart-section' }, [
          createDonutChart(donutSlices),
          el('div', { class: 'portfolio-legend' }, [
            el('strong', { style: { fontSize: '12.5px', color: 'var(--text-1)', marginBottom: '4px' } }, 'Pipeline de Status'),
            ...donutSlices.map(s => el('div', { class: 'portfolio-legend__item' }, [
              el('span', { class: 'portfolio-legend__label' }, [
                el('span', { class: 'portfolio-legend__dot', style: { background: s.color } }),
                s.label
              ]),
              el('span', { class: 'portfolio-legend__value' }, String(s.value))
            ]))
          ])
        ]),

        // Coluna 2: Lucratividade das Estratégias
        el('div', { class: 'portfolio-chart-section', style: { flexDirection: 'column', alignItems: 'stretch' } }, [
          el('strong', { style: { fontSize: '12.5px', color: 'var(--text-1)' } }, 'Expectativa de Performance'),
          el('p', { class: 'muted', style: { fontSize: '11px', margin: '4px 0 0 0' } }, 'Proporção de estratégias lucrativas (com base em runs concluídas).'),
          createStackedBar(barSegments),
          el('div', { class: 'portfolio-legend', style: { flexDirection: 'row', flexWrap: 'wrap', gap: '16px' } }, 
            barSegments.map(s => el('div', { class: 'portfolio-legend__item', style: { flex: '1', minWidth: '80px', justifyContent: 'flex-start', gap: '6px' } }, [
              el('span', { class: 'portfolio-legend__dot', style: { background: s.color } }),
              el('span', { class: 'portfolio-legend__label', style: { fontSize: '12px' } }, `${s.label}:`),
              el('span', { class: 'portfolio-legend__value', style: { fontSize: '12px' } }, String(s.value))
            ]))
          )
        ]),

        // Insights Globais
        el('div', { class: 'portfolio-insights' }, [
          el('h4', { class: 'portfolio-insights__title' }, [
            el('i', { class: 'fa-solid fa-circle-info', style: { color: 'var(--accent)' } }),
            insightTitle
          ]),
          el('p', { class: 'portfolio-insights__text', html: insightText })
        ])
      ]);
    }

    // Renderizar informações detalhadas de saúde
    mount(document.getElementById('overview-health-detail'), [
      el('h2', { class: 'card__title' }, 'Diagnósticos e Logs'),
      el('div', { class: 'health-detail-grid', style: { marginTop: '12px' } }, [
        detailRow('Diretório Lake', health.lake_root || '-'),
        detailRow('Banco de Dados State', health.state_db_path || '-'),
        detailRow('Lake Fingerprint', health.lake_fingerprint || '-'),
        detailRow('Uptime', formatUptime(health.uptime_sec)),
      ]),
    ]);

    // Renderizar tabela de Estratégias Aprovadas em Destaque
    const topStrategiesSection = document.getElementById('overview-top-strategies');
    if (topStrategiesSection) {
      const approvedSorted = [...validatedStrategies]
        .sort((a, b) => (b.totals?.avg_pnl || 0) - (a.totals?.avg_pnl || 0));

      mount(topStrategiesSection, [
        el('h2', { class: 'card__title' }, 'Estratégias Aprovadas em Destaque'),
        approvedSorted.length
          ? el('div', { class: 'table-wrap', style: { marginTop: '12px' } }, [
              el('table', { class: 'table table--compact table-premium' }, [
                el('thead', {}, el('tr', {}, [
                  el('th', {}, 'Estratégia'),
                  el('th', {}, 'Versão'),
                  el('th', {}, 'Runs'),
                  el('th', {}, 'Win Rate'),
                  el('th', {}, 'Média PnL'),
                  el('th', {}, 'Curva')
                ])),
                el('tbody', {}, approvedSorted.map((s) => el('tr', {}, [
                  el('td', {}, el('button', {
                    type: 'button',
                    class: 'btn btn--link btn--sm',
                    style: { padding: 0, fontWeight: '700' },
                    onclick: () => ctx.navigate(`strategies/${s.id}`)
                  }, s.name)),
                  el('td', {}, s.latest_version != null ? `v${s.latest_version}` : 'v1'),
                  el('td', {}, String(s.totals?.runs || 0)),
                  el('td', {}, s.totals?.runs ? `${Math.round((s.totals.win_rate || 0) * 100)}%` : '—'),
                  el('td', { class: (s.totals?.avg_pnl || 0) >= 0 ? 'good' : 'bad' }, s.totals?.runs ? formatPnl(s.totals.avg_pnl) : '—'),
                  el('td', {}, (s.stats?.sparkline?.length || s.sparkline?.length)
                    ? el('div', { id: `spark-overview-${s.id}`, class: 'overview-spark' })
                    : el('span', { class: 'muted', style: { fontSize: '11px' } }, 'Sem runs')
                  ),
                ]))),
              ]),
            ])
          : el('div', { class: 'empty-state', style: { padding: '24px 0', textAlign: 'center' } }, [
              el('p', { class: 'muted', style: { margin: 0 } }, 'Nenhuma estratégia marcada como Aprovada no Kanban ainda.'),
            ]),
      ]);

      // Renderizar fisicamente as sparklines uPlot para cada estratégia listada
      queueMicrotask(() => {
        for (const s of approvedSorted) {
          const spark = s.stats?.sparkline || s.sparkline || [];
          const container = document.getElementById(`spark-overview-${s.id}`);
          if (container && spark.length > 0) {
            renderUplotSparkline(container, spark, { height: 36, width: 100 });
          }
        }
      });
    }

  } catch (err) {
    console.error('renderOverview failed:', err);
    ctx.toast.err('Erro ao carregar os dados da Visão Geral');
  }
}

// Renderiza a estrutura do gráfico donut dinamicamente usando SVG puro
function createDonutChart(slices) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const R = 40;
  const circumference = 2 * Math.PI * R;

  if (total === 0) {
    return el('svg', { viewBox: '0 0 100 100', width: '100', height: '100', style: { transform: 'rotate(-90deg)' } }, [
      el('circle', { cx: '50', cy: '50', r: String(R), fill: 'transparent', stroke: 'rgba(255,255,255,0.05)', strokeWidth: '12' })
    ]);
  }

  let currentOffset = 0;
  const paths = [];

  for (const slice of slices) {
    if (slice.value === 0) continue;
    const percentage = slice.value / total;
    const dashArray = `${percentage * circumference} ${circumference}`;
    const dashOffset = String(currentOffset);
    currentOffset -= percentage * circumference;

    paths.push(
      el('circle', {
        cx: '50',
        cy: '50',
        r: String(R),
        fill: 'transparent',
        stroke: slice.color,
        strokeWidth: '12',
        style: {
          strokeDasharray: dashArray,
          strokeDashoffset: dashOffset,
          transition: 'stroke-dashoffset 0.5s ease',
        }
      })
    );
  }

  return el('svg', { viewBox: '0 0 100 100', width: '100', height: '100', style: { transform: 'rotate(-90deg)', overflow: 'visible', flexShrink: '0' } }, paths);
}

// Renderiza a barra empilhada de lucratividade
function createStackedBar(segments) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) {
    return el('div', { class: 'stacked-bar-empty', style: { height: '12px', background: 'var(--border)', borderRadius: '6px' } });
  }

  const flexItems = segments.map(seg => {
    if (seg.value === 0) return null;
    const pct = (seg.value / total) * 100;
    return el('div', {
      style: {
        width: `${pct}%`,
        height: '100%',
        background: seg.color,
        transition: 'width 0.5s ease',
      },
      title: `${seg.label}: ${seg.value} (${Math.round(pct)}%)`
    });
  }).filter(Boolean);

  if (flexItems.length > 0) {
    flexItems[0].style.borderTopLeftRadius = '6px';
    flexItems[0].style.borderBottomLeftRadius = '6px';
    flexItems[flexItems.length - 1].style.borderTopRightRadius = '6px';
    flexItems[flexItems.length - 1].style.borderBottomRightRadius = '6px';
  }

  return el('div', {
    style: {
      display: 'flex',
      height: '12px',
      width: '100%',
      borderRadius: '6px',
      overflow: 'hidden',
      background: 'rgba(255,255,255,0.05)',
      marginTop: '12px',
      marginBottom: '12px',
    }
  }, flexItems);
}

function statCard(label, value, tone, hint, extraClass = '') {
  return el('div', { class: `stat stat--${tone} stat-premium ${extraClass}` }, [
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
