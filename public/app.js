const form = document.getElementById('prepare-form');
const resultEl = document.getElementById('result');
const healthEl = document.getElementById('health');
const runsEl = document.getElementById('runs');
let lastRequest = null;

const today = new Date();
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
form.elements.from.value = isoDate(yesterday);
form.elements.to.value = isoDate(today);

loadHealth();
loadRuns();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  resultEl.innerHTML = '<div class="card">Carregando...</div>';
  const params = new URLSearchParams(new FormData(form));
  const dryRun = params.get('dry_run') === 'on';
  const rebuild = params.get('rebuild') === 'on';
  params.delete('dry_run');
  params.delete('rebuild');
  if (rebuild) params.set('rebuild', 'true');
  if (params.get('dataset') !== 'backtest_ticks') params.delete('book_depth');
  if (params.get('dataset') !== 'ohlc') params.delete('resolution');
  lastRequest = Object.fromEntries(params.entries());
  lastRequest.dry_run = dryRun;
  lastRequest.rebuild = rebuild;

  const response = await apiGet(`/api/prepare?${params}`);
  if (!response.ok) {
    resultEl.innerHTML = errorCard(response.error?.message || 'Falha ao consultar');
    return;
  }
  renderPrepare(response.data.result);
});

async function loadHealth() {
  const response = await apiGet('/healthz');
  if (!response.ok) {
    healthEl.textContent = 'offline';
    healthEl.className = 'pill pill--bad';
    return;
  }
  const stats = response.data.manifest || {};
  healthEl.textContent = `${stats.partitions || 0} particoes`;
  healthEl.className = 'pill pill--ok';
}

function renderPrepare(result) {
  const availability = result.availability;
  const cards = [
    metric('Status', result.ready ? 'Pronto' : 'Preparar'),
    metric('Dataset', availability.dataset),
    metric('Particoes esperadas', availability.expected_partitions.length),
    metric('Arquivos validos', availability.files.length),
  ];

  resultEl.innerHTML = `
    <section class="grid">${cards.join('')}</section>
    <section class="card">
      <h2>Disponibilidade</h2>
      ${listBlock('Ausentes', availability.missing)}
      ${listBlock('Indisponiveis', availability.unavailable.map((item) => `${item.dt}: ${item.status}`))}
    </section>
    <section class="card">
      <h2>Plano de preparacao</h2>
      ${result.preparation.length ? planList(result.preparation) : '<p class="muted">Nenhuma acao necessaria.</p>'}
      ${result.preparation.length ? '<button id="run-prepare" type="button">Criar job de preparacao</button>' : ''}
      ${result.ready && availability.dataset === 'backtest_ticks' ? '<button id="run-backtest" type="button">Executar backtest edge-sniper-v2</button>' : ''}
    </section>
    <section id="job-panel"></section>
  `;
  document.getElementById('run-prepare')?.addEventListener('click', runPrepareJob);
  document.getElementById('run-backtest')?.addEventListener('click', runBacktest);
}

async function runPrepareJob() {
  if (!lastRequest) return;
  const dryRun = lastRequest.dry_run !== false;
  if (!dryRun && !window.confirm('Executar sync real contra o Postgres do data-colector?')) return;
  let confirmRebuild = null;
  if (!dryRun && lastRequest.rebuild) {
    confirmRebuild = window.prompt('Para reprocessar particoes, digite REBUILD_PARTITIONS');
    if (confirmRebuild !== 'REBUILD_PARTITIONS') return;
  }
  const payload = { ...lastRequest, dry_run: undefined };
  const response = await apiPost('/api/prepare/run', {
    request: payload,
    dry_run: dryRun,
    confirm_rebuild: confirmRebuild,
  });
  if (!response.ok) {
    document.getElementById('job-panel').innerHTML = errorCard(response.error?.message || 'Falha ao criar job');
    return;
  }
  renderJob(response.data.job);
  pollJob(response.data.job.id);
}

async function runBacktest() {
  if (!lastRequest) return;
  const payload = { ...lastRequest };
  delete payload.dry_run;
  delete payload.rebuild;
  const panel = document.getElementById('job-panel');
  panel.innerHTML = '<section class="card">Executando backtest...</section>';
  const response = await apiPost('/api/backtest/run', payload);
  if (!response.ok) {
    panel.innerHTML = errorCard(response.error?.message || 'Falha ao executar backtest');
    return;
  }
  renderBacktestResult(response.data.result);
  loadRuns();
}

async function pollJob(id) {
  for (;;) {
    await delay(1000);
    const response = await apiGet(`/api/prepare/jobs/${id}`);
    if (!response.ok) return;
    renderJob(response.data.job);
    if (['completed', 'failed'].includes(response.data.job.status)) return;
  }
}

function renderJob(job) {
  const panel = document.getElementById('job-panel');
  if (!panel) return;
  const result = job.result ? `<pre>${escapeHtml(JSON.stringify(job.result, null, 2))}</pre>` : '';
  panel.innerHTML = `
    <section class="card">
      <h2>Job #${job.id}</h2>
      <p>Status: <strong>${escapeHtml(job.status)}</strong> · modo: ${job.dry_run ? 'dry-run' : 'execucao real'}</p>
      ${job.error ? `<p class="bad">${escapeHtml(job.error)}</p>` : ''}
      ${result}
    </section>
  `;
}

function renderBacktestResult(result) {
  const panel = document.getElementById('job-panel');
  if (!panel) return;
  const summary = result.summary || {};
  panel.innerHTML = `
    <section class="card">
      <h2>Backtest ${escapeHtml(result.strategy)}</h2>
      <p>${escapeHtml(result.ticks)} ticks em ${escapeHtml(result.batches)} batches.</p>
      <div class="grid">
        ${metric('Eventos', summary.totalEvents ?? 0)}
        ${metric('Entradas', summary.totalEntries ?? 0)}
        ${metric('Wins', summary.wins ?? 0)}
        ${metric('PnL', summary.totalPnl ?? 0)}
      </div>
      <pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>
    </section>
  `;
}

async function loadRuns() {
  const response = await apiGet('/api/backtest/runs?limit=5');
  if (!response.ok || !runsEl) return;
  const runs = response.data.runs || [];
  runsEl.innerHTML = `
    <section class="card">
      <h2>Ultimos backtests</h2>
      ${runs.length ? `<ol>${runs.map(runListItem).join('')}</ol>` : '<p class="muted">Nenhum backtest executado ainda.</p>'}
    </section>
  `;
}

function runListItem(run) {
  const summary = run.summary || {};
  return `<li><code>#${escapeHtml(run.id)} ${escapeHtml(run.strategy)} ${escapeHtml(run.underlying)} ${escapeHtml(run.interval)}</code> · ${escapeHtml(run.ticks)} ticks · PnL ${escapeHtml(summary.totalPnl ?? 0)}</li>`;
}

function metric(label, value) {
  return `<div class="card metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function listBlock(title, items) {
  if (!items.length) return `<p><strong>${escapeHtml(title)}:</strong> <span class="muted">nenhum</span></p>`;
  return `<div><strong>${escapeHtml(title)}</strong><ul>${items.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('')}</ul></div>`;
}

function planList(actions) {
  return `<ol>${actions.map((action) => {
    const command = `node src/cli.js ${action.command} ${action.args.map(shellQuote).join(' ')}`;
    return `<li><code>${escapeHtml(command)}</code>${action.prerequisite ? '<span class="tag">pre-requisito</span>' : ''}</li>`;
  }).join('')}</ol>`;
}

function errorCard(message) {
  return `<section class="card card--error"><h2>Erro</h2><p>${escapeHtml(message)}</p></section>`;
}

async function apiGet(path) {
  try {
    const response = await fetch(path);
    const data = await response.json();
    if (!response.ok) return { ok: false, error: data.error || { message: `HTTP ${response.status}` } };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error };
  }
}

async function apiPost(path, body) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) return { ok: false, error: data.error || { message: `HTTP ${response.status}` } };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function shellQuote(value) {
  return /\s/.test(value) ? `"${String(value).replaceAll('"', '\\"')}"` : value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
