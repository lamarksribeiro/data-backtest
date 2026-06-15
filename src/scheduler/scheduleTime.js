export const DEFAULT_SCHEDULER_TIMEZONE = 'America/Sao_Paulo';

export function resolveSchedulerTimezone(config) {
  const raw = String(config?.schedulerTimezone || DEFAULT_SCHEDULER_TIMEZONE).trim();
  if (!raw) return DEFAULT_SCHEDULER_TIMEZONE;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: raw });
    return raw;
  } catch {
    return DEFAULT_SCHEDULER_TIMEZONE;
  }
}

export function formatSchedulerTimezoneLabel(timeZone) {
  return String(timeZone || DEFAULT_SCHEDULER_TIMEZONE).replace(/_/g, ' ');
}

export function parseScheduleTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error('schedule time must be HH:MM');
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('schedule time must be HH:MM');
  return { hour, minute };
}

export function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function localDateKey(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  return formatLocalDateKey(parts);
}

export function zonedTimeToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i += 1) {
    const actual = getZonedParts(new Date(guess), timeZone);
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    const observed = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    guess += desired - observed;
  }
  return new Date(guess);
}

export function scheduledInstantForLocalDay({ year, month, day, hour, minute }, timeZone) {
  return zonedTimeToUtc({ year, month, day, hour, minute, second: 0 }, timeZone);
}

export function nextDailyRunAt(timeHm, now = new Date(), timeZone = DEFAULT_SCHEDULER_TIMEZONE, { after = null } = {}) {
  const { hour, minute } = parseScheduleTime(timeHm);
  const current = toDate(now);
  const today = getZonedParts(current, timeZone);
  let candidate = scheduledInstantForLocalDay({ ...today, hour, minute }, timeZone);
  const lastRun = after ? toDate(after) : null;

  while (candidate <= current || (lastRun && candidate <= lastRun)) {
    const nextDay = addLocalCalendarDays(todayPartsFromInstant(candidate, timeZone), 1);
    candidate = scheduledInstantForLocalDay({ ...nextDay, hour, minute }, timeZone);
  }

  return candidate.toISOString();
}

export function isDailyScheduleDue(timeHm, now = new Date(), timeZone = DEFAULT_SCHEDULER_TIMEZONE) {
  const current = toDate(now);
  const today = getZonedParts(current, timeZone);
  const { hour, minute } = parseScheduleTime(timeHm);
  const scheduled = scheduledInstantForLocalDay({ ...today, hour, minute }, timeZone);
  return current >= scheduled;
}

function todayPartsFromInstant(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function addLocalCalendarDays({ year, month, day }, days) {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function formatLocalDateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
  return date;
}
