'use strict';

// One projection for explicit source reads and automatic principal context.
// Retrieval age does not establish the freshness of an observation.
const { validTimestamp } = require('./livingSourceFreshness');

function projectWeather(value, now = new Date()) {
  if (!value) return { status: 'unavailable', data: null, sourceUpdatedAt: null };
  const sourceUpdatedAt = validTimestamp(value.fetchedAt, now);
  const observedAt = validTimestamp(value.observedAt, now);
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

module.exports = { projectWeather };
