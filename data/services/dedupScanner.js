/**
 * Dedup Scanner — analyzes nas_files for duplicate groups by SHA256 hash,
 * and persists reports to dedup_reports.
 */
const { ObjectId } = require('mongodb');
const { log } = require('../utils/logger');
const { formatFileSize } = require('../utils/file-operations');

// A report's groups live in chunked detail documents, like the strategy
// reports (janitorStrategyReportStore): one document holding every group and
// file breaks at MongoDB's 16 MB document limit on a large inventory.
const REPORT_COLLECTION = 'dedup_reports';
const REPORT_DETAIL_COLLECTION = 'dedup_report_details';
const REPORT_DETAIL_SCHEMA_VERSION = 1;
const REPORT_DETAIL_MAX_GROUPS = 100;
const REPORT_DETAIL_MAX_BYTES = 4 * 1024 * 1024;
// Groups returned by one getReport call (largest first).
const REPORT_GROUPS_DEFAULT_LIMIT = 100;
const REPORT_GROUPS_MAX_LIMIT = 1000;

function currentFingerprintExpression() {
  return { $eq: [
    '$hash_fingerprint',
    { $concat: [{ $toString: '$size' }, ':', { $toString: '$mtime' }] }
  ] };
}

/** Dated copy evidence, reduced in Mongo, without materializing file lists.
 * A source contributes hash evidence only from its latest complete scan.
 * Cross-source equality does not establish independent disks or a backup.
 */
async function aggregateCopyCoverage(db, sources) {
  if (!sources.length) return [];
  const branches = sources.map(source => ({
    case: { $regexMatch: { input: '$path', regex: `^${source.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\/]|$)` } },
    then: { $literal: source.source }
  }));
  const scanBranches = sources.filter(source => source.scanId != null).map(source => ({
    $and: [{ $eq: ['$_source', { $literal: source.source }] }, { $eq: ['$scan_id', { $literal: source.scanId }] }]
  }));
  const currentScan = scanBranches.length ? { $or: scanBranches } : { $literal: false };
  const scope = [
    { $match: { $or: sources.map(source => ({ path: { $regex: `^${source.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\/]|$)` } })) } },
    { $set: { _source: { $switch: { branches, default: null } } } }
  ];
  const files = db.collection('nas_files');
  const validSize = { $cond: [{ $isNumber: '$size' }, { $and: [
    { $gte: ['$size', 0] }, { $lte: ['$size', Number.MAX_SAFE_INTEGER] },
    { $eq: ['$size', { $trunc: '$size' }] }
  ] }, false] };
  const totals = await files.aggregate([...scope,
    { $group: { _id: '$_source', files: { $sum: 1 }, bytes: { $sum: '$size' },
      invalidSizes: { $sum: { $cond: [validSize, 0, 1] } },
      scanFiles: { $sum: { $cond: [currentScan, 1, 0] } } } }
  ], { maxTimeMS: 2000 }).toArray();
  const covered = sources.filter(source => {
    const row = totals.find(row => row._id === source.source);
    return row && Number.isSafeInteger(source.expectedFiles) && source.expectedFiles > 0
      && row.invalidSizes === 0 && Number.isSafeInteger(row.bytes)
      && row.files === source.expectedFiles && row.scanFiles === row.files;
  }).map(source => source.source);
  const copies = covered.length ? await files.aggregate([...scope,
        { $match: { _source: { $in: covered } } },
        { $match: { sha256: { $regex: /^[0-9a-f]{64}$/ }, size: { $gt: 0 },
          $expr: { $and: [currentFingerprintExpression(), currentScan] } } },
        { $group: { _id: { hash: '$sha256', size: '$size', source: '$_source' }, files: { $sum: 1 } } },
        { $group: { _id: { hash: '$_id.hash', size: '$_id.size' },
          sources: { $push: { source: '$_id.source', files: '$files' } } } },
        { $set: { sourceCount: { $size: '$sources' } } },
        { $unwind: '$sources' },
        { $group: { _id: '$sources.source',
          hashedFiles: { $sum: '$sources.files' },
          hashedBytes: { $sum: { $multiply: ['$_id.size', '$sources.files'] } },
          filesWithOtherSource: { $sum: { $cond: [{ $gt: ['$sourceCount', 1] }, '$sources.files', 0] } },
          bytesWithOtherSource: { $sum: { $cond: [{ $gt: ['$sourceCount', 1] }, { $multiply: ['$_id.size', '$sources.files'] }, 0] } }
        } }
  ], { allowDiskUse: true, maxTimeMS: 3000 }).toArray() : [];
  return sources.map(source => ({ source: source.source,
    files: 0, bytes: 0, invalidSizes: 0, scanFiles: 0, hashedFiles: 0, hashedBytes: 0, filesWithOtherSource: 0, bytesWithOtherSource: 0,
    ...totals.find(row => row._id === source.source), ...copies.find(row => row._id === source.source)
  })).map(({ _id, ...row }) => row);
}

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
 * Zero-byte files are never grouped: they all share one SHA256, so they would
 * form a single giant group, and removing them reclaims no space.
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
  const matchStage = { sha256: { $exists: true, $ne: null }, size: { $gt: 0 } };

  if (currentHashesOnly) {
    matchStage.$expr = currentFingerprintExpression();
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

function chunkGroups(reportId, groups = []) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  let first = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      reportId,
      schemaVersion: REPORT_DETAIL_SCHEMA_VERSION,
      ordinal: chunks.length,
      first,
      last: first + current.length - 1,
      groups: current
    });
    first += current.length;
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

/**
 * Persist a dedup report to MongoDB. The report document keeps its summary;
 * its groups go to chunked detail documents and are read back by getReport.
 */
async function saveReport(db, report) {
  const reportId = new ObjectId();
  const groups = Array.isArray(report?.groups) ? report.groups : [];
  const detailDocs = chunkGroups(reportId, groups);
  const persistedReport = {
    ...report,
    _id: reportId,
    groups: [],
    detailStorage: {
      schemaVersion: REPORT_DETAIL_SCHEMA_VERSION,
      collection: REPORT_DETAIL_COLLECTION,
      chunks: detailDocs.length,
      groups: groups.length
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

function boundedInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

/**
 * Get the latest dedup report, or a specific one by ID, with one page of its
 * groups. `groups_page` says which groups were returned and how many exist.
 * A report saved before chunking still carries its groups inline.
 * @param {Object} [opts]
 * @param {number} [opts.groupOffset=0] - first group to return
 * @param {number} [opts.groupLimit=100] - groups to return, at most 1000
 */
async function getReport(db, reportId, opts = {}) {
  const col = db.collection(REPORT_COLLECTION);
  let report;
  if (reportId) {
    // Guard against malformed ids — new ObjectId(bad) throws and would surface
    // as a 500; treat an invalid id as "not found" (→ 404) instead.
    if (!ObjectId.isValid(reportId)) return null;
    report = await col.findOne({ _id: new ObjectId(reportId) });
  } else {
    report = await col.findOne({}, { sort: { created_at: -1 } });
  }
  if (!report) return report;

  const offset = boundedInt(opts.groupOffset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInt(opts.groupLimit, REPORT_GROUPS_DEFAULT_LIMIT, 1, REPORT_GROUPS_MAX_LIMIT);
  let groups;
  let total;
  if (report.detailStorage?.schemaVersion === REPORT_DETAIL_SCHEMA_VERSION) {
    total = Math.max(0, Number(report.detailStorage.groups || 0));
    const detailDocs = offset < total
      ? await db.collection(REPORT_DETAIL_COLLECTION)
        .find({ reportId: report._id, first: { $lt: offset + limit }, last: { $gte: offset } })
        .sort({ ordinal: 1 })
        .toArray()
      : [];
    groups = detailDocs.flatMap(doc => (Array.isArray(doc.groups) ? doc.groups : [])
      .filter((_group, idx) => doc.first + idx >= offset && doc.first + idx < offset + limit));
    if (groups.length !== Math.max(0, Math.min(limit, total - offset))) {
      throw new Error(
        `Dedup report groups are incomplete: expected ${Math.max(0, Math.min(limit, total - offset))}, found ${groups.length}`
      );
    }
  } else {
    const inline = Array.isArray(report.groups) ? report.groups : [];
    total = inline.length;
    groups = inline.slice(offset, offset + limit);
  }

  return { ...report, groups, groups_page: { offset, limit, returned: groups.length, total } };
}

module.exports = {
  REPORT_DETAIL_COLLECTION,
  REPORT_GROUPS_MAX_LIMIT,
  aggregateDuplicateGroups,
  aggregateCopyCoverage,
  buildDedupReport,
  saveReport,
  getReport
};
