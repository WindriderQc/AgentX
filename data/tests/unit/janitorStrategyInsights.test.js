const insights = require('../../services/janitorStrategyInsights');

function report(overrides = {}) {
  const base = {
    _id: 'report-current',
    generatedAt: new Date('2026-07-18T00:00:00Z'),
    mode: 'read-only-strategy',
    scope: { canonicalRoots: ['/mnt/media', '/mnt/datalake'] },
    evidence: {
      verifiedDuplicateGroups: 12,
      verifiedDuplicateFiles: 30,
      provenSavingsBytes: 5000,
      duplicateCandidates: { groups: 40, files: 100, candidateBytes: 9000 },
      perRoot: [
        {
          root: '/mnt/media', totalFiles: 100, totalBytes: 1000,
          unclassifiedFiles: 5, extensionlessByDesignFiles: 2,
          missingExtensionUnresolvedFiles: 1, timestampReviewFiles: 3
        },
        {
          root: '/mnt/datalake', totalFiles: 200, totalBytes: 2000,
          unclassifiedFiles: 10, extensionlessByDesignFiles: 4,
          missingExtensionUnresolvedFiles: 2, timestampReviewFiles: 6
        }
      ]
    }
  };
  return { ...base, ...overrides };
}

function indexedOrganization(items, overrides = {}) {
  return {
    candidateIndexVersion: 1,
    candidateIndexMaxItems: insights.MAX_CANDIDATE_ITEMS,
    candidateIndexComplete: true,
    totalCandidateItems: items.length,
    candidateIndex: items.map(item => ({
      id: item.id,
      type: item.type || 'metadata_extension_rule',
      root: item.root || '/mnt/datalake',
      title: item.title || item.id,
      priority: item.priority || 'review',
      evidence: { files: item.files, bytes: item.bytes },
      filesystemMutationAllowed: false
    })),
    ...overrides
  };
}

describe('strategy comparison', () => {
  test('uses an explicit baseline when no prior report exists', () => {
    const comparison = insights.buildComparison(report(), null);
    expect(comparison).toMatchObject({
      status: 'baseline',
      reason: 'no_previous_report',
      previousReportId: null,
      deltas: null
    });
    expect(comparison.note).toMatch(/not an improvement or regression/);
  });

  test('uses a baseline instead of comparing incompatible scope', () => {
    const previous = report({
      _id: 'previous',
      scope: { canonicalRoots: ['/mnt/datalake'] }
    });
    const comparison = insights.buildComparison(report(), previous);
    expect(comparison.status).toBe('baseline');
    expect(comparison.reason).toBe('canonical_scope_changed');
    expect(comparison.previousReportId).toBe('previous');
    expect(comparison.deltas).toBeNull();
  });

  test('uses a baseline when a prior root metric is unavailable', () => {
    const previous = report({ _id: 'previous' });
    delete previous.evidence.perRoot[0].timestampReviewFiles;

    const comparison = insights.buildComparison(report(), previous);

    expect(comparison).toMatchObject({
      status: 'baseline',
      reason: 'previous_root_metrics_unavailable',
      deltas: null
    });
  });

  test('computes signed duplicate, candidate, and per-root metadata deltas', () => {
    const previous = report({
      _id: 'previous',
      generatedAt: new Date('2026-07-17T00:00:00Z'),
      evidence: {
        verifiedDuplicateGroups: 10,
        verifiedDuplicateFiles: 28,
        provenSavingsBytes: 4500,
        duplicateCandidates: { groups: 45, files: 105, candidateBytes: 9500 },
        perRoot: [
          {
            root: '/mnt/media', totalFiles: 99, totalBytes: 990,
            unclassifiedFiles: 7, extensionlessByDesignFiles: 2,
            missingExtensionUnresolvedFiles: 2, timestampReviewFiles: 3
          },
          {
            root: '/mnt/datalake', totalFiles: 205, totalBytes: 2100,
            unclassifiedFiles: 9, extensionlessByDesignFiles: 3,
            missingExtensionUnresolvedFiles: 2, timestampReviewFiles: 8
          }
        ]
      }
    });

    const comparison = insights.buildComparison(report(), previous);

    expect(comparison).toMatchObject({
      status: 'compared',
      previousReportId: 'previous',
      deltas: {
        duplicates: { verifiedGroups: 2, verifiedFiles: 2, provenSavingsBytes: 500 },
        candidates: { groups: -5, files: -5, candidateBytes: -500 }
      }
    });
    expect(comparison.deltas.perRoot).toEqual([
      expect.objectContaining({
        root: '/mnt/datalake', totalFiles: -5, unclassifiedFiles: 1,
        extensionlessByDesignFiles: 1, timestampReviewFiles: -2
      }),
      expect.objectContaining({
        root: '/mnt/media', totalFiles: 1, unclassifiedFiles: -2,
        missingExtensionUnresolvedFiles: -1, timestampReviewFiles: 0
      })
    ]);
    expect(comparison.note).toMatch(/descriptive indexed-evidence changes/);
  });
});

describe('organization work plan', () => {
  test('ranks deterministic bounded non-destructive work items from indexed hotspots', () => {
    const evidence = {
      roots: [{
        root: '/mnt/datalake',
        unclassifiedByExtension: [
          { extension: 'smc', files: 535, bytes: 746 * 1024 * 1024 },
          { extension: 'x', files: 10, bytes: 1024 }
        ],
        unclassifiedByTopLevel: [
          { topLevel: 'dump', files: 72, bytes: 8 * 1024 * 1024 }
        ],
        unresolvedByTopLevel: [
          { topLevel: 'legacy-fallback', files: 999, bytes: 999 }
        ],
        contentUnknownMissingByTopLevel: [
          { topLevel: 'backups', files: 310, bytes: 58 * 1024 * 1024 }
        ],
        contentKnownMissingByTopLevel: [
          { topLevel: 'known-media', files: 12, bytes: 5 * 1024 * 1024 }
        ],
        timestampByTopLevel: [
          {
            topLevel: 'CloudBackup', files: 400, bytes: 10 * 1024 * 1024,
            dominantRepeatedTimestamp: {
              timestampQuality: 'legacy_or_suspect',
              mtimeSeconds: 312786000,
              mtimeUtc: '1979-11-30T05:00:00.000Z',
              storageRole: 'backup_copy',
              files: 314,
              bytes: 4 * 1024 * 1024,
              shareOfAreaFiles: 0.785
            }
          }
        ]
      }]
    };

    const first = insights.buildOrganizationStrategy(evidence);
    const second = insights.buildOrganizationStrategy(evidence);

    expect(second).toEqual(first);
    expect(first.status).toBe('ready');
    expect(first.workItems.length).toBeLessThanOrEqual(insights.MAX_WORK_ITEMS);
    expect(first.workItems[0]).toMatchObject({
      rank: 1,
      id: 'metadata-extension-rule:mnt-datalake:smc',
      type: 'metadata_extension_rule',
      root: '/mnt/datalake',
      priority: 'high',
      evidence: { files: 535, bytes: 746 * 1024 * 1024 },
      filesystemMutationAllowed: false
    });
    expect(first.workItems.every(item => item.filesystemMutationAllowed === false)).toBe(true);
    expect(first.candidateIndexVersion).toBe(1);
    expect(first.candidateIndexComplete).toBe(true);
    expect(first.candidateIndex).toHaveLength(first.totalCandidateItems);
    expect(first.candidateIndex.every(item => (
      item.filesystemMutationAllowed === false
      && !Object.prototype.hasOwnProperty.call(item, 'path')
    ))).toBe(true);
    expect(new Set(first.candidateIndex.map(item => item.id)).size).toBe(first.candidateIndex.length);
    expect(first.workItems.map(item => item.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    const unknownContentItem = first.workItems.find(
      item => item.type === 'missing_extension_content_unknown_area'
    );
    expect(unknownContentItem).toMatchObject({
      title: 'Investigate unknown content evidence in backups',
      evidence: { files: 310, bytes: 58 * 1024 * 1024 },
      filesystemMutationAllowed: false
    });
    expect(unknownContentItem.rationale).toMatch(/content is not yet proven/i);
    const knownContentItem = first.workItems.find(
      item => item.type === 'missing_extension_content_known_area'
    );
    expect(knownContentItem).toMatchObject({
      title: 'Review intentional extensionless naming in known-media',
      evidence: { files: 12, bytes: 5 * 1024 * 1024 },
      filesystemMutationAllowed: false
    });
    expect(knownContentItem.rationale).toMatch(/do not recommend or perform a rename/i);
    expect(first.workItems.some(item => item.title.includes('legacy-fallback'))).toBe(false);
    const timestampItem = first.workItems.find(item => item.type === 'timestamp_review_area');
    expect(timestampItem).toMatchObject({
      evidence: {
        dominantRepeatedTimestamp: {
          mtimeUtc: '1979-11-30T05:00:00.000Z',
          storageRole: 'backup_copy',
          files: 314,
          shareOfAreaFiles: 0.785
        }
      },
      filesystemMutationAllowed: false
    });
    expect(timestampItem.rationale).toMatch(/preserved tool\/build or source metadata/);
    expect(timestampItem.rationale).toMatch(/never deletion evidence/);
  });

  test('conservatively treats legacy unsplit missing-extension hotspots as content-unknown', () => {
    const result = insights.buildOrganizationStrategy({
      roots: [{
        root: '/mnt/media',
        unresolvedByTopLevel: [{ topLevel: 'legacy', files: 4, bytes: 40 }]
      }]
    });

    expect(result.workItems).toEqual([
      expect.objectContaining({
        type: 'missing_extension_content_unknown_area',
        title: 'Investigate unknown content evidence in legacy',
        evidence: { files: 4, bytes: 40 },
        filesystemMutationAllowed: false
      })
    ]);
  });

  test('makes the not-current hash workload the top read-only work item', () => {
    const result = insights.buildOrganizationStrategy({
      duplicateCandidates: {
        groups: 25000,
        files: 220000,
        candidateBytes: 180000000000,
        filesToHash: 190000,
        bytesToHash: 170000000000
      },
      roots: [{
        root: '/mnt/datalake',
        timestampByTopLevel: [{ topLevel: 'backups', files: 5909, bytes: 34 * 1024 * 1024 }]
      }]
    });

    expect(result.workItems[0]).toMatchObject({
      id: 'hash-coverage:portfolio:same-size-candidates',
      type: 'hash_coverage',
      root: 'portfolio',
      disposition: 'plan_read_only_candidate_hashing',
      evidence: {
        files: 190000,
        bytes: 170000000000,
        candidateGroups: 25000,
        bytesAreHashingWorkloadNotSavings: true,
        basis: 'not-current candidate members only'
      },
      filesystemMutationAllowed: false
    });
    expect(result.workItems[0].rationale).toMatch(/read-only sha-256 hashing/i);
    expect(result.workItems[0].rationale).toMatch(/never modified/i);
  });

  test('keeps hash coverage first even when a metadata signal has more files', () => {
    const result = insights.buildOrganizationStrategy({
      duplicateCandidates: {
        groups: 1,
        filesToHash: 1,
        bytesToHash: 100,
      },
      roots: [{
        root: '/mnt/datalake',
        timestampByTopLevel: [{ topLevel: 'backups', files: 9999, bytes: 9999 }],
      }],
    });

    expect(result.workItems.map(item => item.type)).toEqual([
      'hash_coverage',
      'timestamp_review_area',
    ]);
  });

  test('labels matching aggregate evidence as correlation rather than duplicate proof', () => {
    const result = insights.buildOrganizationStrategy({
      roots: [{
        root: '/mnt/datalake',
        timestampByTopLevel: [
          { topLevel: 'Desktop', files: 157, bytes: 1887436 },
          { topLevel: 'CloudBackup', files: 157, bytes: 1887436 }
        ]
      }]
    });
    const desktop = result.workItems.find(item => item.id === 'timestamp-review-area:mnt-datalake:desktop');
    const cloudBackup = result.workItems.find(item => item.id === 'timestamp-review-area:mnt-datalake:cloudbackup');

    expect(desktop).toMatchObject({
      likelyMirrorOf: ['timestamp-review-area:mnt-datalake:cloudbackup'],
      likelyMirrorEvidenceOnly: true
    });
    expect(cloudBackup).toMatchObject({
      likelyMirrorOf: ['timestamp-review-area:mnt-datalake:desktop'],
      likelyMirrorEvidenceOnly: true
    });
    expect(desktop.rationale).toMatch(/never deletion evidence/i);
  });

  test('returns an explicit empty state when there are no indexed hotspots', () => {
    expect(insights.buildOrganizationStrategy({ roots: [] })).toEqual({
      status: 'no_indexed_hotspots',
      mode: 'non-destructive-work-plan',
      generatedFrom: 'indexed-metadata-hotspots',
      totalCandidateItems: 0,
      maxItems: insights.MAX_WORK_ITEMS,
      workItems: [],
      candidateIndexVersion: 1,
      candidateIndexMaxItems: insights.MAX_CANDIDATE_ITEMS,
      candidateIndexComplete: true,
      candidateIndex: [],
      note: 'Work items improve metadata and organization knowledge only; they do not authorize file mutation.'
    });
  });

  test('bounds the aggregate candidate index and marks non-canonical overflow incomplete', () => {
    const root = index => ({
      root: `/mnt/root-${index}`,
      unclassifiedByExtension: Array.from({ length: insights.HOTSPOT_LIMIT }, (_, row) => ({
        extension: `ext-${row}`, files: row + 1, bytes: row + 10
      })),
      contentUnknownMissingByTopLevel: Array.from({ length: insights.HOTSPOT_LIMIT }, (_, row) => ({
        topLevel: `unknown-${row}`, files: row + 1, bytes: row + 20
      })),
      contentKnownMissingByTopLevel: Array.from({ length: insights.HOTSPOT_LIMIT }, (_, row) => ({
        topLevel: `known-${row}`, files: row + 1, bytes: row + 30
      })),
      unclassifiedByTopLevel: Array.from({ length: insights.HOTSPOT_LIMIT }, (_, row) => ({
        topLevel: `area-${row}`, files: row + 1, bytes: row + 40
      })),
      timestampByTopLevel: Array.from({ length: insights.HOTSPOT_LIMIT }, (_, row) => ({
        topLevel: `time-${row}`, files: row + 1, bytes: row + 50
      }))
    });

    const first = insights.buildOrganizationStrategy({ roots: [root(1), root(2), root(3)] });
    const second = insights.buildOrganizationStrategy({ roots: [root(1), root(2), root(3)] });

    expect(second).toEqual(first);
    expect(first.totalCandidateItems).toBeGreaterThan(insights.MAX_CANDIDATE_ITEMS);
    expect(first.candidateIndex).toHaveLength(insights.MAX_CANDIDATE_ITEMS);
    expect(first.candidateIndexComplete).toBe(false);
    expect(insights.compareOrganization(first, first)).toMatchObject({
      status: 'baseline',
      reason: 'current_candidate_index_incomplete',
      counts: null
    });
  });
});

describe('organization progress comparison', () => {
  test('labels a legacy prior report with no candidate index as an explicit baseline', () => {
    const current = report({
      organizationStrategy: indexedOrganization([{ id: 'current', files: 1, bytes: 2 }])
    });
    const previous = report({ _id: 'legacy-report' });

    expect(insights.buildComparison(current, previous).organization).toMatchObject({
      status: 'baseline',
      reason: 'previous_candidate_index_unavailable',
      counts: null,
      totals: { current: 1, previous: null }
    });
  });

  test('accounts for new, improved, worsened, unchanged, and resolved aggregate evidence', () => {
    const previous = indexedOrganization([
      { id: 'improved', files: 10, bytes: 100 },
      { id: 'worsened', files: 10, bytes: 100 },
      { id: 'unchanged', files: 10, bytes: 100 },
      { id: 'resolved', files: 10, bytes: 100 }
    ]);
    const current = indexedOrganization([
      { id: 'improved', files: 9, bytes: 200 },
      { id: 'worsened', files: 10, bytes: 101 },
      { id: 'unchanged', files: 10, bytes: 100 },
      { id: 'new', files: 2, bytes: 20 }
    ]);

    const result = insights.compareOrganization(current, previous);

    expect(result).toMatchObject({
      status: 'compared',
      counts: { new: 1, improved: 1, worsened: 1, unchanged: 1, resolved: 1 },
      totals: {
        current: 4,
        previous: 4,
        union: 5,
        currentAccountedFor: 4,
        previousAccountedFor: 4
      },
      changesTruncated: false
    });
    expect(result.topChanges).toHaveLength(4);
    expect(result.topChanges.every(item => item.filesystemMutationAllowed === false)).toBe(true);
    expect(result.note).toMatch(/aggregate indexed-evidence changes only/i);
    expect(result.note).toMatch(/file count is compared first, then bytes/i);
  });

  test('does not call a candidate resolved merely because it is absent from the top work list', () => {
    const candidates = Array.from({ length: 13 }, (_, index) => ({
      id: `candidate-${String(index).padStart(2, '0')}`,
      files: 20 - index,
      bytes: 100 + index
    }));
    const previous = indexedOrganization(candidates, { workItems: candidates.slice(0, 12) });
    const current = indexedOrganization(candidates, { workItems: candidates.slice(1, 13) });

    const result = insights.compareOrganization(current, previous);

    expect(result.counts).toEqual({ new: 0, improved: 0, worsened: 0, unchanged: 13, resolved: 0 });
    expect(result.topChanges).toEqual([]);
    expect(result.totals.currentAccountedFor).toBe(13);
  });

  test('bounds detailed changes deterministically while conserving the full index', () => {
    const previous = indexedOrganization([]);
    const current = indexedOrganization(Array.from(
      { length: insights.MAX_ORGANIZATION_CHANGES + 5 },
      (_, index) => ({ id: `new-${index}`, files: index + 1, bytes: index + 2 })
    ));

    const first = insights.compareOrganization(current, previous);
    const second = insights.compareOrganization(current, previous);

    expect(second).toEqual(first);
    expect(first.topChanges).toHaveLength(insights.MAX_ORGANIZATION_CHANGES);
    expect(first.changesTruncated).toBe(true);
    expect(first.counts.new).toBe(insights.MAX_ORGANIZATION_CHANGES + 5);
    expect(first.totals).toMatchObject({
      current: insights.MAX_ORGANIZATION_CHANGES + 5,
      previous: 0,
      union: insights.MAX_ORGANIZATION_CHANGES + 5,
      currentAccountedFor: insights.MAX_ORGANIZATION_CHANGES + 5,
      previousAccountedFor: 0
    });
  });
});
