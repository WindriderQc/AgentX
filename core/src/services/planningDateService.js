const DEFAULT_PLANNING_TIME_ZONE = 'UTC';

function defaultPlanningTimeZone(env = process.env) {
  return String(env.PLANNING_TIME_ZONE || '').trim() || DEFAULT_PLANNING_TIME_ZONE;
}

function dateOnlyKey(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function zonedDateOnly(now = new Date(), timeZone = defaultPlanningTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function zonedDayBounds(dateKey, timeZone = defaultPlanningTimeZone()) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Date must use YYYY-MM-DD.');
  const [, year, month, day] = match.map(Number);
  const target = Date.UTC(year, month - 1, day);
  if (new Date(target).toISOString().slice(0, 10) !== dateKey) {
    throw new Error('Date is not a real calendar day.');
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const startOf = utcDate => {
    let instant = utcDate;
    for (let attempt = 0; attempt < 4; attempt++) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
        .map(part => [part.type, Number(part.value)]));
      const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day,
        parts.hour, parts.minute, parts.second);
      const correction = utcDate - wallClock;
      if (correction === 0) return new Date(instant);
      instant += correction;
    }
    throw new Error(`Could not resolve midnight in ${timeZone}.`);
  };
  return {
    start: startOf(target),
    end: startOf(Date.UTC(year, month - 1, day + 1))
  };
}

function isDateOnlyOverdue(value, now = new Date(), timeZone) {
  const target = dateOnlyKey(value);
  return Boolean(target && target < zonedDateOnly(now, timeZone));
}

module.exports = {
  DEFAULT_PLANNING_TIME_ZONE,
  defaultPlanningTimeZone,
  dateOnlyKey,
  zonedDateOnly,
  zonedDayBounds,
  isDateOnlyOverdue
};
