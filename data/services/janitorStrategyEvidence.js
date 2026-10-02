/**
 * Duplicate and candidate evidence for shared-drive strategy reports.
 */
const dedupScanner = require('./dedupScanner');
const candidateHasher = require('./candidateHasher');
const { SHARED_ROOTS } = require('./janitorStrategyPolicy');
const { escapeRegex, collectRootMetadata } = require('./janitorStrategyRootMetadata');

function rootPathMatch(roots = SHARED_ROOTS) {
  return {
    $or: roots.map(root => ({
      path: { $regex: `^${escapeRegex(root)}(?:[\\/]|$)` }
    }))
  };
}

function currentHashExpression() {
  return {
    $and: [
      { $ne: [{ $ifNull: ['$sha256', ''] }, ''] },
      {
        $eq: [
          '$hash_fingerprint',
          { $concat: [{ $toString: '$size' }, ':', { $toString: '$mtime' }] }
        ]
      }
    ]
  };
}

function hashingBudgets(perRoot = []) {
  const budgets = new Map();
  for (const root of SHARED_ROOTS) {
    const row = perRoot.find(item => item?.root === root);
    const value = Number(row?.latestHashingScan?.hashMaxBytes);
    if (!Number.isFinite(value) || value <= 0) return null;
    budgets.set(root, value);
  }
  return budgets;
}

function oversizedUnhashedExpression(budgets) {
  if (!(budgets instanceof Map) || budgets.size !== SHARED_ROOTS.length) {
    return { $literal: false };
  }
  return {
    $and: [
      { $eq: [currentHashExpression(), false] },
      {
        $or: SHARED_ROOTS.map(root => ({
          $and: [
            {
              $regexMatch: {
                input: '$path',
                regex: `^${escapeRegex(root)}(?:[\\/]|$)`
              }
            },
            { $gt: ['$size', budgets.get(root)] }
          ]
        }))
      }
    ]
  };
}

function candidateEvidencePipeline(perRoot = []) {
  const budgets = hashingBudgets(perRoot);
  const oversized = oversizedUnhashedExpression(budgets);
  return [
    { $match: { ...rootPathMatch(), size: { $gt: 0 } } },
    {
      $group: {
        _id: '$size',
        count: { $sum: 1 },
        currentHashed: { $sum: { $cond: [currentHashExpression(), 1, 0] } },
        oversizedUnhashed: { $sum: { $cond: [oversized, 1, 0] } },
        oversizedBytesToHash: { $sum: { $cond: [oversized, '$size', 0] } }
      }
    },
    { $match: { count: { $gt: 1 }, $expr: { $lt: ['$currentHashed', '$count'] } } },
    {
      $facet: {
        totals: [{
          $group: {
            _id: null,
            groups: { $sum: 1 },
            files: { $sum: '$count' },
            candidateBytes: { $sum: { $multiply: ['$_id', { $subtract: ['$count', 1] }] } },
            filesToHash: { $sum: { $subtract: ['$count', '$currentHashed'] } },
            bytesToHash: { $sum: { $multiply: ['$_id', { $subtract: ['$count', '$currentHashed'] }] } }
          }
        }],
        oversized: [
          { $match: { oversizedUnhashed: { $gt: 0 } } },
          {
            $group: {
              _id: null,
              groups: { $sum: 1 },
              files: { $sum: '$oversizedUnhashed' },
              bytesToHash: { $sum: '$oversizedBytesToHash' }
            }
          }
        ]
      }
    }
  ];
}

function oversizedUnhashedEvidence(candidateFacet, perRoot = []) {
  const budgets = hashingBudgets(perRoot);
  if (!budgets) {
    return {
      status: 'unavailable',
      evidence: 'same-size-candidates-above-latest-root-hash-budget',
      groups: null,
      files: null,
      bytesToHash: null,
      bytesAreNotSavings: true,
      fileIdentityIncluded: false,
      filesystemMutationAllowed: false,
      note: 'A usable latest hashing budget is required for both canonical roots; unavailable does not mean zero.'
    };
  }
  const row = candidateFacet?.oversized?.[0] || {};
  return {
    status: 'measured',
    evidence: 'same-size-candidates-above-latest-root-hash-budget',
    groups: Math.max(0, Number(row.groups || 0)),
    files: Math.max(0, Number(row.files || 0)),
    bytesToHash: Math.max(0, Number(row.bytesToHash || 0)),
    bytesAreNotSavings: true,
    fileIdentityIncluded: false,
    filesystemMutationAllowed: false,
    note: 'Counts cover the canonical portfolio, including same-size groups split across Media and Datalake. Bytes-to-hash are not savings.'
  };
}

function publicOversizedUnhashedEvidence(input) {
  const values = [input?.groups, input?.files, input?.bytesToHash];
  const measured = input?.status === 'measured'
    && values.every(value => Number.isFinite(value) && value >= 0);
  if (!measured) return oversizedUnhashedEvidence({}, []);
  return {
    status: 'measured',
    evidence: 'same-size-candidates-above-latest-root-hash-budget',
    groups: values[0],
    files: values[1],
    bytesToHash: values[2],
    bytesAreNotSavings: true,
    fileIdentityIncluded: false,
    filesystemMutationAllowed: false,
    note: 'Counts cover the canonical portfolio, including same-size groups split across Media and Datalake. Bytes-to-hash are not savings.'
  };
}

function metadataFirstEvidence(roots = []) {
  const availableRoots = roots.filter(root => root?.root);
  const measured = availableRoots.length === SHARED_ROOTS.length
    && SHARED_ROOTS.every(root => {
      const row = availableRoots.find(item => item.root === root);
      return row?.latestScan?.status === 'complete'
        && Number.isFinite(Number(row.totalFiles))
        && Number.isFinite(Number(row.totalBytes));
    });
  if (!measured) {
    return {
      status: 'unavailable',
      evidence: 'current-complete-indexed-metadata',
      canonicalRoots: SHARED_ROOTS.length,
      indexedFiles: null,
      indexedBytes: null,
      organizationReviewAvailable: false,
      exactDuplicateProofRequired: true,
      filesystemMutationAllowed: false,
      note: 'A complete current metadata index is required before organization readiness is reported; unavailable does not mean no indexed evidence exists.'
    };
  }
  return {
    status: 'measured',
    evidence: 'current-complete-indexed-metadata',
    canonicalRoots: SHARED_ROOTS.length,
    indexedFiles: availableRoots.reduce((sum, root) => sum + Number(root.totalFiles || 0), 0),
    indexedBytes: availableRoots.reduce((sum, root) => sum + Number(root.totalBytes || 0), 0),
    organizationReviewAvailable: true,
    signals: ['classification', 'extension', 'timestamp', 'storage_role', 'mirror_correlation'],
    exactDuplicateProofRequired: true,
    filesystemMutationAllowed: false,
    note: 'Current indexed metadata supports organization review now. It does not prove duplicates or authorize file changes.'
  };
}

function verificationQueueEvidence(candidates = {}) {
  const values = ['groups', 'files', 'candidateBytes', 'filesToHash', 'bytesToHash']
    .map(key => Number(candidates?.[key]));
  if (values.some(value => !Number.isFinite(value) || value < 0)) {
    return {
      status: 'unavailable',
      evidence: 'same-size-candidates-ranked-by-potential-duplicate-bytes',
      ordering: [...candidateHasher.CANDIDATE_QUEUE_ORDER],
      potentialDuplicateBytesAreNotSavings: true,
      exactDuplicateProofRequired: true,
      filesystemMutationAllowed: false,
      note: 'Current candidate evidence is incomplete; do not infer a verification queue or savings estimate.'
    };
  }
  const [groups, files, candidateBytes, filesToHash, bytesToHash] = values;
  return {
    status: groups > 0 ? 'prioritized' : 'empty',
    evidence: 'same-size-candidates-ranked-by-potential-duplicate-bytes',
    ordering: [...candidateHasher.CANDIDATE_QUEUE_ORDER],
    groups,
    files,
    potentialDuplicateBytes: candidateBytes,
    filesToHash,
    bytesToHash,
    potentialDuplicateBytesAreNotSavings: true,
    exactDuplicateProofRequired: true,
    filesystemMutationAllowed: false,
    note: groups > 0
      ? 'Candidate groups are queued by aggregate potential duplicate bytes, then file size. This prioritizes proof effort; it is not a savings estimate and never authorizes an action.'
      : 'No current same-size candidate groups require SHA-256 verification.'
  };
}

async function collectEvidence(db) {
  const files = db.collection('nas_files');
  const scans = db.collection('nas_scans');
  const latestHashingScans = await Promise.all(SHARED_ROOTS.map(root => scans.findOne(
    {
      'config.roots': root,
      status: 'complete',
      'config.hash_mode': { $in: ['all', 'candidates'] }
    },
    { sort: { started_at: -1 } }
  )));
  const budgetRoots = SHARED_ROOTS.map((root, idx) => ({
    root,
    latestHashingScan: latestHashingScans[idx] ? {
      hashMaxBytes: Number(latestHashingScans[idx].config?.hash_max_bytes) || null
    } : null
  }));
  const [duplicateGroups, candidateRows, ...perRoot] = await Promise.all([
    dedupScanner.aggregateDuplicateGroups(db, {
      rootPaths: SHARED_ROOTS,
      excludeKeys: true,
      includeSizePerFile: true,
      includeContextPerFile: true,
      sizeField: 'size'
    }),
    files.aggregate(candidateEvidencePipeline(budgetRoots), { allowDiskUse: true }).toArray(),
    ...SHARED_ROOTS.map((root, idx) => (
      collectRootMetadata(files, scans, root, latestHashingScans[idx])
    ))
  ]);

  const candidateFacet = candidateRows[0] || {};
  const candidates = candidateFacet.totals?.[0]
    || { groups: 0, files: 0, candidateBytes: 0, filesToHash: 0, bytesToHash: 0 };
  const duplicateCandidates = {
    evidence: 'same-size-not-fully-hashed',
    candidateBytesAreNotSavings: true,
    groups: Math.max(0, Number(candidates.groups || 0)),
    files: Math.max(0, Number(candidates.files || 0)),
    candidateBytes: Math.max(0, Number(candidates.candidateBytes || 0)),
    filesToHash: Math.max(0, Number(candidates.filesToHash || 0)),
    bytesToHash: Math.max(0, Number(candidates.bytesToHash || 0))
  };
  return {
    roots: perRoot,
    duplicateGroups,
    duplicateCandidates,
    metadataFirst: metadataFirstEvidence(perRoot),
    verificationQueue: verificationQueueEvidence(duplicateCandidates),
    verificationOutlook: buildVerificationOutlook(perRoot, duplicateCandidates),
    oversizedUnhashedCandidates: oversizedUnhashedEvidence(candidateFacet, perRoot)
  };
}

function buildVerificationOutlook(roots = [], candidates = {}) {
  const filesToHash = Math.max(0, Number(candidates.filesToHash || 0));
  const bytesToHash = Math.max(0, Number(candidates.bytesToHash || 0));
  const backlogExists = filesToHash > 0 || bytesToHash > 0;
  const scans = SHARED_ROOTS.map(root => roots.find(item => item?.root === root)?.latestHashingScan || null);
  const usable = scans.every(scan => (
    scan?.status === 'complete'
    && Number(scan.hashMaxFiles) > 0
    && Number(scan.hashMaxBytes) > 0
    && Number(scan.hashedFiles) > 0
    && Number(scan.hashedBytes) > 0
    && Number(scan.durationSeconds) > 0
  ));
  if (!usable) {
    return {
      status: 'unavailable',
      evidence: 'current-indexed-candidate-backlog-and-latest-successful-hashing-cycle',
      filesToHash,
      bytesToHash,
      latestCompletedCycle: null,
      configuredCapacity: null,
      note: 'A successful completed hashing scan with positive file and byte limits is required for both canonical roots before verification pace is reported; unavailable does not mean no backlog.'
    };
  }
  const totals = scans.reduce((result, scan) => ({
    hashedFiles: result.hashedFiles + Number(scan.hashedFiles),
    hashedBytes: result.hashedBytes + Number(scan.hashedBytes),
    durationSeconds: result.durationSeconds + Number(scan.durationSeconds),
    maxFiles: result.maxFiles + Number(scan.hashMaxFiles),
    maxBytes: result.maxBytes + Number(scan.hashMaxBytes)
  }), { hashedFiles: 0, hashedBytes: 0, durationSeconds: 0, maxFiles: 0, maxBytes: 0 });
  const comparableBounds = backlogExists
    ? [
      Math.ceil(filesToHash / totals.hashedFiles),
      Math.ceil(bytesToHash / totals.hashedBytes)
    ]
    : [0];
  const configuredBounds = backlogExists
    ? [
      Math.ceil(filesToHash / totals.maxFiles),
      Math.ceil(bytesToHash / totals.maxBytes)
    ]
    : [0];
  return {
    status: 'measured',
    evidence: 'current-indexed-candidate-backlog-and-latest-successful-hashing-cycle',
    filesToHash,
    bytesToHash,
    latestCompletedCycle: {
      canonicalRoots: SHARED_ROOTS.length,
      hashedFiles: totals.hashedFiles,
      hashedBytes: totals.hashedBytes,
      durationSeconds: totals.durationSeconds,
      filesPerSecond: Number((totals.hashedFiles / totals.durationSeconds).toFixed(4)),
      bytesPerSecond: Math.round(totals.hashedBytes / totals.durationSeconds),
      estimatedComparableCyclesLowerBound: Math.max(...comparableBounds)
    },
    configuredCapacity: {
      maxFiles: totals.maxFiles,
      maxBytes: totals.maxBytes,
      estimatedCyclesLowerBound: Math.max(...configuredBounds)
    },
    note: 'Counts cover only not-current members of same-size candidate groups. Throughput aggregates the latest successful scan for each canonical root; comparable-cycle estimates are lower bounds constrained by both files and bytes, never a calendar ETA or reclaimable-space estimate.'
  };
}

module.exports = {
  candidateEvidencePipeline,
  oversizedUnhashedEvidence,
  publicOversizedUnhashedEvidence,
  metadataFirstEvidence,
  verificationQueueEvidence,
  collectEvidence,
  buildVerificationOutlook
};
