'use strict';
const { producerEvidence } = require('../../src/services/livingSourceFreshness');
const { forAudience } = require('../../src/services/livingSourceService');
const now = new Date('2026-03-15T12:00:00Z');
test('retrieval receipt is native and independent of read time or cache age', async () => {
  const ambient = { weather: async () => ({ temperatureC: 0,
    fetchedAt: '2026-03-15T11:58:00Z', observedAt: '2026-03-15T11:00:00Z' }) };
  const result = await forAudience('household', { ambient, now: () => now }).read({ source: 'weather' });
  expect(result.producerEvidence).toMatchObject({ lastSuccessfulRunAt: null,
    lastSuccessfulRetrievalAt: '2026-03-15T11:58:00.000Z',
    observedAt: '2026-03-15T11:00:00.000Z', lastFailedRunAt: null, effectiveCadenceMs: null });
  expect(result.data.observedAt).toBe('2026-03-15T11:00:00.000Z');
});
test.each([null, 'invalid', '2026-04-01T00:00:00Z'])('unknown or future retrieval %s is not a success', fetchedAt => {
  expect(producerEvidence('weather', { data: { fetchedAt } }, now).lastSuccessfulRetrievalAt).toBeNull();
});
test('Secretary timestamps cover only supplied records, not whole source or a run', () => {
  const result = producerEvidence('secretary', { data: { sections: { mail: { entries: [
    { updatedAt: '2026-03-14T10:00:00Z', createdAt: '2026-03-13T10:00:00Z' },
    { updatedAt: new Date('2026-03-15T10:00:00Z'), createdAt: 'invalid' }
  ] }, flaggedForOwner: { actions: [{ createdAt: '2026-03-15T09:00:00Z' }] } } } }, now);
  expect(result.recordUpdatedAt).toBe('2026-03-15T10:00:00.000Z');
  expect(result.recordCreatedAt).toBe('2026-03-15T09:00:00.000Z');
  expect(result.lastSuccessfulRunAt).toBeNull();
  expect(producerEvidence('secretary', { data: { sections: {} } }, now).recordUpdatedAt).toBeNull();
});
test('finance import receipt, transaction date and unknown failure are distinct', () => {
  expect(producerEvidence('comptable', { data: { sections: { freshness: {
    publication: { status: 'attested', lastAppliedAt: '2026-03-14T09:00:00Z' },
    latestTransactionDate: '2026-02-28'
  } } } }, now)).toMatchObject({ lastAttestedImportAt: '2026-03-14T09:00:00.000Z',
    latestTransactionDate: '2026-02-28', lastSuccessfulRunAt: null, lastFailedRunAt: null });
  expect(producerEvidence('comptable', { data: { sections: {} } }, now).importEvidenceStatus).toBe('not_read');
});
test('request probes never become a successful producer run', () => {
  expect(producerEvidence('agentx', { status: 'available' }, now)).toMatchObject({
    mode: 'request_probe', lastSuccessfulRunAt: null, effectiveCadenceMs: null });
});

test.each(['2099-01-01T00:00:00Z', 'invalid'])('bad observation %s is consistently unknown in data and evidence', async observedAt => {
  const ambient = { weather: async () => ({ temperatureC: 0, fetchedAt: '2026-03-15T11:58:00Z', observedAt }) };
  const result = await forAudience('household', { ambient, now: () => now }).read({ source: 'weather' });
  expect(result.data.observedAt).toBeNull();
  expect(result.producerEvidence.observedAt).toBeNull();
  expect(result.freshness).toMatchObject({ observationAgeMs: null, observationFreshness: 'unknown' });
});
test('old observation with fresh retrieval carries its age and an explicit warning', async () => {
  const ambient = { weather: async () => ({ temperatureC: 0,
    fetchedAt: '2026-03-15T11:58:00Z', observedAt: '2026-03-14T12:00:00Z' }) };
  const result = await forAudience('household', { ambient, now: () => now }).read({ source: 'weather' });
  expect(result.freshness.observationAgeMs).toBe(86400000);
  expect(result.freshness.observationFreshness).toBe('unknown');
  expect(result.freshness.warning).toMatch(/current observation freshness is not established/);
  expect(result.producerEvidence.observationAgeMs).toBe(86400000);
});
test('a future import receipt cannot claim attested status through source_read', async () => {
  const { read } = require('../../src/services/finance/financePublicationEvidence');
  const cursor = { sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; },
    next: async () => ({ receipt: { appliedAt: '2099-01-01T00:00:00Z' } }) };
  const publication = await read({ now: () => now,
    collection: () => ({ find: () => cursor }), withAccess: fn => fn() });
  const brief = async () => ({ sections: { freshness: { publication } } });
  const result = await forAudience('owner', { brief, now: () => now }).read({ source: 'comptable' });
  expect(result.data.sections.freshness.publication).toMatchObject({ status: 'unknown', lastAppliedAt: null });
  expect(result.producerEvidence).toMatchObject({ importEvidenceStatus: 'unknown', lastAttestedImportAt: null });
  const invalid = producerEvidence('comptable', { data: { sections: { freshness: {
    publication: { status: 'attested', lastAppliedAt: '2099-01-01T00:00:00Z' }
  } } } }, now);
  expect(invalid).toMatchObject({ importEvidenceStatus: 'unknown', lastAttestedImportAt: null });
});
