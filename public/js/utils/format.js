export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatPnl(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? 0);
  return num.toFixed(2);
}

export function shortId(value) {
  const text = String(value || '');
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

export function resultBadgeClass(result) {
  if (result === 'win') return 'badge--ok';
  if (result === 'loss') return 'badge--err';
  return 'badge--idle';
}

export function shellQuote(value) {
  return /\s/.test(value) ? `"${String(value).replaceAll('"', '\\"')}"` : value;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
