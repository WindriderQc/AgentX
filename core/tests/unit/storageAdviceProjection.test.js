'use strict';

const { projectAssessment } = require('../../src/services/storageAssessmentProjection');
const { buildStorageAdvice, readPolicy } = require('../../../data/services/storageAdvice');

function body(size = 1) {
  const source = { source: 'photos', root: '/private/source', coverage: 'complete_at_scan',
    lastScan: { observedAt: '2026-10-20T12:00:00Z', ageMs: 1000 }, indexed: { files: 3, bytes: 300 },
    copies: { observedHashedFiles: 3, observedFilesWithOtherSource: 3 } };
  const volume = { id: 'private-volume', roots: ['/private/destination'], freeBytes: 599,
    observation: { observedAt: '2026-10-20T12:00:00Z', ageMs: 1000 } };
  const assessment = { schemaVersion: 1,
    sources: Array.from({ length: size }, (_, i) => ({ ...source, source: `s${i}` })),
    volumes: Array.from({ length: size }, (_, i) => ({ ...volume, id: `private-volume-${i}` })) };
  const policy = { version: 1, maxScanAgeMs: 1000, maxVolumeAgeMs: 1000,
    sources: Object.fromEntries(assessment.sources.map(s => [s.source, { growthBytes: 100, requiredIndependentCopies: 2,
      retentionDays: 30, failureDomain: 'private-primary', allowedVolumeIds: assessment.volumes.map(v => v.id) }])),
    volumes: Object.fromEntries(assessment.volumes.map(v => [v.id, { reserveBytes: 200, failureDomain: 'private-secondary' }])) };
  assessment.advice = buildStorageAdvice(assessment, readPolicy(JSON.stringify(policy)));
  return assessment;
}

test('Core carries the same explained block, capacity and backup verification advice without private identifiers', () => {
  const result = projectAssessment(body());
  expect(result.advice).toMatchObject({ status: 'advisory_only', policyStatus: 'configured', executionAuthorized: false,
    placement: [{ source: 's0', volume: 1, status: 'blocked',
      reasons: ['insufficient_space_after_reserve_and_growth'], evidence: { requiredFreeBytes: 600, freeBytes: 599 } }],
    copyCoverage: [{ status: 'unknown', evidence: { requiredIndependentCopies: 2, independentBackupCoverage: 'unknown' } }] });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(result.summary).toContain('aucune action autorisée');
  expect(result.recommendation).toBe(null);
});

test('Core reports exact omitted placement count after Data and Core bounds and never mentions invisible targets', () => {
  const result = projectAssessment(body(10));
  expect(result.advice.capacity).toHaveLength(8);
  expect(result.advice.copyCoverage).toHaveLength(8);
  expect(result.advice.placement.every(pair => pair.volume <= 8)).toBe(true);
  expect(result.advice.omittedPlacementPairs).toBe(100 - result.advice.placement.length);
});

test('older Data keeps the existing observation view; future arbitrary fields cannot bypass the bounded projection', () => {
  const b = body();
  b.advice.placement[0].evidence.privateSecret = '/private/secret';
  b.advice.placement[0].evidence.failureDomains = '/private/domain';
  b.advice.placement[0].reasons.push('/private/path');
  expect(JSON.stringify(projectAssessment(b))).not.toContain('private');
  b.advice.schemaVersion = 99;
  expect(projectAssessment(b).advice).toBeUndefined();
  delete b.advice;
  expect(projectAssessment(b).status).toBe('observations_only');
});

test('candidate advice remains conditional and cannot become execution authorization in Core', () => {
  const b = body();
  b.advice.placement[0].status = 'candidate_for_review';
  b.advice.placement[0].reasons = [];
  b.advice.placement[0].action = 'review_additional_full_logical_copy';
  b.advice.executionAuthorized = true;
  const result = projectAssessment(b);
  expect(result.advice.executionAuthorized).toBe(false);
  expect(result.summary).toContain('1 candidat(s) de copie à examiner');
  expect(result.advice.copyCoverage[0].evidence.independentBackupCoverage).toBe('unknown');
});

test('Data to Core retains a missing-destination diagnosis without exposing its private configured ID', () => {
  const b = body();
  b.volumes = [];
  b.advice = buildStorageAdvice(b, readPolicy(JSON.stringify({ version: 1, maxScanAgeMs: 1000, maxVolumeAgeMs: 1000,
    sources: { s0: { growthBytes: 0, failureDomain: 'private-primary', allowedVolumeIds: ['private-missing-volume'] } },
    volumes: { 'private-missing-volume': { reserveBytes: 0, failureDomain: 'private-secondary' } } })));
  expect(b.advice.placement[0].missingEvidence).toEqual(['configured_destination_measurement', 'dated_volume_measurement']);
  const result = projectAssessment(b);
  expect(result.advice.placement).toHaveLength(1);
  expect(result.advice.placement[0]).toMatchObject({ source: 's0', volume: null, status: 'unknown',
    action: 'verify_placement_inputs', missingEvidence: ['configured_destination_measurement', 'dated_volume_measurement'],
    evidence: { freeBytes: null, volumeObservedAt: null } });
  expect(result.advice.omittedPlacementPairs).toBe(0);
  expect(JSON.stringify(result)).not.toContain('private');
});

test('a known destination outside Core bounds stays omitted even when Data marks it as a candidate', () => {
  const b = body(9);
  const hidden = b.advice.placement.find(pair => pair.volumeId === 'private-volume-8');
  hidden.status = 'candidate_for_review';
  hidden.action = 'review_additional_full_logical_copy';
  const result = projectAssessment(b);
  expect(result.advice.placement.every(pair => pair.volume !== null && pair.volume <= 8)).toBe(true);
  expect(result.advice.omittedPlacementPairs).toBe(81 - result.advice.placement.length);
  expect(JSON.stringify(result)).not.toContain('private');
});
