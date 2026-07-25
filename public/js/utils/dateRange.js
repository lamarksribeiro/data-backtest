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

export function daysAgoLocal(n, now = new Date()) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() - n);
  return d;
}

/** HH:mm no fuso local (minuto atual). */
export function currentTimeLocal(date = new Date()) {
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

/** Converte intervalo (`5m`, `15m`, `1h`, `4h`) para milissegundos. */
export function parseIntervalMs(interval = '5m') {
  const match = String(interval || '').trim().match(/^(\d+)\s*([mhd])$/i);
  if (!match) return 5 * 60_000;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 5 * 60_000;
  const unit = match[2].toLowerCase();
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 3_600_000;
  return amount * 86_400_000;
}

/**
 * Epoch ms do fim do último evento completo (grade UTC do intervalo).
 * Ex.: agora 19:18Z com 5m → 19:15Z.
 */
export function lastCompleteEventEndMs(now = new Date(), interval = '5m') {
  const step = parseIntervalMs(interval);
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(t) || step <= 0) return Date.now();
  return Math.floor(t / step) * step;
}

/**
 * Fim inclusivo (datetime-local) até o último evento completo.
 * Usa fim−1min porque a API converte inclusivo → exclusivo com +1min,
 * alinhando o corte exatamente no event_end.
 */
export function lastCompleteInclusiveDateTime(now = new Date(), interval = '5m') {
  const endMs = lastCompleteEventEndMs(now, interval);
  return isoToDateTimeLocal(new Date(endMs - 60_000), { end: true });
}

/**
 * Fim padrão para uma data escolhida:
 * - dia passado → 23:59 (dia completo)
 * - hoje/futuro → último evento completo do intervalo (sem evento quebrado)
 */
export function defaultEndDateTimeForDate(dateKey, now = new Date(), interval = '5m') {
  const today = localDateYmd(now);
  const key = String(dateKey || '').slice(0, 10) || today;
  if (key < today) return `${key}T23:59`;

  const inclusive = lastCompleteInclusiveDateTime(now, interval);
  if (key === today) {
    return inclusive.slice(0, 10) === today ? inclusive : `${today}T00:00`;
  }
  // Data futura: não há eventos — volta ao máximo disponível real.
  return inclusive;
}

/** @deprecated use defaultEndDateTimeForDate; mantido para HH:mm em labels. */
export function defaultEndTimeForDate(dateKey, now = new Date(), interval = '5m') {
  return defaultEndDateTimeForDate(dateKey, now, interval).slice(11, 16);
}

export function defaultFromDateTime(now = new Date()) {
  return `${localDateYmd(daysAgoLocal(1, now))}T00:00`;
}

export function defaultToDateTime(now = new Date(), interval = '5m') {
  return lastCompleteInclusiveDateTime(now, interval);
}

export function isDateOnlyValue(value) {
  return DATE_ONLY_RE.test(String(value || '').trim());
}

export function isDateTimeLocalValue(value) {
  return DATETIME_LOCAL_RE.test(String(value || '').trim());
}

/** Normaliza valor do contexto (migra date-only legado para datetime-local). */
export function normalizeContextDateTime(value, { end = false, now = new Date(), interval = '5m' } = {}) {
  const text = String(value || '').trim();
  if (!text) return end ? defaultToDateTime(now, interval) : defaultFromDateTime(now);
  if (isDateOnlyValue(text)) {
    return end
      ? defaultEndDateTimeForDate(text, now, interval)
      : `${text}T00:00`;
  }
  if (isDateTimeLocalValue(text)) {
    return end ? clampToAvailableEnd(text, now, interval) : text;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const local = isoToDateTimeLocal(parsed, { end });
    return end ? clampToAvailableEnd(local, now, interval) : local;
  }
  return end ? defaultToDateTime(now, interval) : defaultFromDateTime(now);
}

/**
 * Ao escolher/alterar a data no seletor:
 * - início → 00:00
 * - fim → 23:59 (dia completo) ou último evento completo (dia parcial)
 * Se só o horário mudou, preserva (com clamp no fim).
 */
export function applyDateSelectionDefaults(value, {
  end = false,
  previousDateKey = null,
  now = new Date(),
  interval = '5m',
} = {}) {
  const text = String(value || '').trim();
  if (!text) return end ? defaultToDateTime(now, interval) : defaultFromDateTime(now);

  const normalized = isDateOnlyValue(text)
    ? (end ? defaultEndDateTimeForDate(text, now, interval) : `${text}T00:00`)
    : (isDateTimeLocalValue(text) ? text : normalizeContextDateTime(text, { end, now, interval }));

  const dateKey = normalized.slice(0, 10);
  const dateChanged = Boolean(previousDateKey) && previousDateKey !== dateKey;

  if (!previousDateKey || dateChanged || isDateOnlyValue(text)) {
    if (!end) return `${dateKey}T00:00`;
    return defaultEndDateTimeForDate(dateKey, now, interval);
  }

  return end ? clampToAvailableEnd(normalized, now, interval) : normalized;
}

/**
 * Impede fim além do último evento completo do intervalo
 * (evita janela parcial / evento quebrado).
 */
export function clampToAvailableEnd(value, now = new Date(), interval = '5m') {
  const normalized = String(value || '').trim();
  if (!isDateTimeLocalValue(normalized) && !isDateOnlyValue(normalized)) {
    return defaultToDateTime(now, interval);
  }
  const maxInclusive = lastCompleteInclusiveDateTime(now, interval);
  const candidate = isDateOnlyValue(normalized)
    ? defaultEndDateTimeForDate(normalized, now, interval)
    : normalized;
  const parsed = parseContextAsLocalDate(candidate);
  const maxParsed = parseContextAsLocalDate(maxInclusive);
  if (parsed.getTime() > maxParsed.getTime()) return maxInclusive;
  return candidate;
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
  const text = String(value || '').trim();
  let datePart;
  let timePart = '00:00';
  if (isDateOnlyValue(text)) {
    datePart = text;
  } else if (isDateTimeLocalValue(text)) {
    [datePart, timePart = '00:00'] = text.split('T');
  } else {
    const normalized = normalizeContextDateTime(text);
    [datePart, timePart = '00:00'] = normalized.split('T');
  }
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
