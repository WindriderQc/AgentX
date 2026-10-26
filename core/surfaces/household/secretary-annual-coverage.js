'use strict';

const SCHEMA = 'secretary.annual-source-coverage/v1';
const SYSTEMS = ['gmail', 'outlook-export'];
const FIELDS = ['targetedSources', 'availableSources', 'reviewedSources', 'coveredSources',
  'rejectedSources', 'gapSources', 'sourceErrors', 'metadataErrors'];

function annualProjection(value) {
  if (!value || value.schema !== SCHEMA) return null;
  if (value.status === 'unavailable') return ['unsupported-source-system', 'year-bucket-limit'].includes(value.reason)
    ? { schema: SCHEMA, status: 'unavailable', reason: value.reason } : null;
  try {
    const counts = raw => {
      if (!raw || FIELDS.some(k => !Number.isSafeInteger(raw[k]) || raw[k] < 0 || raw[k] > raw.targetedSources)) throw Error('Invalid annual counts');
      return Object.fromEntries(FIELDS.map(k => [k, raw[k]]));
    };
    const systems = raw => Object.fromEntries(SYSTEMS.map(s => [s, counts(raw[s])]));
    const bucket = (raw, unknown = false) => {
      if (!raw || (unknown ? raw.year !== null : !Number.isInteger(raw.year) || raw.year < 1 || raw.year > 9999)) throw Error('Invalid annual year');
      const row = { year: raw.year, totals: counts(raw.totals), bySystem: systems(raw.bySystem) };
      if (FIELDS.some(k => SYSTEMS.reduce((n, s) => n + row.bySystem[s][k], 0) !== row.totals[k])) throw Error('Invalid annual totals');
      return row;
    };
    if (value.status !== 'available' || value.dateBasis !== 'archived-mail-header-year' ||
      value.availabilityBasis !== 'presence-and-size-only' || !Array.isArray(value.years) || value.years.length > 512) return null;
    const years = value.years.map(row => bucket(row));
    if (new Set(years.map(row => row.year)).size !== years.length) return null;
    const unknown = bucket(value.unknown, true), totals = counts(value.totals), bySystem = systems(value.bySystem), rows = [...years, unknown];
    if (FIELDS.some(k => rows.reduce((n, row) => n + row.totals[k], 0) !== totals[k]) ||
      SYSTEMS.some(s => FIELDS.some(k => rows.reduce((n, row) => n + row.bySystem[s][k], 0) !== bySystem[s][k]))) return null;
    const metadata = Object.fromEntries(['missingDates', 'invalidDates', 'identityMismatches', 'unavailableFiles'].map(k => [k, value.metadata[k]]));
    if (Object.values(metadata).some(n => !Number.isSafeInteger(n) || n < 0 || n > totals.targetedSources) ||
      metadata.missingDates + metadata.invalidDates + metadata.identityMismatches !== unknown.totals.targetedSources ||
      metadata.unavailableFiles !== totals.targetedSources - totals.availableSources) return null;
    return { schema: SCHEMA, status: 'available', dateBasis: value.dateBasis, availabilityBasis: value.availabilityBasis,
      totals, bySystem, years: years.sort((a, b) => a.year - b.year), unknown, metadata };
  } catch { return null; }
}

module.exports = { annualProjection, FIELDS, SYSTEMS, SCHEMA };
