/**
 * Per-root indexed metadata collection for shared-drive strategy reports.
 */
const janitorStrategyInsights = require('./janitorStrategyInsights');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

module.exports = {
  escapeRegex,
  timestampIso,
  missingExtensionContentKnownMatch,
  missingExtensionContentUnknownMatch,
  collectRootMetadata
};
