/**
 * Policy-gated shared-drive strategy reports.
 *
 * This module reads only indexed AgentX evidence (`nas_files` / `nas_scans`).
 * It never touches shared-drive paths. Reports may contain review proposals,
 * but no proposal is an executable action and every proposal requires the
 * existing, separate profile approval gate.
 */
const dedupScanner = require('./dedupScanner');
const candidateHasher = require('./candidateHasher');
const janitorPolicyDecisionSupport = require('./janitorPolicyDecisionSupport');
const janitorStrategyInsights = require('./janitorStrategyInsights');
const { ObjectId } = require('mongodb');

const POLICY_COLLECTION = 'janitor_shared_drive_policies';
const REPORT_COLLECTION = 'janitor_strategy_reports';
const REPORT_DETAIL_COLLECTION = 'janitor_strategy_report_details';
const REPORT_DETAIL_SCHEMA_VERSION = 1;
const REPORT_DETAIL_MAX_GROUPS = 100;
const REPORT_DETAIL_MAX_BYTES = 4 * 1024 * 1024;
const POLICY_ID = 'shared-drive';
const SHARED_ROOTS = Object.freeze(['/mnt/media', '/mnt/datalake']);

const POLICY_CHOICES = Object.freeze({
  duplicateSurvivor: Object.freeze(['canonical_active', 'newest', 'oldest']),
  backupRetention: Object.freeze(['immutable_archive', 'disaster_recovery', 'staging']),
  generatedCache: Object.freeze(['preserve', 'review_rebuildable'])
});

const DECISION_DEFINITIONS = Object.freeze([
  Object.freeze({
    field: 'duplicateSurvivor',
    question: 'Which copy should survive inside a current SHA-256 duplicate group?',
    choices: POLICY_CHOICES.duplicateSurvivor
  }),
  Object.freeze({
    field: 'backupRetention',
    question: 'Are backup-like trees immutable archives, disaster-recovery retention, or staging?',
    choices: POLICY_CHOICES.backupRetention
  }),
  Object.freeze({
    field: 'generatedCache',
    question: 'Should generated caches be preserved or admitted to rebuildable review proposals?',
    choices: POLICY_CHOICES.generatedCache
  })
]);

function defaultPolicy() {
  return {
    version: 1,
    duplicateSurvivor: null,
    backupRetention: null,
    generatedCache: null,
    // The user-level goal already fixes this invariant. There is deliberately
    // no automatic-execution choice in the policy schema.
    maintenanceAuthorization: 'explicit_per_action'
  };
}

function publicPolicy(doc) {
  const policy = defaultPolicy();
  for (const key of Object.keys(policy)) {
    if (doc && Object.prototype.hasOwnProperty.call(doc, key)) policy[key] = doc[key];
  }
  if (doc?.updatedAt) policy.updatedAt = doc.updatedAt;
  if (doc?.updatedBy) policy.updatedBy = doc.updatedBy;
  return policy;
}

function validatePolicy(input, { partial = true } = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['policy must be an object'] };
  }

  const allowed = new Set([
    'version', 'duplicateSurvivor', 'backupRetention', 'generatedCache',
    'maintenanceAuthorization'
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push(`unknown policy field: ${key}`);
  }

  if (input.version !== undefined && input.version !== 1) {
    errors.push('version must be 1');
  }
  for (const [field, choices] of Object.entries(POLICY_CHOICES)) {
    const value = input[field];
    if (value !== undefined && value !== null && !choices.includes(value)) {
      errors.push(`${field} must be one of: ${choices.join(', ')}`);
    }
    if (!partial && (value === undefined || value === null)) {
      errors.push(`${field} is required`);
    }
  }
  if (
    input.maintenanceAuthorization !== undefined
    && input.maintenanceAuthorization !== 'explicit_per_action'
  ) {
    errors.push('maintenanceAuthorization must be explicit_per_action');
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function decisionsRequired(policy) {
  return DECISION_DEFINITIONS
    .filter(decision => policy?.[decision.field] == null)
    .map(decision => ({
      field: decision.field,
      question: decision.question,
      choices: [...decision.choices]
    }));
}

async function getPolicy(db) {
  const stored = await db.collection(POLICY_COLLECTION).findOne({ _id: POLICY_ID });
  return publicPolicy(stored);
}

async function savePolicy(db, input, { updatedBy = 'operator' } = {}) {
  const validation = validatePolicy(input, { partial: true });
  if (!validation.ok) return validation;

  const current = await getPolicy(db);
  const next = publicPolicy({ ...current, ...input });
  // publicPolicy carries updatedAt/updatedBy metadata from the stored doc;
  // exclude it before whitelist validation or every post-first-write update
  // fails with "unknown policy field: updatedAt/updatedBy".
  const { updatedAt: _metaAt, updatedBy: _metaBy, ...validatableNext } = next;
  const completeValidation = validatePolicy(validatableNext, { partial: true });
  if (!completeValidation.ok) return completeValidation;

  const updatedAt = new Date();
  const persisted = { ...next, updatedAt, updatedBy: String(updatedBy || 'operator').slice(0, 120) };
  delete persisted._id;
  await db.collection(POLICY_COLLECTION).updateOne(
    { _id: POLICY_ID },
    { $set: persisted },
    { upsert: true }
  );
  return {
    ok: true,
    policy: publicPolicy(persisted),
    decisions_required: decisionsRequired(persisted)
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function timestampIso(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function missingExtensionContentKnownMatch() {
  return {
    extension_status: 'missing_unresolved',
    content_probe_status: 'matched',
    content_type_source: 'content-signature'
  };
}

function missingExtensionContentUnknownMatch() {
  return {
    extension_status: 'missing_unresolved',
    $or: [
      { content_probe_status: { $ne: 'matched' } },
      { content_type_source: { $ne: 'content-signature' } }
    ]
  };
}

async function collectRootMetadata(files, scans, root, knownLatestHashingScan = undefined) {
  const scope = { path: { $regex: `^${escapeRegex(root)}(?:[\\/]|$)` } };
  const [facets, latestScan, latestHashingScan] = await Promise.all([
    files.aggregate([
      { $match: scope },
      {
        $facet: {
          summary: [{
            $group: {
              _id: null,
              totalFiles: { $sum: 1 },
              totalBytes: { $sum: '$size' },
              unclassifiedFiles: {
                $sum: { $cond: [{ $eq: ['$category', 'unclassified'] }, 1, 0] }
              },
              extensionlessByDesignFiles: {
                $sum: { $cond: [{ $eq: ['$extension_status', 'extensionless_by_design'] }, 1, 0] }
              },
              missingExtensionUnresolvedFiles: {
                $sum: { $cond: [{ $eq: ['$extension_status', 'missing_unresolved'] }, 1, 0] }
              },
              missingExtensionUnresolvedBytes: {
                $sum: { $cond: [{ $eq: ['$extension_status', 'missing_unresolved'] }, '$size', 0] }
              },
              missingExtensionContentKnownFiles: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$extension_status', 'missing_unresolved'] },
                        { $eq: ['$content_probe_status', 'matched'] },
                        { $eq: ['$content_type_source', 'content-signature'] }
                      ]
                    },
                    1,
                    0
                  ]
                }
              },
              missingExtensionContentKnownBytes: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$extension_status', 'missing_unresolved'] },
                        { $eq: ['$content_probe_status', 'matched'] },
                        { $eq: ['$content_type_source', 'content-signature'] }
                      ]
                    },
                    '$size',
                    0
                  ]
                }
              },
              missingExtensionContentUnknownFiles: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$extension_status', 'missing_unresolved'] },
                        {
                          $not: [{
                            $and: [
                              { $eq: ['$content_probe_status', 'matched'] },
                              { $eq: ['$content_type_source', 'content-signature'] }
                            ]
                          }]
                        }
                      ]
                    },
                    1,
                    0
                  ]
                }
              },
              missingExtensionContentUnknownBytes: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$extension_status', 'missing_unresolved'] },
                        {
                          $not: [{
                            $and: [
                              { $eq: ['$content_probe_status', 'matched'] },
                              { $eq: ['$content_type_source', 'content-signature'] }
                            ]
                          }]
                        }
                      ]
                    },
                    '$size',
                    0
                  ]
                }
              },
              timestampReviewFiles: {
                $sum: {
                  $cond: [
                    { $in: ['$timestamp_quality', ['legacy_or_suspect', 'future_suspect']] },
                    1,
                    0
                  ]
                }
              }
            }
          }],
          storageRoles: [
            { $group: { _id: { $ifNull: ['$storage_role', 'not_assessed'] }, files: { $sum: 1 }, bytes: { $sum: '$size' } } },
            { $sort: { files: -1, _id: 1 } },
            { $limit: 20 }
          ],
          unclassifiedByExtension: [
            {
              $match: {
                category: 'unclassified',
                extension_status: { $ne: 'extensionless_by_design' }
              }
            },
            { $group: { _id: { $ifNull: ['$ext', ''] }, files: { $sum: 1 }, bytes: { $sum: '$size' } } },
            { $sort: { bytes: -1, files: -1, _id: 1 } },
            { $limit: janitorStrategyInsights.HOTSPOT_LIMIT }
          ],
          unclassifiedByTopLevel: [
            {
              $match: {
                category: 'unclassified',
                extension_status: { $ne: 'extensionless_by_design' }
              }
            },
            { $group: { _id: { $ifNull: ['$top_level', ''] }, files: { $sum: 1 }, bytes: { $sum: '$size' } } },
            { $sort: { bytes: -1, files: -1, _id: 1 } },
            { $limit: janitorStrategyInsights.HOTSPOT_LIMIT }
          ],
          unresolvedByTopLevel: [
            { $match: { extension_status: 'missing_unresolved' } },
            { $group: { _id: { $ifNull: ['$top_level', ''] }, files: { $sum: 1 }, bytes: { $sum: '$size' } } },
            { $sort: { files: -1, bytes: -1, _id: 1 } },
            { $limit: janitorStrategyInsights.HOTSPOT_LIMIT }
          ],
          contentKnownMissingByTopLevel: [
            { $match: missingExtensionContentKnownMatch() },
            { $group: { _id: { $ifNull: ['$top_level', ''] }, files: { $sum: 1 }, bytes: { $sum: '$size' } } },
            { $sort: { files: -1, bytes: -1, _id: 1 } },
            { $limit: janitorStrategyInsights.HOTSPOT_LIMIT }
          ],
          contentUnknownMissingByTopLevel: [
            { $match: missingExtensionContentUnknownMatch() },
            { $group: { _id: { $ifNull: ['$top_level', ''] }, files: { $sum: 1 }, bytes: { $sum: '$size' } } },
            { $sort: { files: -1, bytes: -1, _id: 1 } },
            { $limit: janitorStrategyInsights.HOTSPOT_LIMIT }
          ],
          timestampByTopLevel: [
            { $match: { timestamp_quality: { $in: ['legacy_or_suspect', 'future_suspect'] } } },
            { $group: { _id: { $ifNull: ['$top_level', ''] }, files: { $sum: 1 }, bytes: { $sum: '$size' } } },
            { $sort: { files: -1, bytes: -1, _id: 1 } },
            { $limit: janitorStrategyInsights.HOTSPOT_LIMIT }
          ],
          timestampByQuality: [
            { $match: { timestamp_quality: { $in: ['legacy_or_suspect', 'future_suspect'] } } },
            {
              $group: {
                _id: '$timestamp_quality',
                files: { $sum: 1 },
                bytes: { $sum: '$size' },
                minMtime: { $min: '$mtime' },
                maxMtime: { $max: '$mtime' }
              }
            },
            { $sort: { files: -1, _id: 1 } }
          ],
          timestampDominantByTopLevel: [
            { $match: { timestamp_quality: { $in: ['legacy_or_suspect', 'future_suspect'] } } },
            {
              $group: {
                _id: {
                  topLevel: { $ifNull: ['$top_level', ''] },
                  timestampQuality: '$timestamp_quality',
                  mtime: '$mtime',
                  storageRole: { $ifNull: ['$storage_role', 'not_assessed'] }
                },
                files: { $sum: 1 },
                bytes: { $sum: '$size' }
              }
            },
            { $sort: { files: -1, bytes: -1, '_id.mtime': 1 } },
            {
              $group: {
                _id: '$_id.topLevel',
                cluster: {
                  $first: {
                    timestampQuality: '$_id.timestampQuality',
                    mtime: '$_id.mtime',
                    storageRole: '$_id.storageRole',
                    files: '$files',
                    bytes: '$bytes'
                  }
                }
              }
            },
            { $sort: { 'cluster.files': -1, 'cluster.bytes': -1, _id: 1 } },
            { $limit: janitorStrategyInsights.HOTSPOT_LIMIT }
          ]
        }
      }
    ], { allowDiskUse: true }).toArray(),
    scans.findOne({ 'config.roots': root }, { sort: { started_at: -1 } }),
    knownLatestHashingScan === undefined
      ? scans.findOne(
        {
          'config.roots': root,
          status: 'complete',
          'config.hash_mode': { $in: ['all', 'candidates'] }
        },
        { sort: { started_at: -1 } }
      )
      : Promise.resolve(knownLatestHashingScan)
  ]);

  const facet = facets[0] || {};
  const summary = {
    totalFiles: 0,
    totalBytes: 0,
    unclassifiedFiles: 0,
    extensionlessByDesignFiles: 0,
    missingExtensionUnresolvedFiles: 0,
    missingExtensionUnresolvedBytes: 0,
    missingExtensionContentKnownFiles: 0,
    missingExtensionContentKnownBytes: 0,
    missingExtensionContentUnknownFiles: 0,
    missingExtensionContentUnknownBytes: 0,
    timestampReviewFiles: 0,
    ...(facet.summary?.[0] || {})
  };
  const timestampQualityRows = new Map(
    (facet.timestampByQuality || []).map(row => [String(row._id || ''), row])
  );
  const dominantTimestampByTopLevel = new Map(
    (facet.timestampDominantByTopLevel || []).map(row => [String(row._id || ''), row.cluster])
  );
  return {
    root,
    ...summary,
    storageRoles: (facet.storageRoles || []).map(row => ({
      role: row._id,
      files: row.files,
      bytes: row.bytes
    })),
    unclassifiedByExtension: (facet.unclassifiedByExtension || []).map(row => ({
      extension: row._id || '',
      files: row.files,
      bytes: row.bytes
    })),
    unclassifiedByTopLevel: (facet.unclassifiedByTopLevel || []).map(row => ({
      topLevel: row._id || '',
      files: row.files,
      bytes: row.bytes
    })),
    unresolvedByTopLevel: (facet.unresolvedByTopLevel || []).map(row => ({
      topLevel: row._id || '',
      files: row.files,
      bytes: row.bytes
    })),
    contentKnownMissingByTopLevel: (facet.contentKnownMissingByTopLevel || []).map(row => ({
      topLevel: row._id || '',
      files: row.files,
      bytes: row.bytes
    })),
    contentUnknownMissingByTopLevel: (facet.contentUnknownMissingByTopLevel || []).map(row => ({
      topLevel: row._id || '',
      files: row.files,
      bytes: row.bytes
    })),
    timestampQualityTotals: ['legacy_or_suspect', 'future_suspect'].map(timestampQuality => {
      const row = timestampQualityRows.get(timestampQuality) || {};
      return {
        timestampQuality,
        files: Number(row.files || 0),
        bytes: Number(row.bytes || 0),
        minMtime: row.minMtime == null ? null : Number(row.minMtime),
        maxMtime: row.maxMtime == null ? null : Number(row.maxMtime),
        minMtimeUtc: timestampIso(row.minMtime),
        maxMtimeUtc: timestampIso(row.maxMtime)
      };
    }),
    timestampByTopLevel: (facet.timestampByTopLevel || []).map(row => {
      const topLevel = row._id || '';
      const cluster = dominantTimestampByTopLevel.get(topLevel);
      const clusterFiles = Number(cluster?.files || 0);
      return {
        topLevel,
        files: row.files,
        bytes: row.bytes,
        dominantRepeatedTimestamp: clusterFiles > 1 ? {
          timestampQuality: cluster.timestampQuality,
          mtimeSeconds: Number(cluster.mtime),
          mtimeUtc: timestampIso(cluster.mtime),
          storageRole: cluster.storageRole,
          files: clusterFiles,
          bytes: Number(cluster.bytes || 0),
          shareOfAreaFiles: Number((clusterFiles / Math.max(1, Number(row.files || 0))).toFixed(6))
        } : null
      };
    }),
    latestScan: latestScan ? {
      id: latestScan._id,
      status: latestScan.status,
      startedAt: latestScan.started_at,
      finishedAt: latestScan.finished_at
    } : null,
    latestHashingScan: latestHashingScan ? {
      id: latestHashingScan._id,
      status: latestHashingScan.status,
      startedAt: latestHashingScan.started_at,
      finishedAt: latestHashingScan.finished_at,
      hashMaxFiles: latestHashingScan.config?.hash_max_files || null,
      hashMaxBytes: Number(latestHashingScan.config?.hash_max_bytes) || null,
      hashedFiles: Math.max(0, Number(latestHashingScan.counts?.hashed || 0)),
      hashedBytes: Math.max(0, Number(latestHashingScan.counts?.hash_bytes || 0)),
      durationSeconds: latestHashingScan.started_at && latestHashingScan.finished_at
        ? Math.max(0, (new Date(latestHashingScan.finished_at) - new Date(latestHashingScan.started_at)) / 1000)
        : null
    } : null
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

const { roles: pathRoles } = require('../utils/fileMetadataRoles');
const CACHE_SEGMENTS = /(?:^|[\\/])(?:library|packagecache|node_modules|\.venv|__pycache__|cache)(?:[\\/]|$)/i;

function fileContext(file) {
  const value = String(file?.path || '');
  return {
    backup: file?.storageRole === 'backup_copy' || pathRoles().BACKUP_DIR.test(value),
    generatedCache: file?.storageRole === 'generated_cache' || CACHE_SEGMENTS.test(value)
  };
}

function comparePath(a, b) {
  return String(a.path || '').localeCompare(String(b.path || ''), 'en', { sensitivity: 'base' });
}

function canonicalScore(file) {
  const context = fileContext(file);
  const normalized = String(file.path || '').replace(/\\/g, '/');
  return [
    context.backup ? 1 : 0,
    context.generatedCache ? 1 : 0,
    normalized.split('/').filter(Boolean).length,
    normalized.length,
    normalized.toLowerCase()
  ];
}

function compareScore(a, b) {
  for (let idx = 0; idx < a.length; idx += 1) {
    if (a[idx] < b[idx]) return -1;
    if (a[idx] > b[idx]) return 1;
  }
  return 0;
}

function selectSurvivor(files, rule) {
  const sorted = [...files];
  if (rule === 'newest') {
    sorted.sort((a, b) => (Number(b.mtime || 0) - Number(a.mtime || 0)) || comparePath(a, b));
  } else if (rule === 'oldest') {
    sorted.sort((a, b) => (Number(a.mtime || 0) - Number(b.mtime || 0)) || comparePath(a, b));
  } else {
    sorted.sort((a, b) => compareScore(canonicalScore(a), canonicalScore(b)) || comparePath(a, b));
  }
  return sorted[0] || null;
}

function buildDuplicatePlan(groups, policy) {
  const missing = decisionsRequired(policy);
  if (missing.length) {
    return {
      status: 'awaiting_policy',
      decisions_required: missing,
      proposals: [],
      omitted: { backupPolicy: 0, generatedCachePolicy: 0 }
    };
  }

  const proposals = [];
  const omitted = { backupPolicy: 0, generatedCachePolicy: 0 };
  for (const group of groups || []) {
    const members = (group.files || []).filter(file => file?.path);
    if (members.length < 2) continue;
    const contexts = members.map(fileContext);
    if (
      contexts.some(context => context.backup)
      && policy.backupRetention !== 'staging'
    ) {
      omitted.backupPolicy += 1;
      continue;
    }
    if (
      contexts.some(context => context.generatedCache)
      && policy.generatedCache === 'preserve'
    ) {
      omitted.generatedCachePolicy += 1;
      continue;
    }

    const keep = selectSurvivor(members, policy.duplicateSurvivor);
    const remove = members.filter(file => file.path !== keep.path).sort(comparePath);
    if (!remove.length) continue;
    const size = Number(group.size ?? group.file_size ?? 0);
    proposals.push({
      type: 'verified_duplicate_review',
      policy: 'delete_duplicates',
      sha256: group._id || group.hash,
      evidence: 'sha256-current-metadata',
      survivorRule: policy.duplicateSurvivor,
      keep: { path: keep.path, mtime: keep.mtime ?? null },
      candidatesToRemove: remove.map(file => ({ path: file.path, mtime: file.mtime ?? null })),
      files: remove.map(file => file.path),
      reason: `Current SHA-256 duplicate of ${keep.path}; survivor rule ${policy.duplicateSurvivor}`,
      space_saved: size * remove.length,
      approval_required: true,
      execution_authorized: false,
      status: 'pending_review',
      executed_at: null,
      result: null
    });
  }

  return { status: 'ready_for_review', decisions_required: [], proposals, omitted };
}

function buildStrategy(policy, evidence, generatedAt = new Date(), previousReport = null) {
  const duplicatePlan = buildDuplicatePlan(evidence.duplicateGroups, policy);
  const groups = evidence.duplicateGroups || [];
  const provenSavingsBytes = groups.reduce(
    (sum, group) => sum + Number(group.size ?? group.file_size ?? 0) * Math.max(0, Number(group.count || group.files?.length || 0) - 1),
    0
  );
  const verifiedDuplicateFiles = groups.reduce(
    (sum, group) => sum + Number(group.count || group.files?.length || 0),
    0
  );
  const metadata = evidence.roots || [];
  const verifiedDuplicateEvidence = groups.map(group => {
    const size = Number(group.size ?? group.file_size ?? 0);
    const count = Number(group.count || group.files?.length || 0);
    return {
      sha256: group._id || group.hash,
      proof: 'sha256-current-metadata',
      size,
      count,
      provenSavingsBytes: size * Math.max(0, count - 1),
      files: (group.files || []).map(file => ({
        path: file.path,
        mtime: file.mtime ?? null,
        storageRole: file.storageRole || null
      }))
    };
  });

  const report = {
    strategySchemaVersion: 6,
    generatedAt,
    status: duplicatePlan.status,
    mode: 'read-only-strategy',
    scope: {
      canonicalRoots: [...SHARED_ROOTS],
      mediaContainsDatalakePhysically: true,
      mediaIndexExcludesNestedDatalake: true,
      portfolioTotalsDoubleCountDatalake: false
    },
    policy: publicPolicy(policy),
    decisions_required: duplicatePlan.decisions_required,
    policyDecisionSupport: janitorPolicyDecisionSupport.buildPolicyDecisionSupport(groups, {
      fileContext,
      selectSurvivor,
      policyChoices: POLICY_CHOICES
    }),
    evidence: {
      duplicateProof: 'sha256-current-metadata',
      verifiedDuplicatesAreLowerBound: true,
      candidateBytesAreNotSavings: true,
      verifiedDuplicateGroups: groups.length,
      verifiedDuplicateFiles,
      provenSavingsBytes,
      verifiedDuplicateEvidence,
      duplicateCandidates: evidence.duplicateCandidates || {
        evidence: 'same-size-not-fully-hashed',
        candidateBytesAreNotSavings: true,
        groups: 0,
        files: 0,
        candidateBytes: 0,
        filesToHash: 0,
        bytesToHash: 0
      },
      metadataFirst: evidence.metadataFirst || metadataFirstEvidence(metadata),
      verificationQueue: evidence.verificationQueue
        || verificationQueueEvidence(evidence.duplicateCandidates || {}),
      verificationOutlook: evidence.verificationOutlook || {
        status: 'unavailable',
        evidence: 'current-indexed-candidate-backlog-and-latest-successful-hashing-cycle',
        filesToHash: Math.max(0, Number(evidence.duplicateCandidates?.filesToHash || 0)),
        bytesToHash: Math.max(0, Number(evidence.duplicateCandidates?.bytesToHash || 0)),
        latestCompletedCycle: null,
        configuredCapacity: null,
        note: 'Verification pace is unavailable; unavailable does not mean no backlog.'
      },
      oversizedUnhashedCandidates: publicOversizedUnhashedEvidence(
        evidence.oversizedUnhashedCandidates
      ),
      hashingLimits: metadata.map(root => ({
        root: root.root,
        hashMaxBytes: root.latestHashingScan?.hashMaxBytes || null,
        note: root.latestHashingScan?.hashMaxBytes
          ? `An individual unhashed file larger than ${root.latestHashingScan.hashMaxBytes} bytes cannot be proven duplicate by that run.`
          : 'No hashing byte ceiling is recorded; duplicate evidence remains incomplete.'
      })),
      perRoot: metadata
    },
    organizationRecommendations: [
      {
        type: 'backup_semantics',
        disposition: policy.backupRetention || 'decision_required',
        note: 'Backup-like trees are never treated as disposable merely because their paths look old or redundant.'
      },
      {
        type: 'generated_cache',
        disposition: policy.generatedCache || 'decision_required',
        note: 'Generated-cache classification is advisory until its explicit policy is selected.'
      },
      {
        type: 'nested_scope',
        disposition: 'canonical_namespaces',
        note: 'Media excludes its physical Datalake child; /mnt/datalake is counted independently exactly once.'
      }
    ],
    metadataRecommendations: metadata.map(root => ({
      root: root.root,
      unclassifiedFiles: Number(root.unclassifiedFiles || 0),
      missingExtensionUnresolvedFiles: Number(root.missingExtensionUnresolvedFiles || 0),
      missingExtensionUnresolvedBytes: Number(root.missingExtensionUnresolvedBytes || 0),
      missingExtensionContentKnownFiles: Number(root.missingExtensionContentKnownFiles || 0),
      missingExtensionContentKnownBytes: Number(root.missingExtensionContentKnownBytes || 0),
      missingExtensionContentUnknownFiles: Number(root.missingExtensionContentUnknownFiles || 0),
      missingExtensionContentUnknownBytes: Number(root.missingExtensionContentUnknownBytes || 0),
      timestampReviewFiles: Number(root.timestampReviewFiles || 0),
      note: 'Content-known means matched content-signature evidence only. Missing extensions may be intentional; metadata and timestamp signals never authorize renames, moves, or deletion.'
    })),
    organizationStrategy: janitorStrategyInsights.buildOrganizationStrategy(evidence),
    maintenance: {
      authorization: 'explicit_per_action',
      approvalRequired: true,
      executionEndpointCalled: false,
      executableActions: [],
      proposals: duplicatePlan.proposals,
      omittedGroups: duplicatePlan.omitted
    },
    safety: {
      sharedDriveMutations: 0,
      approvalEndpointsCalled: false,
      deleteMoveArchiveExecuted: false
    }
  };
  report.comparison = janitorStrategyInsights.buildComparison(report, previousReport);
  return report;
}

async function generateStrategy(db, { persist = true } = {}) {
  const [policy, evidence, previousReport] = await Promise.all([
    getPolicy(db),
    collectEvidence(db),
    getLatestStrategy(db)
  ]);
  const report = buildStrategy(policy, evidence, new Date(), previousReport);
  if (!persist) return { report };
  const insertedId = await persistStrategyReport(db, report);
  return { report: { ...report, _id: insertedId } };
}

async function getLatestStrategy(db) {
  const report = await db.collection(REPORT_COLLECTION).findOne({}, { sort: { generatedAt: -1 } });
  return hydrateStrategyReport(db, report);
}

function chunkVerifiedEvidence(reportId, groups = []) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      reportId,
      schemaVersion: REPORT_DETAIL_SCHEMA_VERSION,
      ordinal: chunks.length,
      groups: current
    });
    current = [];
    currentBytes = 0;
  };

  for (const group of groups) {
    const groupBytes = Buffer.byteLength(JSON.stringify(group), 'utf8');
    if (current.length && (
      current.length >= REPORT_DETAIL_MAX_GROUPS
      || currentBytes + groupBytes > REPORT_DETAIL_MAX_BYTES
    )) flush();
    current.push(group);
    currentBytes += groupBytes;
  }
  flush();
  return chunks;
}

async function persistStrategyReport(db, report) {
  const reportId = new ObjectId();
  const verifiedEvidence = Array.isArray(report?.evidence?.verifiedDuplicateEvidence)
    ? report.evidence.verifiedDuplicateEvidence
    : [];
  const detailDocs = chunkVerifiedEvidence(reportId, verifiedEvidence);
  const persistedReport = {
    ...report,
    _id: reportId,
    evidence: {
      ...report.evidence,
      verifiedDuplicateEvidence: []
    },
    maintenance: {
      ...report.maintenance,
      proposals: []
    },
    detailStorage: {
      schemaVersion: REPORT_DETAIL_SCHEMA_VERSION,
      collection: REPORT_DETAIL_COLLECTION,
      chunks: detailDocs.length,
      verifiedDuplicateGroups: verifiedEvidence.length,
      proposalsHydratedFrom: 'verifiedDuplicateEvidence'
    }
  };

  try {
    if (detailDocs.length) {
      await db.collection(REPORT_DETAIL_COLLECTION).insertMany(detailDocs, { ordered: true });
    }
    await db.collection(REPORT_COLLECTION).insertOne(persistedReport);
    return reportId;
  } catch (error) {
    if (detailDocs.length) {
      await db.collection(REPORT_DETAIL_COLLECTION).deleteMany({ reportId }).catch(() => {});
    }
    throw error;
  }
}

async function hydrateStrategyReport(db, report) {
  if (!report || report.detailStorage?.schemaVersion !== REPORT_DETAIL_SCHEMA_VERSION) {
    return report;
  }

  const expectedChunks = Math.max(0, Number(report.detailStorage.chunks || 0));
  let detailDocs = [];
  if (expectedChunks > 0) {
    detailDocs = await db.collection(REPORT_DETAIL_COLLECTION)
      .find({ reportId: report._id })
      .sort({ ordinal: 1 })
      .toArray();
  }
  if (detailDocs.length !== expectedChunks) {
    throw new Error(
      `Janitor strategy detail evidence is incomplete: expected ${expectedChunks} chunks, found ${detailDocs.length}`
    );
  }

  const verifiedDuplicateEvidence = detailDocs.flatMap(doc => Array.isArray(doc.groups) ? doc.groups : []);
  const expectedGroups = Math.max(0, Number(report.detailStorage.verifiedDuplicateGroups || 0));
  if (verifiedDuplicateEvidence.length !== expectedGroups) {
    throw new Error(
      `Janitor strategy duplicate evidence is incomplete: expected ${expectedGroups} groups, found ${verifiedDuplicateEvidence.length}`
    );
  }
  const duplicateGroups = verifiedDuplicateEvidence.map(group => ({
    _id: group.sha256,
    size: group.size,
    count: group.count,
    files: group.files
  }));
  const duplicatePlan = buildDuplicatePlan(duplicateGroups, report.policy || defaultPolicy());

  return {
    ...report,
    evidence: { ...report.evidence, verifiedDuplicateEvidence },
    maintenance: { ...report.maintenance, proposals: duplicatePlan.proposals }
  };
}

module.exports = {
  POLICY_COLLECTION,
  REPORT_COLLECTION,
  REPORT_DETAIL_COLLECTION,
  POLICY_ID,
  SHARED_ROOTS,
  POLICY_CHOICES,
  defaultPolicy,
  publicPolicy,
  validatePolicy,
  decisionsRequired,
  getPolicy,
  savePolicy,
  candidateEvidencePipeline,
  oversizedUnhashedEvidence,
  publicOversizedUnhashedEvidence,
  metadataFirstEvidence,
  verificationQueueEvidence,
  collectEvidence,
  buildVerificationOutlook,
  fileContext,
  selectSurvivor,
  buildDuplicatePlan,
  missingExtensionContentKnownMatch,
  missingExtensionContentUnknownMatch,
  buildStrategy,
  chunkVerifiedEvidence,
  persistStrategyReport,
  hydrateStrategyReport,
  generateStrategy,
  getLatestStrategy
};
