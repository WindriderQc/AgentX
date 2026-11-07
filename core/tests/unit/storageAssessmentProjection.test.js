'use strict';

const { projectAssessment } = require('../../src/services/storageAssessmentProjection');
const { readStorageSummary } = require('../../src/services/storageIndex');

function assessment(size = 1) {
  return { schemaVersion: 1, generatedAt: '2026-10-20T12:00:00Z',
    sources: Array.from({ length: size }, (_, i) => ({ source: `s${i}`, root: '/private/root',
      coverage: 'complete_at_scan', lastScan: { status: 'complete', observedAt: '2026-10-19T01:00:00Z', ageMs: 126000000 },
      indexed: { files: 3, bytes: 300 },
      copies: { observedHashedFiles: 2, observedFilesWithOtherSource: 1, unverifiedFiles: 1 } })),
    volumes: Array.from({ length: size }, (_, i) => ({ id: `private-mount-${i}`, label: '/private/mount',
      host: 'synthetic-host', capacityBytes: 1000, freeBytes: 400, filesystem: { type: 'zfs', mountPoint: '/private/mount' },
      observation: { observedAt: '2026-10-19T01:00:00Z', ageMs: 126000000 } })),
    coverage: { omittedSources: 2, omittedVolumes: 3 },
    placement: { compatibility: [{ source: 's0', volumeId: 'private-mount-0', observedCapacityFit: 'fits', indexedBytes: 300, freeBytes: 400 }],
      missingEvidence: ['acceptable_freshness_policy', 'independent_failure_domains'] }
  };
}

test('bounded Core projection preserves unknown freshness, independent backups and placement suitability', () => {
  const result = projectAssessment(assessment(10));
  expect(result.sources).toHaveLength(8);
  expect(result.volumes).toHaveLength(8);
  expect(result.omittedSources).toBe(4);
  expect(result.omittedVolumes).toBe(5);
  expect(result.sources[0]).toMatchObject({ currentCopyCoverage: 'unknown', independentBackupCoverage: 'unknown' });
  expect(result.volumes[0].observation.acceptableFreshness).toBe('unknown');
  expect(result.compatibility[0]).toMatchObject({ volume: 1, observedCapacityFit: 'fits', suitability: 'unknown' });
  expect(result.recommendation).toBe(null);
  expect(JSON.stringify(result)).not.toContain('private');
  expect(result.summary).toMatch(/aucune destination recommandée/);
});

test('storage summary reads existing Data through GET and degrades explicitly when assessment is unavailable', async () => {
  const calls = [];
  const fetchData = jest.fn(async (route, options) => {
    calls.push([route, options]);
    if (route.endsWith('/assessment')) throw new Error('older Data unavailable');
    const data = route.endsWith('/agents') ? { sources: {}, scanners: [] }
      : route.endsWith('/scans') ? { scans: [] } : { totalFiles: 3, totalSize: 300 };
    return { response: { ok: true }, body: { data } };
  });
  const result = await readStorageSummary({}, { fetchData });
  expect(result.totalFiles).toBe(3);
  expect(result.assessment.status).toBe('unavailable');
  expect(result.summary).toMatch(/capacité, copies et placement inconnus/);
  expect(calls.every(([route, options]) => route.startsWith('/api/v1/storage/') && !options.method)).toBe(true);
});

test('storage summary exposes the same bounded assessment with a warning in its French sentence', async () => {
  const result = await readStorageSummary({}, { fetchData: async route => ({ response: { ok: true }, body: {
    data: route.endsWith('/assessment') ? assessment() : route.endsWith('/agents') ? { sources: {} } : {}
  } }) });
  expect(result.assessment.status).toBe('observations_only');
  expect(result.summary).toContain(result.assessment.summary);
  expect(result.assessment.missingEvidence).toContain('acceptable_freshness_policy');
});
