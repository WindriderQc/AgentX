'use strict';

const { familyClock } = require('./family-clock');

const HOUR_MS = 3600000;
const MAX_RETRIEVAL_AGE_MS = 30 * 60000;
const MAX_BULLETIN_AGE_MS = 12 * HOUR_MS;

// Do not let Date parse an unqualified timestamp in the Core host's timezone.
function epoch(value) {
  const fields = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!fields) return NaN;
  const [, yearText, monthText, dayText] = fields;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= lengths[month - 1] ? Date.parse(value) : NaN;
}

function nextCalendarDate(date) {
  const at = new Date(date + 'T00:00:00.000Z');
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

// The published forecast only covers the hours actually present. Relative
// bulletin labels remain excluded until Data supplies a trustworthy date anchor.
function projectTomorrowHours(value, { timeZone, requestAt = new Date(), now = requestAt } = {}) {
  const clock = familyClock({ timeZone, now: requestAt });
  if (!clock) return null;
  const targetDate = nextCalendarDate(clock.localDate);
  const issued = epoch(value?.forecastIssuedAt);
  const fetched = epoch(value?.fetchedAt);
  const cutoff = now.getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(fetched) || !Number.isFinite(cutoff)
    || issued > fetched || issued > cutoff || fetched > cutoff + 60000 || cutoff - fetched > MAX_RETRIEVAL_AGE_MS
    || cutoff - issued > MAX_BULLETIN_AGE_MS || !Array.isArray(value?.hourly)) return null;

  const byInstant = new Map();
  const repeated = new Set();
  for (const row of value.hourly.slice(0, 48)) {
    const instant = epoch(row?.time);
    if (!Number.isFinite(instant) || instant < issued || instant <= cutoff || instant > issued + 30 * HOUR_MS) continue;
    const at = familyClock({ timeZone: clock.timeZone, now: new Date(instant) });
    if (at?.localDate !== targetDate) continue;
    if (byInstant.has(instant)) {
      repeated.add(instant);
      continue;
    }
    const item = { instant: at.instant, localTime: at.localTime.slice(0, 5), offset: at.offset };
    if (typeof row.condition === 'string' && row.condition.trim()) item.condition = row.condition.slice(0, 80);
    for (const key of ['temperatureC', 'precipitationChancePct', 'windKmh']) {
      if (Number.isFinite(row[key])) item[key] = row[key];
    }
    if (Object.keys(item).length > 3) byInstant.set(instant, item);
  }
  const hourly = [...byInstant.entries()].filter(([instant]) => !repeated.has(instant))
    .sort(([a], [b]) => a - b).map(([, item]) => item);
  if (!hourly.length) return null;
  return { source: 'Environnement Canada', forecastIssuedAt: new Date(issued).toISOString(),
    fetchedAt: new Date(fetched).toISOString(), timeZone: clock.timeZone, targetDate, hourly };
}

// Narrow positive allowlist for explicit, local, single-intent utterances.
function isExplicitTomorrowWeather(text) {
  if (typeof text !== 'string' || text.length > 150) return false;
  const words = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’']/g, ' ').replace(/[?!.,]+$/g, '').trim().replace(/\s+/g, ' ')
    .replace(/^nestor[, ]+/, '');
  return /^(?:(?:quelle (?:est la )?|(?:c est quoi la |donne moi la |la ))?(?:meteo|(?:les )?previsions meteo) (?:pour |de )?demain|(?:quel temps (?:fera t il|va t il faire)|il va faire quel temps) demain|(?:what(?: s| is) the )?weather (?:for )?tomorrow|tomorrow s weather)$/.test(words.replace(/-/g, ' '));
}

module.exports = { projectTomorrowHours, isExplicitTomorrowWeather };
