const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const UTC_MIDNIGHT_RE = /T00:00:00\.000Z$/;

/** Data local YYYY-MM-DD (evita deslocamento de fuso de toISOString). */
export function localDateYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function daysAgoLocal(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

export function defaultFromDateTime() {
  return `${localDateYmd(daysAgoLocal(1))}T00:00`;
}

export function defaultToDateTime() {
  return `${localDateYmd(new Date())}T23:59`;
}

export function isDateOnlyValue(value) {
  return DATE_ONLY_RE.test(String(value || '').trim());
}

export function isDateTimeLocalValue(value) {
  return DATETIME_LOCAL_RE.test(String(value || '').trim());
}

/** Normaliza valor do contexto (migra date-only legado para datetime-local). */
export function normalizeContextDateTime(value, { end = false } = {}) {
  const text = String(value || '').trim();
  if (!text) return end ? defaultToDateTime() : defaultFromDateTime();
  if (isDateOnlyValue(text)) return `${text}T${end ? '23:59' : '00:00'}`;
  if (isDateTimeLocalValue(text)) return text;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return isoToDateTimeLocal(parsed, { end });
  return end ? defaultToDateTime() : defaultFromDateTime();
}

export function isoToDateTimeLocal(iso, { end = false } = {}) {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return end ? defaultToDateTime() : defaultFromDateTime();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}`;
}

/** Parte YYYY-MM-DD para heatmap / comparação por dia. */
export function contextDateKey(value) {
  const normalized = normalizeContextDateTime(value);
  return normalized.slice(0, 10);
}

function parseContextAsLocalDate(value) {
  const text = normalizeContextDateTime(value);
  const [datePart, timePart = '00:00'] = text.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/** Converte início do contexto para parâmetro da API. */
export function contextDateTimeToApiFrom(value) {
  if (isDateOnlyValue(value)) return String(value).trim();
  return parseContextAsLocalDate(value).toISOString();
}

/**
 * Converte fim inclusivo do contexto para fim exclusivo da API.
 * Date-only mantém semântica legada (+1 dia no servidor).
 * Datetime-local usa precisão de minuto (+1 min exclusive).
 */
export function contextDateTimeToApiTo(value) {
  if (isDateOnlyValue(value)) return String(value).trim();
  const inclusive = parseContextAsLocalDate(value);
  return new Date(inclusive.getTime() + 60_000).toISOString();
}

export function contextToApiRange({ from, to } = {}) {
  return {
    from: contextDateTimeToApiFrom(from),
    to: contextDateTimeToApiTo(to),
  };
}

/** Fim exclusivo (API) → fim inclusivo para exibição. */
export function inclusiveEndFromExclusive(toExclusive, fromIso = null) {
  const toText = String(toExclusive || '');
  const fromText = String(fromIso || '');
  const toMs = new Date(toText).getTime();
  if (!Number.isFinite(toMs)) return toText.slice(0, 16) || '?';

  const dateOnlyEnd = UTC_MIDNIGHT_RE.test(toText)
    && (!fromText || UTC_MIDNIGHT_RE.test(fromText));

  if (dateOnlyEnd) {
    return new Date(toMs - 86_400_000);
  }
  return new Date(toMs - 60_000);
}

function hasTimeInIso(iso) {
  const text = String(iso || '');
  if (!text.includes('T')) return false;
  return !UTC_MIDNIGHT_RE.test(text);
}

function formatDateTimePtBr(date, { showTime = false } = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '?';
  if (showTime) {
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Formata intervalo armazenado (from ISO, to exclusive ISO) para exibição. */
export function formatStoredRange(fromIso, toExclusiveIso, { short = false } = {}) {
  const fromDate = new Date(fromIso);
  const toInclusive = inclusiveEndFromExclusive(toExclusiveIso, fromIso);
  const showTime = hasTimeInIso(fromIso) || hasTimeInIso(toExclusiveIso)
    || fromDate.getHours() + fromDate.getMinutes() > 0
    || toInclusive.getHours() + toInclusive.getMinutes() > 0;

  if (short && !showTime) {
    const fmt = (d) => formatDateTimePtBr(d, { showTime: false }).slice(0, 5);
    return `${fmt(fromDate)} – ${fmt(toInclusive)}`;
  }

  return `${formatDateTimePtBr(fromDate, { showTime })} → ${formatDateTimePtBr(toInclusive, { showTime })}`;
}

/** Converte run salvo (ISO) de volta para valores do formulário. */
export function storedRangeToContext(fromIso, toExclusiveIso) {
  const fromDate = new Date(fromIso);
  const toInclusive = inclusiveEndFromExclusive(toExclusiveIso, fromIso);
  return {
    from: isoToDateTimeLocal(fromDate),
    to: isoToDateTimeLocal(toInclusive, { end: true }),
  };
}
