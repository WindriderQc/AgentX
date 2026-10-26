'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { annualProjection, FIELDS, SCHEMA } = require('../secretary-annual-coverage');
const { catchupProjection } = require('../secretary-catchup');
const empty = () => Object.fromEntries(FIELDS.map(k => [k, 0]));
const counts = extra => ({ ...empty(), ...extra });
function bucket(year, gmail = {}, outlook = {}) {
  const bySystem = { gmail: counts(gmail), 'outlook-export': counts(outlook) };
  return { year, bySystem, totals: Object.fromEntries(FIELDS.map(k => [k, bySystem.gmail[k] + bySystem['outlook-export'][k]])) };
}
function fixture() {
  const years = [bucket(2005, { targetedSources: 2, availableSources: 2, reviewedSources: 1, coveredSources: 1 },
    { targetedSources: 1, availableSources: 1, rejectedSources: 1, gapSources: 1 }), bucket(2030, { targetedSources: 1, availableSources: 1 })];
  const unknown = bucket(null, { targetedSources: 1, metadataErrors: 1, gapSources: 1 });
  const rows = [...years, unknown];
  return { schema: SCHEMA, status: 'available', dateBasis: 'archived-mail-header-year', availabilityBasis: 'presence-and-size-only',
    totals: Object.fromEntries(FIELDS.map(k => [k, rows.reduce((n, r) => n + r.totals[k], 0)])),
    bySystem: Object.fromEntries(['gmail', 'outlook-export'].map(s => [s, Object.fromEntries(FIELDS.map(k => [k, rows.reduce((n, r) => n + r.bySystem[s][k], 0)]))])),
    years, unknown, metadata: { missingDates: 1, invalidDates: 0, identityMismatches: 0, unavailableFiles: 1 } };
}

test('native annual transport keeps totals and source systems while excluding every content field', () => {
  const value = fixture(); value.body = 'PRIVATE'; value.years[0].sourceIds = ['PRIVATE']; value.unknown.prompt = 'PRIVATE';
  const projected = annualProjection(value);
  assert.equal(projected.totals.targetedSources, 5);
  assert.equal(projected.unknown.totals.targetedSources, 1);
  assert.equal(projected.bySystem['outlook-export'].targetedSources, 1);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|sourceIds|prompt|body/);
  const desk = catchupProjection({ known: true, objectiveReviews: [{ objectiveId: 'life-timeline', version: 'v3', annualCoverage: value }] });
  assert.deepEqual(desk.objectiveReviews[0].annualCoverage, projected);
});

test('annual projection fails closed on missing, duplicate, overflowing and inconsistent counts', () => {
  for (const mutate of [v => v.years.push(v.years[0]), v => v.years[0].year = '2005',
    v => v.bySystem.gmail.coveredSources = 2, v => v.totals.targetedSources = -1,
    v => v.years = Array(513).fill(v.years[0]), v => v.unknown.totals.targetedSources = true,
    v => v.metadata.unavailableFiles = 0]) {
    const value = fixture(); mutate(value); assert.equal(annualProjection(value), null);
  }
  assert.equal(annualProjection(undefined), null);
  assert.deepEqual(annualProjection({ schema: SCHEMA, status: 'unavailable', reason: 'year-bucket-limit', body: 'PRIVATE' }),
    { schema: SCHEMA, status: 'unavailable', reason: 'year-bucket-limit' });
});

test('annual view fills empty life/view years and retains unknown and out-of-window source years', async () => {
  const { annualCoverage, annualRows, yearState } = await import(path.join(__dirname, '..', 'public/atlas/annual-coverage.js'));
  const annual = fixture(), result = annualRows(annual, { startYear: 2003, nowYear: 2007 });
  assert.deepEqual(result.rows.map(r => r.year), [2003, 2004, 2005, 2006, 2007]);
  assert.deepEqual(result.outside.map(r => r.year), [2030]);
  assert.equal(yearState(result.rows[0]).key, 'empty');
  assert.equal(yearState(result.rows[2]).key, 'attention');
  const html = annualCoverage(annual, { startYear: 2003, nowYear: 2007 });
  assert.match(html, /Année inconnue/); assert.match(html, /2030/); assert.match(html, /hors de la fenêtre/);
  assert.match(html, /Gmail/); assert.match(html, /Outlook/); assert.match(html, /sans contrôle d’intégrité/);
  assert.match(html, /Les compteurs se recoupent/); assert.match(html, /ne datent pas les événements/);
  assert.doesNotMatch(html, /<canvas|stacked|data-event-id/);
});

test('annual popup rendering does not mutate owner state, source counts or event filters', async () => {
  const { annualCoverage } = await import(path.join(__dirname, '..', 'public/atlas/annual-coverage.js'));
  const value = fixture(), original = structuredClone(value);
  annualCoverage(value, { startYear: 1999, nowYear: 2007 });
  assert.deepEqual(value, original);
  assert.match(annualCoverage(null), /pas encore disponible/);
  const { nativeCoverage } = await import(path.join(__dirname, '..', 'public/atlas/coverage.js'));
  assert.match(nativeCoverage({ lastCatchup: { finishedAt: '2026-01-01T00:00:00Z' }, objectiveReviews: [{ objectiveId: 'life-timeline', version: 'v3', annualCoverage: value }] }, { startYear: 2003, nowYear: 2007 }), /Les années et leurs sources/);
});

module.exports = { fixture };
