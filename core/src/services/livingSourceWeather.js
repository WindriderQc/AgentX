'use strict';

// One projection for explicit source reads and automatic principal context.
// Retrieval age does not establish the freshness of an observation.
const { calendarDayKey } = require('../domains/household/family');
const { validTimestamp } = require('./livingSourceFreshness');

function projectWeather(value, now = new Date()) {
  if (!value) return { status: 'unavailable', data: null, sourceUpdatedAt: null };
  const sourceUpdatedAt = validTimestamp(instant(value.fetchedAt), now);
  const reported = validTimestamp(instant(value.observedAt), now);
  const observedAt = reported && sourceUpdatedAt && reported > sourceUpdatedAt ? null : reported;
  const observationAgeMs = observedAt ? Math.max(0, now.getTime() - Date.parse(observedAt)) : null;
  const age = sourceUpdatedAt ? now.getTime() - Date.parse(sourceUpdatedAt) : NaN;
  // The named source is the family current-conditions contract, not general Data.
  const data = { fetchedAt: sourceUpdatedAt, observedAt, source: 'Environnement Canada' };
  for (const key of ['temperatureC', 'windKmh', 'gustKmh']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) data[key] = value[key];
  }
  for (const [key, max] of [['condition', 80], ['windDirection', 8]]) {
    if (typeof value[key] === 'string' && value[key].length <= max) data[key] = value[key];
  }
  const usable = ['temperatureC', 'windKmh', 'gustKmh', 'condition'].some(key =>
    typeof data[key] === 'number' || (typeof data[key] === 'string' && data[key].trim()));
  const retrievalStatus = !Number.isFinite(age) || age < -60000 ? 'unavailable' : age > 1800000 ? 'stale' : 'available';
  const status = usable ? retrievalStatus : 'unavailable';
  return { status, data, sourceUpdatedAt, unavailableReason: !usable && retrievalStatus === 'available' ? 'no_usable_conditions' : null, freshness: { timestampMeaning: 'retrieved_at_not_observed_at', maxAgeMs: 1800000,
    observationAgeMs, observationFreshness: 'unknown',
    warning: 'Availability describes retrieval age only. Observation age is separate; current observation freshness is not established.' } };
}

// Copy only fields from the public city bulletin before retaining it in Core.
// Discard ambiguous local timestamps and calendar overflows (e.g. February 30).
function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const parts = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!parts) return null;
  const day = new Date(parts[1] + 'T00:00:00Z');
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === parts[1]
    ? new Date(timestamp).toISOString() : null;
}

const text = (value, length) => typeof value === 'string' && value.trim() && value.length <= length ? value.trim() : null;
const number = (value, min = -Infinity, max = Infinity) => Number.isFinite(value) && min <= value && value <= max ? value : null;
const HOUR_MS = 3600000;
const PREPARED_TTL_MS = 10 * 60000;

function preparedBulletin(raw) {
  if (!['fresh', 'stale'].includes(raw?.preparedStatus) || !instant(raw.fetchedAt)) return null;
  const hourly = Array.isArray(raw.hourly) ? raw.hourly.slice(0, 48).map(row => ({
    time: instant(row?.time), temperatureC: number(row?.temperatureC), condition: text(row?.condition, 80),
    precipitationChancePct: number(row?.precipitationChancePct, 0, 100), windKmh: number(row?.windKmh, 0)
  })) : [];
  const periods = Array.isArray(raw.forecasts) ? raw.forecasts.slice(0, 16).map(row => ({
    period: text(row?.period, 80), short: text(row?.short, 200), summary: text(row?.summary, 1500),
    temperatures: (Array.isArray(row?.temperatures) ? row.temperatures : []).slice(0, 4)
      .map(temp => ({ class: text(temp?.class, 30), valueC: number(temp?.valueC) }))
      .filter(temp => temp.class && temp.valueC !== null),
    precipitationChancePct: number(row?.precipitationChancePct, 0, 100)
  })).filter(row => row.period && (row.short || row.summary || row.temperatures.length || row.precipitationChancePct !== null)) : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.slice(0, 30).map(row => ({
    description: text(row?.description, 300), type: text(row?.type, 50), colour: text(row?.colour, 50),
    issuedAt: instant(row?.issuedAt), expiresAt: instant(row?.expiresAt)
  })) : null;
  const fetchedAt = instant(raw.fetchedAt);
  const current = raw.current && { fetchedAt, observedAt: instant(raw.current.observedAt),
    temperatureC: number(raw.current.temperatureC), condition: text(raw.current.condition, 80),
    windKmh: number(raw.current.windKmh, 0), gustKmh: number(raw.current.gustKmh, 0), windDirection: text(raw.current.windDirection, 8) };
  return { current, hourly, periods, warnings, warningsTruncated: (raw.warnings?.length || 0) > 30, fetchedAt,
    forecastIssuedAt: instant(raw.forecastIssuedAt), preparedStatus: raw.preparedStatus };
}

function projectBulletin(bulletin, now, timeZone) {
  if (!bulletin || Date.parse(bulletin.fetchedAt) > now.getTime() + 60000) return null;
  const { fetchedAt, forecastIssuedAt, periods, warnings } = bulletin;
  const fetched = Date.parse(fetchedAt), issued = Date.parse(forecastIssuedAt), at = now.getTime();
  const source = 'Environnement Canada';
  const stale = bulletin.preparedStatus === 'stale' || at - fetched >= PREPARED_TTL_MS;
  const freshness = { timestampMeaning: 'retrieved_at', maxAgeMs: PREPARED_TTL_MS, preparedStatus: stale ? 'stale' : 'fresh' };
  const section = (data, status) => ({ data, sourceUpdatedAt: fetchedAt, freshness, status });
  const current = projectWeather(bulletin.current, now);
  if (current.status === 'available' && stale) current.status = 'stale';
  if (current.freshness) current.freshness = { ...current.freshness, preparedStatus: freshness.preparedStatus, maxAgeMs: PREPARED_TTL_MS };
  let forecast = section(null, 'unavailable');
  if (Number.isFinite(issued) && issued <= fetched && issued <= at) {
    const issueDate = calendarDayKey(issued, timeZone);
    // Ambiguous duplicates cannot establish conditions for that hour.
    const hours = new Map();
    for (const row of bulletin.hourly) {
      const hour = Date.parse(row.time);
      if (!(hour >= at && hour >= issued && hour <= issued + 48 * HOUR_MS)) continue;
      if (!row.condition && [row.temperatureC, row.precipitationChancePct, row.windKmh].every(v => v === null)) continue;
      hours.set(row.time, hours.has(row.time) ? null : row);
    }
    const hourly = [...hours.values()].filter(Boolean).sort((a, b) => a.time.localeCompare(b.time));
    if (periods.length || hourly.length) forecast = section({ section: 'forecast', source, fetchedAt, forecastIssuedAt, issueDate, timeZone,
      periods, hourly }, stale || at - issued > 12 * HOUR_MS ? 'stale' : 'available');
  }
  let alerts = section(null, 'unavailable');
  if (warnings) {
    const active = [];
    let incomplete = bulletin.warningsTruncated;
    for (const row of warnings) {
      if (!row.issuedAt || !row.expiresAt || row.expiresAt <= row.issuedAt || Date.parse(row.issuedAt) > Math.min(fetched, at) ||
          (!row.description && !row.type)) incomplete = true;
      else if (Date.parse(row.expiresAt) > at) active.push(row);
    }
    alerts = section({ section: 'alerts', source, fetchedAt, warnings: active, incomplete }, stale ? 'stale' : incomplete ? 'partial' : 'available');
  }
  return { current, forecast, alerts };
}

module.exports = { projectWeather, preparedBulletin, projectBulletin };
