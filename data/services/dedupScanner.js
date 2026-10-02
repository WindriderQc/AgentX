/**
 * Dedup Scanner — analyzes nas_files for duplicate groups by SHA256 hash,
 * and persists reports to dedup_reports.
 */
const { log } = require('../utils/logger');
const { formatFileSize } = require('../utils/file-operations');

/**
 * Single SHA256-group dedup aggregation engine.
 *
 * This is the ONE place that groups `nas_files` by SHA256 hash and returns the
 * duplicate groups (count > 1). All dedup callers — `buildDedupReport` (report
 * persistence), `fileBrowserController.findDuplicates` (API), and
 * `janitorStrategy` — flow through here so the grouping logic can never drift
 * apart. Each caller passes the options it needs and formats the raw groups into
 * its own response/report shape.
 *
 * @param {import('mongodb').Db} db - MongoDB database handle
 * @param {Object} [opts]
 * @param {string} [opts.rootPath] - only files whose path starts with this root
 * @param {string[]} [opts.rootPaths] - group across these disjoint canonical roots
 * @param {string[]} [opts.extensions] - only include these extensions
 * @param {boolean} [opts.excludeKeys=false] - exclude paths containing `/keys/`
 * @param {boolean} [opts.includeSizePerFile=false] - push `size` onto each file
 * @param {boolean} [opts.includeContextPerFile=false] - push strategy classification fields
 * @param {boolean} [opts.currentHashesOnly=true] - ignore hashes from older metadata fingerprints
 * @param {'size'|'totalSize'} [opts.sizeField='size'] - field name for group size
 * @param {number|null} [opts.limit=null] - cap the number of groups returned
 * @returns {Promise<Array>} raw duplicate groups from the aggregation
 */
async function aggregateDuplicateGroups(db, opts = {}) {
  const {
    rootPath = null,
    rootPaths = null,
    extensions = null,
    excludeKeys = false,
    includeSizePerFile = false,
    includeContextPerFile = false,
    currentHashesOnly = true,
    sizeField = 'size',
    limit = null
  } = opts;

  const files = db.collection('nas_files');
  const matchStage = { sha256: { $exists: true, $ne: null } };

  if (currentHashesOnly) {
    matchStage.$expr = {
      $eq: [
        '$hash_fingerprint',
        { $concat: [{ $toString: '$size' }, ':', { $toString: '$mtime' }] }
      ]
    };
  }

  if (Array.isArray(rootPaths) && rootPaths.length > 0) {
    matchStage.$or = rootPaths.map(root => {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { path: { $regex: `^${escaped}(?:[\\/]|$)` } };
    });
  } else if (rootPath) {
    const escaped = rootPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matchStage.path = { $regex: `^${escaped}(?:[\\/]|$)` };
  }
  if (extensions && extensions.length > 0) {
    matchStage.ext = { $in: extensions.map(e => e.toLowerCase().replace(/^\./, '')) };
  }

  // Exclude protected paths (preserves buildDedupReport's prior behavior)
  if (excludeKeys) {
    if (matchStage.$or) {
      matchStage.$and = [
        { $or: matchStage.$or },
        { path: { $not: /\/keys\// } }
      ];
      delete matchStage.$or;
    } else {
      matchStage.path = matchStage.path || {};
    }
    if (typeof matchStage.path === 'object' && matchStage.path.$regex) {
      // Already has a regex, add exclusion via $and
      delete matchStage.path;
      matchStage.$and = [
        { path: { $regex: `^${rootPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\/]|$)` } },
        { path: { $not: /\/keys\// } }
      ];
    } else {
      matchStage.path = { $not: /\/keys\// };
    }
  }

  const filePush = {
    path: '$path',
    dirname: '$dirname',
    filename: '$filename',
    mtime: '$mtime'
  };
  if (includeSizePerFile) filePush.size = '$size';
  if (includeContextPerFile) filePush.storageRole = '$storage_role';

  const groupStage = {
    _id: '$sha256',
    count: { $sum: 1 },
    files: { $push: filePush }
  };
  groupStage[sizeField] = { $first: '$size' };

  const pipeline = [
    { $match: matchStage },
    { $group: groupStage },
    { $match: { count: { $gt: 1 } } },
    { $sort: { [sizeField]: -1 } }
  ];
  if (limit != null) pipeline.push({ $limit: limit });

  return files.aggregate(pipeline, { allowDiskUse: true }).toArray();
}

/**
 * Build dupe groups from nas_files via the shared dedup aggregation, formatted
 * into a persistable report document.
 * @param {Db} db - MongoDB database handle
 * @param {Object} opts
 * @param {number} [opts.maxDepth] - max directory depth from root (unused filter stored for metadata)
 * @param {string[]} [opts.extensions] - only include these extensions
 * @param {string} [opts.rootPath] - only files under this root path
 * @returns {Promise<Object>} report document ready for persistence
 */
async function buildDedupReport(db, opts = {}) {
  const groups = await aggregateDuplicateGroups(db, {
    rootPath: opts.rootPath,
    extensions: opts.extensions,
    excludeKeys: true,
    includeSizePerFile: true,
    sizeField: 'size'
  });

  const dupeGroups = groups.map(g => ({
    hash: g._id,
    count: g.count,
    file_size: g.size,
    wasted_space: g.size * (g.count - 1),
    files: g.files.map(f => ({
      path: f.path,
      dirname: f.dirname,
      filename: f.filename,
      size: f.size,
      mtime: f.mtime
    })),
    recommended_action: g.count > 1 ? 'review_and_delete_duplicates' : 'none'
  }));

  const totalDupes = dupeGroups.length;
  const totalWasted = dupeGroups.reduce((s, g) => s + g.wasted_space, 0);
  const totalFiles = dupeGroups.reduce((s, g) => s + g.count, 0);
  const top10 = dupeGroups.slice(0, 10);

  const report = {
    created_at: new Date(),
    status: 'complete',
    config: {
      root_path: opts.rootPath || '/mnt/datalake/',
      extensions: opts.extensions || [],
      max_depth: opts.maxDepth || null
    },
    summary: {
      total_duplicate_groups: totalDupes,
      total_duplicate_files: totalFiles,
      total_wasted_space: totalWasted,
      total_wasted_space_formatted: formatFileSize(totalWasted),
      top_10_largest: top10.map(g => ({
        hash: g.hash,
        count: g.count,
        file_size: g.file_size,
        file_size_formatted: formatFileSize(g.file_size),
        wasted_space: g.wasted_space,
        wasted_space_formatted: formatFileSize(g.wasted_space),
        sample_path: g.files[0]?.path || 'unknown'
      }))
    },
    groups: dupeGroups
  };

  return report;
}

/**
 * Persist a dedup report to MongoDB.
 */
async function saveReport(db, report) {
  const col = db.collection('dedup_reports');
  const result = await col.insertOne(report);
  return result.insertedId;
}

/**
 * Get the latest dedup report, or a specific one by ID.
 */
async function getReport(db, reportId) {
  const col = db.collection('dedup_reports');
  if (reportId) {
    const { ObjectId } = require('mongodb');
    // Guard against malformed ids — new ObjectId(bad) throws and would surface
    // as a 500; treat an invalid id as "not found" (→ 404) instead.
    if (!ObjectId.isValid(reportId)) return null;
    return col.findOne({ _id: new ObjectId(reportId) });
  }
  return col.findOne({}, { sort: { created_at: -1 } });
}

module.exports = {
  aggregateDuplicateGroups,
  buildDedupReport,
  saveReport,
  getReport
};
