const decisionSupport = require('../../services/janitorPolicyDecisionSupport');

const policyChoices = {
  duplicateSurvivor: ['canonical_active', 'newest', 'oldest'],
  backupRetention: ['immutable_archive', 'disaster_recovery', 'staging'],
  generatedCache: ['preserve', 'review_rebuildable']
};

function fileContext(file) {
  return { backup: Boolean(file.backup), generatedCache: Boolean(file.generatedCache) };
}

function selectSurvivor(files, rule) {
  return files.find(file => file.selectedFor.includes(rule));
}

function assertNoIdentityKeys(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoIdentityKeys);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    expect(['path', 'hash', 'sha', 'sha256'].some(
      term => normalized === term || normalized.endsWith(term)
    )).toBe(false);
    assertNoIdentityKeys(child);
  }
}

describe('aggregate duplicate-policy decision support', () => {
  test('quantifies policy impact deterministically without exposing identity or choosing policy', () => {
    const groups = [
      {
        _id: 'private-one', size: 10,
        files: [
          {
            path: '/mnt/media/live/a', mtime: 1, storageRole: 'document',
            selectedFor: ['canonical_active', 'oldest']
          },
          {
            path: '/mnt/media/backup/a', mtime: 2, storageRole: 'backup_copy', backup: true,
            selectedFor: ['newest']
          }
        ]
      },
      {
        _id: 'private-two', size: 20,
        files: [
          {
            path: '/mnt/datalake/cache/b', mtime: 1, storageRole: 'generated_cache', generatedCache: true,
            selectedFor: ['oldest']
          },
          {
            path: '/mnt/datalake/live/b', mtime: 3, storageRole: 'document',
            selectedFor: ['canonical_active', 'newest']
          }
        ]
      },
      {
        _id: 'private-three', size: 30,
        files: [
          {
            path: '/mnt/datalake/backup/c', mtime: 4, storageRole: 'backup_copy', backup: true,
            selectedFor: ['newest']
          },
          {
            path: '/mnt/datalake/cache/c', mtime: 4, storageRole: 'generated_cache', generatedCache: true,
            selectedFor: ['canonical_active', 'oldest']
          }
        ]
      },
      {
        _id: 'private-four', size: 40,
        files: [
          {
            path: '/mnt/media/video/d', mtime: 5, storageRole: 'media_asset',
            selectedFor: ['canonical_active', 'newest', 'oldest']
          },
          { path: '/mnt/media/video/d-copy', mtime: 5, storageRole: 'media_asset', selectedFor: [] }
        ]
      }
    ];

    const result = decisionSupport.buildPolicyDecisionSupport(groups, {
      fileContext,
      selectSurvivor,
      policyChoices
    });

    expect(result.basis).toMatchObject({
      verifiedGroups: 4,
      verifiedFiles: 8,
      provenSavingsBytes: 100,
      unverifiedCandidatesExcluded: true,
      candidateBytesIncluded: false
    });
    expect(result.contextMatrix).toEqual({
      backupOnly: { verifiedGroups: 1, provenSavingsBytes: 10 },
      generatedCacheOnly: { verifiedGroups: 1, provenSavingsBytes: 20 },
      both: { verifiedGroups: 1, provenSavingsBytes: 30 },
      neither: { verifiedGroups: 1, provenSavingsBytes: 40 }
    });
    expect(result.backupRetention).toMatchObject({
      verifiedGroups: 2, provenSavingsBytes: 40,
      selectedValue: null, recommendedValue: null
    });
    expect(result.generatedCache).toMatchObject({
      verifiedGroups: 2, provenSavingsBytes: 50,
      selectedValue: null, recommendedValue: null
    });
    expect(result.overlap).toEqual({ verifiedGroups: 1, provenSavingsBytes: 30 });
    expect(result.duplicateSurvivor).toMatchObject({
      groupsWithIdenticalMtime: 2,
      selectionDifferences: {
        canonicalVsNewest: 2,
        canonicalVsOldest: 1,
        newestVsOldest: 3
      },
      maximumGroupsWithDifferentSelection: 3,
      selectedValue: null,
      recommendedValue: null
    });
    expect(result.duplicateSurvivor.choices[0].selectedStorageRoles).toEqual([
      { storageRole: 'document', verifiedGroups: 2 },
      { storageRole: 'generated_cache', verifiedGroups: 1 },
      { storageRole: 'media_asset', verifiedGroups: 1 }
    ]);
    expect(result.backupRetention.choices.every(choice => choice.description)).toBe(true);
    expect(result.generatedCache.choices.every(choice => choice.description)).toBe(true);
    expect(result.safety).toEqual({
      policyPersisted: false,
      proposalsCreated: 0,
      approvalRequested: false,
      executionAuthorized: false,
      sharedDriveMutations: 0
    });
    assertNoIdentityKeys(result);
    const serialized = JSON.stringify(result);
    for (const privateValue of groups.flatMap(group => [group._id, ...group.files.map(file => file.path)])) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  test('requires canonical context and survivor behavior from the caller', () => {
    expect(() => decisionSupport.buildPolicyDecisionSupport([], {}))
      .toThrow(/fileContext and selectSurvivor/);
  });
});
