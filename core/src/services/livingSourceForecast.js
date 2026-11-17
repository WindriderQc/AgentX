'use strict';

// Owner-only projection of the existing Data producer; no cache or scheduler.
const { validTimestamp } = require('./livingSourceFreshness');
const SECTIONS = Object.freeze(['forecasts', 'hourly', 'warnings']);
const MAX_RECORDS = Object.freeze({ forecasts: 16, hourly: 48, warnings: 20 });
const text = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
// Validity timestamps may legitimately be in the future; issue/retrieval may not.
function validity(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
function recordTruncated(row, section) {
  if (!row || typeof row !== 'object') return false;
  const fields = section === 'forecasts' ? [['period', 100], ['summary', 2000], ['short', 300]]
    : section === 'hourly' ? [['condition', 300], ['windDirection', 8]]
      : [['description', 2000], ['type', 80], ['colour', 40]];
  return fields.some(([key, max]) => typeof row[key] === 'string' && row[key].length > max)
    || (section === 'forecasts' && Array.isArray(row.temperatures) &&
      (row.temperatures.length > 4 || row.temperatures.slice(0, 4).some(t => typeof t?.class === 'string' && t.class.length > 40)));
}
function projectRecord(row, section, now) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (section === 'forecasts' && ![row.period, row.summary, row.short].some(v => typeof v === 'string' && v.trim())) return null;
  if (section === 'hourly' && ![row.time, row.condition].some(v => typeof v === 'string' && v.trim()) && number(row.temperatureC) === null) return null;
  if (section === 'warnings' && ![row.description, row.type].some(v => typeof v === 'string' && v.trim())) return null;
  if (section === 'forecasts') return {
    period: text(row.period, 100), summary: text(row.summary, 2000), short: text(row.short),
    // Data supplies a named period, not an absolute start/end. Never invent dates.
    validFrom: null, validUntil: null, validity: 'named_period_only',
    temperatures: (Array.isArray(row.temperatures) ? row.temperatures : []).slice(0, 4)
      .map(t => ({ class: text(t?.class, 40), valueC: number(t?.valueC) })),
    precipitationChancePct: number(row.precipitationChancePct)
  };
  if (section === 'hourly') {
    const time = validity(row.time);
    return { time, validity: !time ? 'unknown' : Date.parse(time) < now.getTime() ? 'past' : 'upcoming',
      condition: text(row.condition), temperatureC: number(row.temperatureC),
      precipitationChancePct: number(row.precipitationChancePct), windKmh: number(row.windKmh),
      windDirection: text(row.windDirection, 8) };
  }
  const issuedAt = validTimestamp(row.issuedAt, now), expiresAt = validity(row.expiresAt);
  return { description: text(row.description, 2000), type: text(row.type, 80), colour: text(row.colour, 40),
    issuedAt, expiresAt, validity: !issuedAt || !expiresAt || expiresAt < issuedAt ? 'unknown'
      : Date.parse(expiresAt) <= now.getTime() ? 'expired' : 'within_reported_window' };
}
function projectForecast(value, section, now) {
  if (!value || typeof value !== 'object') return { status: 'unavailable', data: null, sourceUpdatedAt: null };
  const fetchedAt = validTimestamp(value.fetchedAt, now);
  const forecastIssuedAt = validTimestamp(value.forecastIssuedAt, now);
  const rows = Array.isArray(value[section]) ? value[section] : null;
  const records = (rows || []).slice(0, MAX_RECORDS[section]).map(row => projectRecord(row, section, now)).filter(Boolean);
  const data = { section, source: 'Environnement Canada',
    station: { identifier: text(value.identifier, 100), name: text(value.name, 120),
      observationStation: text(value.current?.station, 120) },
    fetchedAt, observedAt: validTimestamp(value.current?.observedAt, now),
    forecastIssuedAt, lastUpdated: validTimestamp(value.lastUpdated, now),
    records, coverage: { contentTruncated: (rows || []).slice(0, MAX_RECORDS[section]).some(row => recordTruncated(row, section))
        || [[value.identifier, 100], [value.name, 120], [value.current?.station, 120]]
          .some(([v, max]) => typeof v === 'string' && v.length > max),
      returned: records.length, sourceCount: rows?.length ?? null,
      limit: MAX_RECORDS[section], truncated: Boolean(rows && rows.length > MAX_RECORDS[section]),
      malformedRecords: rows ? rows.slice(0, MAX_RECORDS[section]).length - records.length : null,
      scope: 'Only this configured Environment Canada source and requested section.',
      ...(section === 'warnings' ? { emptyMeaning: 'No warnings returned by this source; not a global all-clear or proof of safety.' } : {}) } };
  const age = fetchedAt ? now.getTime() - Date.parse(fetchedAt) : null;
  const missing = !rows || (section !== 'warnings' && !records.length);
  const partial = data.coverage.truncated || data.coverage.contentTruncated || data.coverage.malformedRecords > 0 ||
    (section !== 'warnings' && !forecastIssuedAt);
  return { status: missing || age === null ? 'unavailable' : age > 1800000 ? 'stale' : partial ? 'partial' : 'available',
    data, sourceUpdatedAt: fetchedAt,
    freshness: { timestampMeaning: 'retrieved_at_not_forecast_validity', maxAgeMs: 1800000,
      forecastIssuedAt, forecastAgeMs: forecastIssuedAt ? now.getTime() - Date.parse(forecastIssuedAt) : null,
      forecastFreshness: 'unknown',
      warning: 'Retrieval age does not establish forecast freshness or validity. Named periods have no absolute dates; hourly times and warning expiry are separate. Missing evidence stays unknown.' } };
}
async function readForecast(section, now, fetchData = require('./dataServiceClient').fetchData) {
  const result = await fetchData('/api/v1/livedata/ec-weather', { query: 'lang=fr', timeoutMs: 8000 });
  if (!result?.response?.ok || result.body?.status !== 'success') throw new Error('Weather source unavailable');
  return projectForecast(result.body.data, section, now);
}
module.exports = { SECTIONS, readForecast, projectForecast };
