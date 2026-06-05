const form = document.getElementById('prepare-form');
const resultEl = document.getElementById('result');
const healthEl = document.getElementById('health');
let lastRequest = null;

const today = new Date();
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
form.elements.from.value = isoDate(yesterday);
form.elements.to.value = isoDate(today);

loadHealth();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  resultEl.innerHTML = '<div class="card">Carregando...</div>';
  const params = new URLSearchParams(new FormData(form));
  const dryRun = params.get('dry_run') === 'on';
  params.delete('dry_run');
  if (params.get('dataset') !== 'backtest_ticks') params.delete('book_depth');
  if (params.get('dataset') !== 'ohlc') params.delete('resolution');
  lastRequest = Object.fromEntries(params.entries());
  lastRequest.dry_run = dryRun;

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
    </section>
    <section id="job-panel"></section>
  `;
  document.getElementById('run-prepare')?.addEventListener('click', runPrepareJob);
}

async function runPrepareJob() {
  if (!lastRequest) return;
  const dryRun = lastRequest.dry_run !== false;
  if (!dryRun && !window.confirm('Executar sync real contra o Postgres do data-colector?')) return;
  const payload = { ...lastRequest, dry_run: undefined };
  const response = await apiPost('/api/prepare/run', {
    request: payload,
    dry_run: dryRun,
  });
  if (!response.ok) {
    document.getElementById('job-panel').innerHTML = errorCard(response.error?.message || 'Falha ao criar job');
    return;
  }
  renderJob(response.data.job);
  pollJob(response.data.job.id);
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
