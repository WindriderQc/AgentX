/**
 * Aggregate, read-only decision support for shared-drive janitor policies.
 *
 * The caller supplies the canonical context and survivor functions so this
 * module cannot drift from the proposal planner. File identity is used only
 * in memory to compare selections and is never returned.
 */

const CONTEXT_BUCKETS = Object.freeze([
  'backupOnly',
  'generatedCacheOnly',
  'both',
  'neither'
]);

const CHOICE_DESCRIPTIONS = Object.freeze({
  duplicateSurvivor: Object.freeze({
    canonical_active: 'Prefer a non-backup, non-cache location; use deterministic path tie-breaks.',
    newest: 'Prefer the greatest indexed modification time; use a deterministic path tie-break.',
    oldest: 'Prefer the smallest indexed modification time; use a deterministic path tie-break.'
  }),
  backupRetention: Object.freeze({
    immutable_archive: 'Keep backup-involved groups outside duplicate maintenance proposals.',
    disaster_recovery: 'Retain backup-involved groups under disaster-recovery policy, outside duplicate maintenance proposals.',
    staging: 'Admit backup-involved groups to review proposals after survivor policy is selected; explicit approval still applies.'
  }),
  generatedCache: Object.freeze({
    preserve: 'Keep generated-cache groups outside duplicate maintenance proposals.',
    review_rebuildable: 'Admit generated-cache groups to review as rebuildable; no deletion is automatic.'
  })
});

function emptyMetric() {
  return { verifiedGroups: 0, provenSavingsBytes: 0 };
}

function contextBucket(contexts) {
  const backup = contexts.some(context => context.backup);
  const generatedCache = contexts.some(context => context.generatedCache);
  if (backup && generatedCache) return 'both';
  if (backup) return 'backupOnly';
  if (generatedCache) return 'generatedCacheOnly';
  return 'neither';
}

function choiceList(field, policyChoices) {
  return (policyChoices?.[field] || []).map(value => ({
    value,
    description: CHOICE_DESCRIPTIONS[field]?.[value]
      || 'Operator-defined policy choice; consult the policy contract before selecting.'
  }));
}

function sortedRoleCounts(counts) {
  return [...counts.entries()]
    .map(([storageRole, verifiedGroups]) => ({ storageRole, verifiedGroups }))
    .sort((a, b) => b.verifiedGroups - a.verifiedGroups
      || a.storageRole.localeCompare(b.storageRole));
}

function selectedRole(file) {
  return String(file?.storageRole || 'not_assessed');
}

function differenceKey(left, right) {
  const labels = { canonical_active: 'canonical', newest: 'newest', oldest: 'oldest' };
  const leftLabel = labels[left] || String(left);
  const rightLabel = labels[right] || String(right);
  return `${leftLabel}Vs${rightLabel.charAt(0).toUpperCase()}${rightLabel.slice(1)}`;
}

function buildPolicyDecisionSupport(
  groups,
  { fileContext, selectSurvivor, policyChoices } = {}
) {
  if (typeof fileContext !== 'function' || typeof selectSurvivor !== 'function') {
    throw new TypeError('fileContext and selectSurvivor functions are required');
  }

  const contextMatrix = Object.fromEntries(
    CONTEXT_BUCKETS.map(bucket => [bucket, emptyMetric()])
  );
  const survivorRules = policyChoices?.duplicateSurvivor || [];
  const roleCounts = new Map(survivorRules.map(rule => [rule, new Map()]));
  const differenceCounts = new Map();
  for (let left = 0; left < survivorRules.length; left += 1) {
    for (let right = left + 1; right < survivorRules.length; right += 1) {
      differenceCounts.set(differenceKey(survivorRules[left], survivorRules[right]), 0);
    }
  }

  let verifiedGroups = 0;
  let verifiedFiles = 0;
  let provenSavingsBytes = 0;
  let groupsWithIdenticalMtime = 0;

  for (const group of groups || []) {
    const members = (group?.files || []).filter(file => file?.path);
    if (members.length < 2) continue;
    const size = Number(group.size ?? group.file_size ?? 0);
    const savings = size * (members.length - 1);
    const bucket = contextBucket(members.map(fileContext));

    verifiedGroups += 1;
    verifiedFiles += members.length;
    provenSavingsBytes += savings;
    contextMatrix[bucket].verifiedGroups += 1;
    contextMatrix[bucket].provenSavingsBytes += savings;
    if (new Set(members.map(file => Number(file.mtime || 0))).size === 1) {
      groupsWithIdenticalMtime += 1;
    }

    const selected = new Map();
    for (const rule of survivorRules) {
      const survivor = selectSurvivor(members, rule);
      selected.set(rule, String(survivor?.path || ''));
      const role = selectedRole(survivor);
      const counts = roleCounts.get(rule);
      counts.set(role, (counts.get(role) || 0) + 1);
    }
    for (let left = 0; left < survivorRules.length; left += 1) {
      for (let right = left + 1; right < survivorRules.length; right += 1) {
        const key = differenceKey(survivorRules[left], survivorRules[right]);
        if (selected.get(survivorRules[left]) !== selected.get(survivorRules[right])) {
          differenceCounts.set(key, differenceCounts.get(key) + 1);
        }
      }
    }
  }

  const backupAffected = {
    verifiedGroups: contextMatrix.backupOnly.verifiedGroups + contextMatrix.both.verifiedGroups,
    provenSavingsBytes: contextMatrix.backupOnly.provenSavingsBytes
      + contextMatrix.both.provenSavingsBytes
  };
  const cacheAffected = {
    verifiedGroups: contextMatrix.generatedCacheOnly.verifiedGroups
      + contextMatrix.both.verifiedGroups,
    provenSavingsBytes: contextMatrix.generatedCacheOnly.provenSavingsBytes
      + contextMatrix.both.provenSavingsBytes
  };
  const selectionDifferences = Object.fromEntries(differenceCounts);

  return {
    mode: 'aggregate-read-only-decision-support',
    basis: {
      evidence: 'verified-current-sha256-duplicate-groups',
      verifiedDuplicatesAreLowerBound: true,
      verifiedGroups,
      verifiedFiles,
      provenSavingsBytes,
      unverifiedCandidatesExcluded: true,
      candidateBytesIncluded: false
    },
    contextMatrix,
    duplicateSurvivor: {
      choices: choiceList('duplicateSurvivor', policyChoices).map(choice => ({
        ...choice,
        selectedStorageRoles: sortedRoleCounts(roleCounts.get(choice.value) || new Map())
      })),
      groupsWithIdenticalMtime,
      selectionDifferences,
      maximumGroupsWithDifferentSelection: Math.max(0, ...differenceCounts.values()),
      selectedValue: null,
      recommendedValue: null
    },
    backupRetention: {
      ...backupAffected,
      choices: choiceList('backupRetention', policyChoices),
      selectedValue: null,
      recommendedValue: null
    },
    generatedCache: {
      ...cacheAffected,
      choices: choiceList('generatedCache', policyChoices),
      selectedValue: null,
      recommendedValue: null
    },
    overlap: { ...contextMatrix.both },
    safety: {
      policyPersisted: false,
      proposalsCreated: 0,
      approvalRequested: false,
      executionAuthorized: false,
      sharedDriveMutations: 0
    },
    note: (
      'Aggregate preview only; it selects and recommends no policy, authorizes no action, '
      + 'and is not a reclaimable-space plan.'
    )
  };
}

module.exports = { buildPolicyDecisionSupport };
