'use strict';

const { readPolicy, buildStorageAdvice, MAX_PLACEMENT_PAIRS } = require('../../services/storageAdvice');
const AT = '2026-10-20T12:00:00.000Z';
const observed = () => ({ observedAt: AT, ageMs: 1000 });
function assessment() {
  return { sources: [{ source: 'photos', root: '/mnt/photos', coverage: 'complete_at_scan', lastScan: observed(),
    indexed: { bytes: 300, files: 3 }, copies: { observedHashedFiles: 3, observedFilesWithOtherSource: 3 } }],
  volumes: [{ id: 'target', roots: ['/mnt/archive'], freeBytes: 600, observation: observed() }] };
}
function config() {
  return { version: 1, maxScanAgeMs: 1000, maxVolumeAgeMs: 1000,
    sources: { photos: { growthBytes: 100, requiredIndependentCopies: 2, retentionDays: 30,
      failureDomain: 'primary', allowedVolumeIds: ['target'] } },
    volumes: { target: { reserveBytes: 200, failureDomain: 'secondary' } } };
}
const evaluate = (a = assessment(), p = config()) => buildStorageAdvice(a, readPolicy(JSON.stringify(p)));

test('exact reserve/growth fit is a review candidate with arithmetic and dated policy evidence, never a backup guarantee', () => {
  const a = assessment(); const p = config();
  const before = JSON.stringify({ a, p });
  const result = evaluate(a, p);
  expect(result.placement[0]).toMatchObject({ status: 'candidate_for_review', action: 'review_additional_full_logical_copy',
    missingEvidence: [], evidence: { indexedBytes: 300, growthBytes: 100, reserveBytes: 200,
      requiredFreeBytes: 600, freeBytes: 600, scanObservedAt: AT, failureDomains: 'declared_distinct' } });
  expect(result.placement[0].evidence).toMatchObject({ scanAgeMs: 1000, maxScanAgeMs: 1000,
    volumeAgeMs: 1000, maxVolumeAgeMs: 1000 });
  expect(result.copyCoverage[0]).toMatchObject({ status: 'unknown', evidence: { requiredIndependentCopies: 2,
    observedFilesWithOtherSource: 3, independentBackupCoverage: 'unknown' } });
  expect(result.copyCoverage[0].missingEvidence).toEqual(['independent_copy_receipts', 'restore_verification', 'retention_evidence']);
  expect(result.executionAuthorized).toBe(false);
  expect(JSON.stringify({ a, p })).toBe(before);
  expect(JSON.stringify(result)).not.toContain('/mnt/');
  expect(JSON.stringify(result)).not.toContain('secondary');
});

test('one byte short blocks placement; capacity below the configured reserve explains its deficit', () => {
  const a = assessment(); a.volumes[0].freeBytes = 599;
  expect(evaluate(a).placement[0]).toMatchObject({ status: 'blocked', reasons: ['insufficient_space_after_reserve_and_growth'] });
  a.volumes[0].freeBytes = 199;
  expect(evaluate(a).capacity[0]).toMatchObject({ status: 'below_reserve', action: 'review_capacity_shortfall',
    evidence: { deficitBytes: 1, reserveBytes: 200, freeBytes: 199 } });
});

test.each(['source', 'volume'])('a stale %s observation with enough bytes is never a candidate', kind => {
  const a = assessment();
  (kind === 'source' ? a.sources[0].lastScan : a.volumes[0].observation).ageMs = 1001;
  const result = evaluate(a);
  expect(result.placement[0].status).toBe('unknown');
  expect(result.placement[0].missingEvidence).toContain(kind === 'source' ? 'fresh_complete_source_scan' : 'fresh_volume_measurement');
  if (kind === 'volume') expect(result.capacity[0].status).toBe('unknown');
});

test.each(['maxScanAgeMs', 'maxVolumeAgeMs', 'growthBytes', 'reserveBytes', 'failureDomain', 'allowedVolumeIds'])('missing %s never acquires a default', key => {
  const p = config();
  if (key.startsWith('max')) delete p[key];
  else if (key === 'reserveBytes') delete p.volumes.target[key];
  else delete p.sources.photos[key];
  expect(evaluate(assessment(), p).placement[0].status).toBe('unknown');
});

test.each(['same-domain', 'same-root', 'incomplete', 'missing-volume', 'ambiguous-volume', 'overflow', 'no-destinations'])('%s evidence cannot produce a placement candidate', kind => {
  const a = assessment(); const p = config();
  if (kind === 'same-domain') p.volumes.target.failureDomain = 'primary';
  if (kind === 'same-root') a.volumes[0].roots = ['/mnt/photos/sub'];
  if (kind === 'incomplete') a.sources[0].coverage = 'unknown';
  if (kind === 'missing-volume') a.volumes = [];
  if (kind === 'ambiguous-volume') a.volumes.push({ ...a.volumes[0], roots: ['/mnt/elsewhere'] });
  if (kind === 'overflow') p.sources.photos.growthBytes = Number.MAX_SAFE_INTEGER;
  if (kind === 'no-destinations') p.sources.photos.allowedVolumeIds = [];
  expect(evaluate(a, p).placement[0].status).not.toBe('candidate_for_review');
});

test('missing/invalid policy is explicit, and zero is accepted only when explicitly configured', () => {
  for (const raw of ['', 'invalid', '{}', '{"version":2}', '{"version":1,"maxScanAgeMs":"1"}',
    JSON.stringify({ ...config(), threshold: 0.9 }), JSON.stringify({ ...config(), sources: { photos: { growthBytes: -1 } } })]) {
    const policy = readPolicy(raw);
    expect(policy.status).not.toBe('configured');
    expect(buildStorageAdvice(assessment(), policy).placement[0].status).toBe('unknown');
  }
  const p = config(); p.sources.photos.requiredIndependentCopies = 0;
  delete p.sources.photos.retentionDays;
  expect(evaluate(assessment(), p).copyCoverage[0]).toMatchObject({ status: 'not_required_by_policy', missingEvidence: [],
    evidence: { independentBackupCoverage: 'unknown' } });
  p.sources.photos.requiredIndependentCopies = 1;
  expect(evaluate(assessment(), p).copyCoverage[0].missingEvidence).toContain('retention_days');
});

test('declared destinations retain configured order without ranking or a joint allocation; truncation is counted', () => {
  const a = assessment(); const p = config();
  a.sources = Array.from({ length: 32 }, (_, i) => ({ ...a.sources[0], source: `s${i}` }));
  a.volumes = Array.from({ length: 64 }, (_, i) => ({ ...a.volumes[0], id: `v${i}` }));
  p.sources = Object.fromEntries(a.sources.map(source => [source.source,
    { ...p.sources.photos, allowedVolumeIds: a.volumes.map(volume => volume.id) }]));
  p.volumes = Object.fromEntries(a.volumes.map(volume => [volume.id, p.volumes.target]));
  const result = evaluate(a, p);
  expect(result.placement).toHaveLength(MAX_PLACEMENT_PAIRS);
  expect(result.omittedPlacementPairs).toBe(32 * 64 - MAX_PLACEMENT_PAIRS);
  expect(result.placement.map(pair => pair.volumeId)).toEqual(a.volumes.map(volume => volume.id));
  expect(result.placement.every(pair => pair.status === 'candidate_for_review')).toBe(true);
});

test('strict bounded policy rejects unknown nested keys, duplicate destinations and oversized configuration', () => {
  const p = config(); p.sources.photos.extra = true;
  expect(readPolicy(JSON.stringify(p)).status).toBe('invalid');
  delete p.sources.photos.extra; p.sources.photos.allowedVolumeIds.push('target');
  expect(readPolicy(JSON.stringify(p)).status).toBe('invalid');
  expect(readPolicy(' '.repeat(65537)).status).toBe('invalid');
});
