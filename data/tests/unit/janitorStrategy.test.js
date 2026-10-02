jest.mock('../../services/dedupScanner', () => ({
  aggregateDuplicateGroups: jest.fn()
}));

const dedupScanner = require('../../services/dedupScanner');
const strategy = require('../../services/janitorStrategy');

const completePolicy = (overrides = {}) => ({
  version: 1,
  duplicateSurvivor: 'canonical_active',
  backupRetention: 'staging',
  generatedCache: 'review_rebuildable',
  maintenanceAuthorization: 'explicit_per_action',
  ...overrides
});

const evidence = (groups = []) => ({
  roots: [
    {
      root: '/mnt/media', totalFiles: 10, totalBytes: 1000,
      latestScan: { status: 'complete' }, unclassifiedFiles: 2,
      missingExtensionUnresolvedFiles: 1, missingExtensionUnresolvedBytes: 100,
      missingExtensionContentKnownFiles: 1, missingExtensionContentKnownBytes: 100,
      missingExtensionContentUnknownFiles: 0, missingExtensionContentUnknownBytes: 0,
      timestampReviewFiles: 3,
      unclassifiedByExtension: [{ extension: 'bin', files: 2, bytes: 1000 }],
      unclassifiedByTopLevel: [], unresolvedByTopLevel: [],
      contentKnownMissingByTopLevel: [], contentUnknownMissingByTopLevel: [],
      timestampByTopLevel: []
    },
    {
      root: '/mnt/datalake', totalFiles: 20, totalBytes: 2000,
      latestScan: { status: 'complete' }, unclassifiedFiles: 4,
      missingExtensionUnresolvedFiles: 2, missingExtensionUnresolvedBytes: 300,
      missingExtensionContentKnownFiles: 0, missingExtensionContentKnownBytes: 0,
      missingExtensionContentUnknownFiles: 2, missingExtensionContentUnknownBytes: 300,
      timestampReviewFiles: 5,
      unclassifiedByExtension: [{ extension: 'smc', files: 4, bytes: 2000 }],
      unclassifiedByTopLevel: [], unresolvedByTopLevel: [],
      contentKnownMissingByTopLevel: [], contentUnknownMissingByTopLevel: [],
      timestampByTopLevel: []
    }
  ],
  duplicateGroups: groups,
  duplicateCandidates: {
    evidence: 'same-size-not-fully-hashed',
    candidateBytesAreNotSavings: true,
    groups: 7,
    files: 20,
    candidateBytes: 9000,
    filesToHash: 12,
    bytesToHash: 5000
  },
  oversizedUnhashedCandidates: {
    status: 'measured',
    groups: 0,
    files: 0,
    bytesToHash: 0
  }
});

beforeEach(() => jest.clearAllMocks());

describe('shared-drive policy', () => {
  test('defaults to three explicit decisions and no automatic execution choice', () => {
    const policy = strategy.defaultPolicy();
    expect(strategy.decisionsRequired(policy).map(item => item.field)).toEqual([
      'duplicateSurvivor',
      'backupRetention',
      'generatedCache'
    ]);
    expect(policy.maintenanceAuthorization).toBe('explicit_per_action');
    expect(Object.values(strategy.POLICY_CHOICES).flat()).not.toContain('automatic');
  });

  test('rejects invalid or unknown policy values', () => {
    expect(strategy.validatePolicy({ duplicateSurvivor: 'whatever' }).errors[0])
      .toMatch(/duplicateSurvivor/);
    expect(strategy.validatePolicy({ autoExecute: true }).errors[0])
      .toMatch(/unknown policy field/);
    expect(strategy.validatePolicy({ maintenanceAuthorization: 'automatic' }).errors[0])
      .toMatch(/explicit_per_action/);
  });

  test('persists validated partial decisions while preserving fail-closed defaults', async () => {
    let stored = null;
    const collection = {
      findOne: jest.fn(async () => stored),
      updateOne: jest.fn(async (_filter, update) => {
        stored = { _id: strategy.POLICY_ID, ...(stored || {}), ...update.$set };
        return { upsertedCount: 1 };
      })
    };
    const db = { collection: jest.fn(() => collection) };

    const result = await strategy.savePolicy(db, { duplicateSurvivor: 'newest' }, { updatedBy: 'test' });

    expect(result.ok).toBe(true);
    expect(result.policy.duplicateSurvivor).toBe('newest');
    expect(result.policy.backupRetention).toBeNull();
    expect(result.decisions_required.map(item => item.field)).toEqual([
      'backupRetention',
      'generatedCache'
    ]);
  });

  test('updates an already-persisted policy despite stored updatedAt/updatedBy metadata', async () => {
    let stored = null;
    const collection = {
      findOne: jest.fn(async () => stored),
      updateOne: jest.fn(async (_filter, update) => {
        stored = { _id: strategy.POLICY_ID, ...(stored || {}), ...update.$set };
        return { upsertedCount: 1 };
      })
    };
    const db = { collection: jest.fn(() => collection) };

    const first = await strategy.savePolicy(db, completePolicy(), { updatedBy: 'first-writer' });
    expect(first.ok).toBe(true);
    expect(stored.updatedAt).toBeInstanceOf(Date);
    expect(stored.updatedBy).toBe('first-writer');

    // Regression: the second write used to fail with
    // "unknown policy field: updatedAt/updatedBy" because savePolicy merged
    // the stored metadata into the object it re-validated.
    const second = await strategy.savePolicy(
      db,
      { duplicateSurvivor: 'canonical_active' },
      { updatedBy: 'second-writer' }
    );
    expect(second.ok).toBe(true);
    expect(second.errors).toBeUndefined();
    expect(second.policy.duplicateSurvivor).toBe('canonical_active');
    expect(second.policy.backupRetention).toBe('staging');
    expect(stored.updatedBy).toBe('second-writer');
  });
});

describe('strategy construction', () => {
  const group = {
    _id: 'sha-current',
    count: 2,
    size: 100,
    files: [
      { path: '/mnt/media/active/new.txt', mtime: 200, storageRole: 'document' },
      { path: '/mnt/media/active/old.txt', mtime: 100, storageRole: 'document' }
    ]
  };

  test('incomplete policy is awaiting_policy with zero proposals and executable actions', () => {
    const report = strategy.buildStrategy(strategy.defaultPolicy(), evidence([group]));

    expect(report.status).toBe('awaiting_policy');
    expect(report.decisions_required).toHaveLength(3);
    expect(report.maintenance.proposals).toEqual([]);
    expect(report.maintenance.executableActions).toEqual([]);
    expect(report.organizationStrategy.status).toBe('ready');
    expect(report.organizationStrategy.workItems).toHaveLength(3);
    expect(report.strategySchemaVersion).toBe(6);
    expect(report.organizationStrategy.candidateIndexComplete).toBe(true);
    expect(report.organizationStrategy.candidateIndex).toHaveLength(3);
    expect(report.organizationStrategy.workItems[0]).toMatchObject({
      type: 'hash_coverage',
      root: 'portfolio',
      disposition: 'plan_read_only_candidate_hashing',
      evidence: {
        files: 12,
        bytes: 5000,
        candidateGroups: 7,
        bytesAreHashingWorkloadNotSavings: true
      },
      filesystemMutationAllowed: false
    });
    expect(report.organizationStrategy.workItems.every(item => item.filesystemMutationAllowed === false)).toBe(true);
    expect(report.comparison).toMatchObject({
      status: 'baseline',
      deltas: null,
      organization: { status: 'baseline', reason: 'no_previous_report' }
    });
    expect(report.evidence.verifiedDuplicateGroups).toBe(1);
    expect(report.evidence.provenSavingsBytes).toBe(100);
    expect(report.evidence.verifiedDuplicateEvidence[0]).toMatchObject({
      sha256: 'sha-current',
      proof: 'sha256-current-metadata',
      files: [
        { path: '/mnt/media/active/new.txt' },
        { path: '/mnt/media/active/old.txt' }
      ]
    });
    expect(report.evidence.duplicateCandidates.candidateBytesAreNotSavings).toBe(true);
    expect(report.evidence.duplicateCandidates).toMatchObject({ filesToHash: 12, bytesToHash: 5000 });
    expect(report.evidence.metadataFirst).toMatchObject({
      status: 'measured',
      indexedFiles: 30,
      indexedBytes: 3000,
      organizationReviewAvailable: true,
      exactDuplicateProofRequired: true,
      filesystemMutationAllowed: false
    });
    expect(report.evidence.verificationQueue).toMatchObject({
      status: 'prioritized',
      ordering: ['potential_duplicate_bytes_desc', 'file_size_desc'],
      groups: 7,
      potentialDuplicateBytes: 9000,
      potentialDuplicateBytesAreNotSavings: true,
      exactDuplicateProofRequired: true,
      filesystemMutationAllowed: false
    });
    expect(report.evidence.verificationOutlook).toMatchObject({
      status: 'unavailable',
      filesToHash: 12,
      bytesToHash: 5000
    });
    expect(report.evidence.oversizedUnhashedCandidates).toEqual({
      status: 'measured',
      evidence: 'same-size-candidates-above-latest-root-hash-budget',
      groups: 0,
      files: 0,
      bytesToHash: 0,
      bytesAreNotSavings: true,
      fileIdentityIncluded: false,
      filesystemMutationAllowed: false,
      note: expect.stringContaining('Bytes-to-hash are not savings')
    });
    expect(report.metadataRecommendations).toEqual([
      expect.objectContaining({
        root: '/mnt/media',
        missingExtensionUnresolvedFiles: 1,
        missingExtensionUnresolvedBytes: 100,
        missingExtensionContentKnownFiles: 1,
        missingExtensionContentKnownBytes: 100,
        missingExtensionContentUnknownFiles: 0,
        missingExtensionContentUnknownBytes: 0
      }),
      expect.objectContaining({
        root: '/mnt/datalake',
        missingExtensionUnresolvedFiles: 2,
        missingExtensionUnresolvedBytes: 300,
        missingExtensionContentKnownFiles: 0,
        missingExtensionContentKnownBytes: 0,
        missingExtensionContentUnknownFiles: 2,
        missingExtensionContentUnknownBytes: 300
      })
    ]);
    expect(report.policy).toMatchObject({
      duplicateSurvivor: null,
      backupRetention: null,
      generatedCache: null,
      maintenanceAuthorization: 'explicit_per_action'
    });
    expect(report.policyDecisionSupport).toMatchObject({
      mode: 'aggregate-read-only-decision-support',
      basis: {
        verifiedGroups: 1,
        verifiedFiles: 2,
        provenSavingsBytes: 100,
        unverifiedCandidatesExcluded: true,
        candidateBytesIncluded: false
      },
      duplicateSurvivor: {
        selectionDifferences: {
          canonicalVsNewest: 0,
          canonicalVsOldest: 1,
          newestVsOldest: 1
        },
        selectedValue: null,
        recommendedValue: null
      },
      safety: { sharedDriveMutations: 0, policyPersisted: false }
    });
  });

  test('fails closed when metadata-first or verification-queue evidence is incomplete', () => {
    expect(strategy.metadataFirstEvidence([{ root: '/mnt/media' }])).toMatchObject({
      status: 'unavailable', organizationReviewAvailable: false, filesystemMutationAllowed: false
    });
    expect(strategy.verificationQueueEvidence({ groups: 1 })).toMatchObject({
      status: 'unavailable', potentialDuplicateBytesAreNotSavings: true, filesystemMutationAllowed: false
    });
    expect(strategy.verificationQueueEvidence({
      groups: 0, files: 0, candidateBytes: 0, filesToHash: 0, bytesToHash: 0
    })).toMatchObject({ status: 'empty', exactDuplicateProofRequired: true });
  });

  test('uses newest only after the explicit survivor rule is present', () => {
    const report = strategy.buildStrategy(
      completePolicy({ duplicateSurvivor: 'newest' }),
      evidence([group])
    );

    expect(report.status).toBe('ready_for_review');
    expect(report.maintenance.proposals).toHaveLength(1);
    expect(report.maintenance.proposals[0]).toMatchObject({
      evidence: 'sha256-current-metadata',
      survivorRule: 'newest',
      keep: { path: '/mnt/media/active/new.txt' },
      files: ['/mnt/media/active/old.txt'],
      approval_required: true,
      execution_authorized: false
    });
    expect(report.maintenance.executableActions).toEqual([]);
  });

  test('canonical_active prefers an active path over a backup path deterministically', () => {
    const duplicate = {
      _id: 'sha-canonical', count: 2, size: 5,
      files: [
        { path: '/mnt/datalake/backups/project/file.bin', mtime: 300, storageRole: 'backup_copy' },
        { path: '/mnt/datalake/project/file.bin', mtime: 100, storageRole: 'document' }
      ]
    };
    const plan = strategy.buildDuplicatePlan([duplicate], completePolicy());
    expect(plan.proposals[0].keep.path).toBe('/mnt/datalake/project/file.bin');
  });

  test('fileContext recognises backup directories by whole segment on either separator', () => {
    expect(strategy.fileContext({ path: 'D:\\share\\Cloud-Backup\\file.bin' }).backup).toBe(true);
    expect(strategy.fileContext({ path: '/mnt/datalake/backups/file.bin' }).backup).toBe(true);
    expect(strategy.fileContext({ path: '/mnt/datalake/nobackup/report.pdf' }).backup).toBe(false);
    expect(strategy.fileContext({ path: '/mnt/datalake/live/report.pdf', storageRole: 'backup_copy' }).backup).toBe(true);
  });

  test('archive and cache-preserve policies suppress affected proposals', () => {
    const backupGroup = {
      _id: 'sha-backup', count: 2, size: 5,
      files: [
        { path: '/mnt/datalake/backups/a', mtime: 1, storageRole: 'backup_copy' },
        { path: '/mnt/datalake/live/a', mtime: 2, storageRole: 'document' }
      ]
    };
    const cacheGroup = {
      _id: 'sha-cache', count: 2, size: 5,
      files: [
        { path: '/mnt/datalake/project/Library/a', mtime: 1, storageRole: 'generated_cache' },
        { path: '/mnt/datalake/project/a', mtime: 2, storageRole: 'document' }
      ]
    };
    const plan = strategy.buildDuplicatePlan(
      [backupGroup, cacheGroup],
      completePolicy({ backupRetention: 'immutable_archive', generatedCache: 'preserve' })
    );
    expect(plan.proposals).toEqual([]);
    expect(plan.omitted).toEqual({ backupPolicy: 1, generatedCachePolicy: 1 });
  });
});

describe('indexed evidence scope', () => {
  const hashScan = bytes => ({
    status: 'complete',
    started_at: '2026-07-19T01:00:00.000Z',
    finished_at: '2026-07-19T01:01:00.000Z',
    counts: { hashed: 10, hash_bytes: 100 },
    config: { hash_mode: 'candidates', hash_max_files: 500, hash_max_bytes: bytes }
  });

  test('portfolio candidate pipeline groups across roots and applies each root budget', () => {
    const pipeline = strategy.candidateEvidencePipeline([
      { root: '/mnt/media', latestHashingScan: { hashMaxBytes: 10 } },
      { root: '/mnt/datalake', latestHashingScan: { hashMaxBytes: 20 } }
    ]);

    expect(pipeline[0].$match.$or).toHaveLength(2);
    expect(pipeline[1].$group._id).toBe('$size');
    expect(pipeline[2]).toEqual({
      $match: { count: { $gt: 1 }, $expr: { $lt: ['$currentHashed', '$count'] } }
    });
    const expression = pipeline[1].$group.oversizedUnhashed.$sum.$cond[0];
    expect(expression.$and[0]).toMatchObject({
      $eq: [{
        $and: [
          { $ne: [{ $ifNull: ['$sha256', ''] }, ''] },
          expect.any(Object)
        ]
      }, false]
    });
    const rootClauses = expression.$and[1].$or;
    expect(rootClauses).toHaveLength(2);
    expect(rootClauses[0].$and[0].$regexMatch.regex).toContain('/mnt/media');
    expect(rootClauses[0].$and[1]).toEqual({ $gt: ['$size', 10] });
    expect(rootClauses[1].$and[0].$regexMatch.regex).toContain('/mnt/datalake');
    expect(rootClauses[1].$and[1]).toEqual({ $gt: ['$size', 20] });
    expect(pipeline[3].$facet.oversized[0]).toEqual({
      $match: { oversizedUnhashed: { $gt: 0 } }
    });
    expect(pipeline[3].$facet.totals[0].$group).toMatchObject({
      filesToHash: { $sum: { $subtract: ['$count', '$currentHashed'] } },
      bytesToHash: { $sum: { $multiply: ['$_id', { $subtract: ['$count', '$currentHashed'] }] } }
    });
  });

  test('oversized aggregate fails closed without both budgets and strips identities', () => {
    const unavailable = strategy.oversizedUnhashedEvidence(
      { oversized: [{ groups: 4, files: 5, bytesToHash: 600 }] },
      [{ root: '/mnt/media', latestHashingScan: { hashMaxBytes: 10 } }]
    );
    expect(unavailable).toMatchObject({
      status: 'unavailable', groups: null, files: null, bytesToHash: null,
      bytesAreNotSavings: true, fileIdentityIncluded: false,
      filesystemMutationAllowed: false
    });

    const safe = strategy.publicOversizedUnhashedEvidence({
      status: 'measured', groups: 1, files: 2, bytesToHash: 30,
      path: '/mnt/media/private.bin', sha256: 'secret', filename: 'private.bin'
    });
    expect(safe).toMatchObject({
      status: 'measured', groups: 1, files: 2, bytesToHash: 30,
      bytesAreNotSavings: true, fileIdentityIncluded: false,
      filesystemMutationAllowed: false
    });
    expect(safe).not.toHaveProperty('path');
    expect(safe).not.toHaveProperty('filename');
    expect(safe).not.toHaveProperty('sha256');
    expect(strategy.publicOversizedUnhashedEvidence({
      status: 'measured', groups: null, files: null, bytesToHash: null
    }).status).toBe('unavailable');
  });

  test('verification pace requires completed two-root evidence and honors file and byte bounds', () => {
    const candidates = { filesToHash: 1000, bytesToHash: 9000 };
    const roots = [
      {
        root: '/mnt/media',
        latestHashingScan: {
          status: 'complete', hashMaxFiles: 100, hashMaxBytes: 1000,
          hashedFiles: 20, hashedBytes: 300, durationSeconds: 30
        }
      },
      {
        root: '/mnt/datalake',
        latestHashingScan: {
          status: 'complete', hashMaxFiles: 200, hashMaxBytes: 2000,
          hashedFiles: 30, hashedBytes: 700, durationSeconds: 70
        }
      }
    ];
    const measured = strategy.buildVerificationOutlook(roots, candidates);

    expect(measured).toMatchObject({
      status: 'measured',
      filesToHash: 1000,
      bytesToHash: 9000,
      latestCompletedCycle: {
        hashedFiles: 50,
        hashedBytes: 1000,
        durationSeconds: 100,
        estimatedComparableCyclesLowerBound: 20
      },
      configuredCapacity: {
        maxFiles: 300,
        maxBytes: 3000,
        estimatedCyclesLowerBound: 4
      }
    });

    roots[1].latestHashingScan.status = 'failed';
    expect(strategy.buildVerificationOutlook(roots, candidates)).toMatchObject({
      status: 'unavailable',
      filesToHash: 1000,
      bytesToHash: 9000,
      latestCompletedCycle: null,
      configuredCapacity: null
    });
  });

  test('groups SHA evidence across the two disjoint canonical namespaces exactly once', async () => {
    dedupScanner.aggregateDuplicateGroups.mockResolvedValue([]);
    const aggregateResults = [
      [{
        totals: [{ groups: 2, files: 5, candidateBytes: 1000, filesToHash: 3, bytesToHash: 600 }],
        oversized: [{ groups: 1, files: 1, bytesToHash: 2000 }]
      }],
      [{
        summary: [{
          totalFiles: 10, totalBytes: 100,
          missingExtensionUnresolvedFiles: 3,
          missingExtensionUnresolvedBytes: 30,
          missingExtensionContentKnownFiles: 1,
          missingExtensionContentKnownBytes: 10,
          missingExtensionContentUnknownFiles: 2,
          missingExtensionContentUnknownBytes: 20
        }],
        storageRoles: [],
        unclassifiedByExtension: [{ _id: 'bin', files: 2, bytes: 50 }],
        unclassifiedByTopLevel: [{ _id: 'dump', files: 2, bytes: 50 }],
        unresolvedByTopLevel: [{ _id: 'dump', files: 1, bytes: 10 }],
        contentKnownMissingByTopLevel: [{ _id: 'known', files: 1, bytes: 10 }],
        contentUnknownMissingByTopLevel: [{ _id: 'unknown', files: 2, bytes: 20 }],
        timestampByTopLevel: [{ _id: 'archive', files: 3, bytes: 30 }],
        timestampByQuality: [{
          _id: 'legacy_or_suspect', files: 3, bytes: 30,
          minMtime: 315550800, maxMtime: 315550800
        }],
        timestampDominantByTopLevel: [{
          _id: 'archive',
          cluster: {
            timestampQuality: 'legacy_or_suspect', mtime: 315550800,
            storageRole: 'backup_copy', files: 3, bytes: 30
          }
        }]
      }],
      [{ summary: [{ totalFiles: 20, totalBytes: 200 }], storageRoles: [] }]
    ];
    const files = {
      aggregate: jest.fn(() => ({ toArray: async () => aggregateResults.shift() }))
    };
    const scans = {
      findOne: jest.fn(async query => (
        query['config.hash_mode'] ? hashScan(1000) : null
      ))
    };
    const db = {
      collection: jest.fn(name => (name === 'nas_files' ? files : scans))
    };

    const result = await strategy.collectEvidence(db);

    expect(dedupScanner.aggregateDuplicateGroups).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ rootPaths: ['/mnt/media', '/mnt/datalake'] })
    );
    expect(result.roots.map(root => root.root)).toEqual(['/mnt/media', '/mnt/datalake']);
    expect(result.roots.reduce((sum, root) => sum + root.totalFiles, 0)).toBe(30);
    expect(result.duplicateCandidates).toMatchObject({ filesToHash: 3, bytesToHash: 600 });
    expect(result.verificationOutlook).toMatchObject({
      status: 'measured',
      latestCompletedCycle: {
        hashedFiles: 20,
        hashedBytes: 200,
        estimatedComparableCyclesLowerBound: 3
      },
      configuredCapacity: { maxFiles: 1000, maxBytes: 2000, estimatedCyclesLowerBound: 1 }
    });
    expect(result.roots[0]).toMatchObject({
      unclassifiedByExtension: [{ extension: 'bin', files: 2, bytes: 50 }],
      unclassifiedByTopLevel: [{ topLevel: 'dump', files: 2, bytes: 50 }],
      unresolvedByTopLevel: [{ topLevel: 'dump', files: 1, bytes: 10 }],
      contentKnownMissingByTopLevel: [{ topLevel: 'known', files: 1, bytes: 10 }],
      contentUnknownMissingByTopLevel: [{ topLevel: 'unknown', files: 2, bytes: 20 }],
      timestampQualityTotals: [
        expect.objectContaining({
          timestampQuality: 'legacy_or_suspect', files: 3,
          minMtimeUtc: '1980-01-01T05:00:00.000Z'
        }),
        expect.objectContaining({ timestampQuality: 'future_suspect', files: 0 })
      ],
      timestampByTopLevel: [{
        topLevel: 'archive', files: 3, bytes: 30,
        dominantRepeatedTimestamp: expect.objectContaining({
          timestampQuality: 'legacy_or_suspect',
          mtimeSeconds: 315550800,
          mtimeUtc: '1980-01-01T05:00:00.000Z',
          storageRole: 'backup_copy',
          files: 3,
          shareOfAreaFiles: 1
        })
      }]
    });
    expect(result.roots[0].missingExtensionContentKnownFiles
      + result.roots[0].missingExtensionContentUnknownFiles)
      .toBe(result.roots[0].missingExtensionUnresolvedFiles);
    expect(result.roots[0].missingExtensionContentKnownBytes
      + result.roots[0].missingExtensionContentUnknownBytes)
      .toBe(result.roots[0].missingExtensionUnresolvedBytes);
    expect(strategy.missingExtensionContentKnownMatch()).toEqual({
      extension_status: 'missing_unresolved',
      content_probe_status: 'matched',
      content_type_source: 'content-signature'
    });
    expect(strategy.missingExtensionContentUnknownMatch()).toEqual({
      extension_status: 'missing_unresolved',
      $or: [
        { content_probe_status: { $ne: 'matched' } },
        { content_type_source: { $ne: 'content-signature' } }
      ]
    });
    const mediaFacets = files.aggregate.mock.calls[1][0][1].$facet;
    expect(mediaFacets.contentKnownMissingByTopLevel[0].$match)
      .toEqual(strategy.missingExtensionContentKnownMatch());
    expect(mediaFacets.contentUnknownMissingByTopLevel[0].$match)
      .toEqual(strategy.missingExtensionContentUnknownMatch());
    expect(result.duplicateCandidates.candidateBytesAreNotSavings).toBe(true);
    expect(result.duplicateCandidates).toMatchObject({
      groups: 2, files: 5, candidateBytes: 1000
    });
    expect(result.oversizedUnhashedCandidates).toMatchObject({
      status: 'measured', groups: 1, files: 1, bytesToHash: 2000,
      bytesAreNotSavings: true, fileIdentityIncluded: false,
      filesystemMutationAllowed: false
    });
    const candidatePipeline = files.aggregate.mock.calls[0][0];
    expect(candidatePipeline[0].$match.$or).toHaveLength(2);
    expect(candidatePipeline[1].$group._id).toBe('$size');
  });
});

describe('strategy report persistence', () => {
  test('stores large duplicate evidence in bounded detail chunks and hydrates the public report', async () => {
    const groups = Array.from({ length: 205 }, (_, index) => ({
      _id: `sha-${index}`,
      count: 2,
      size: 100 + index,
      files: [
        { path: `/mnt/media/keep-${index}.bin`, mtime: 2, storageRole: 'document' },
        { path: `/mnt/media/copy-${index}.bin`, mtime: 1, storageRole: 'document' }
      ]
    }));
    const report = strategy.buildStrategy(completePolicy(), evidence(groups));
    let persistedReport = null;
    const detailDocs = [];
    const reports = {
      insertOne: jest.fn(async doc => {
        persistedReport = doc;
        return { insertedId: doc._id };
      }),
      findOne: jest.fn(async () => persistedReport)
    };
    const details = {
      insertMany: jest.fn(async docs => { detailDocs.push(...docs); }),
      deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
      find: jest.fn(() => ({
        sort: jest.fn(() => ({ toArray: jest.fn(async () => [...detailDocs]) }))
      }))
    };
    const db = {
      collection: jest.fn(name => (
        name === strategy.REPORT_COLLECTION ? reports : details
      ))
    };

    const insertedId = await strategy.persistStrategyReport(db, report);
    const hydrated = await strategy.getLatestStrategy(db);

    expect(insertedId).toEqual(persistedReport._id);
    expect(detailDocs).toHaveLength(3);
    expect(detailDocs.every(doc => doc.groups.length <= 100)).toBe(true);
    expect(persistedReport.evidence.verifiedDuplicateEvidence).toEqual([]);
    expect(persistedReport.maintenance.proposals).toEqual([]);
    expect(persistedReport.detailStorage).toMatchObject({
      schemaVersion: 1,
      chunks: 3,
      verifiedDuplicateGroups: 205
    });
    expect(hydrated.evidence.verifiedDuplicateEvidence).toHaveLength(205);
    expect(hydrated.maintenance.proposals).toHaveLength(205);
    expect(hydrated.maintenance.proposals[0]).toMatchObject({
      execution_authorized: false,
      approval_required: true
    });
  });

  test('fails closed when persisted detail evidence is incomplete', async () => {
    const report = {
      _id: 'report-1',
      policy: completePolicy(),
      evidence: { verifiedDuplicateEvidence: [] },
      maintenance: { proposals: [] },
      detailStorage: { schemaVersion: 1, chunks: 2, verifiedDuplicateGroups: 1 }
    };
    const db = {
      collection: jest.fn(() => ({
        find: jest.fn(() => ({
          sort: jest.fn(() => ({ toArray: jest.fn(async () => [{ ordinal: 0, groups: [] }]) }))
        }))
      }))
    };

    await expect(strategy.hydrateStrategyReport(db, report))
      .rejects.toThrow('expected 2 chunks, found 1');
  });
});
