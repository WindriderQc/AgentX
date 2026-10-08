const { Scanner, rebuildDirectoryRollups, pruneStaleFiles, pruneSkippedMessage } = require('../services/scanner');
const { CANDIDATE_QUEUE_ORDER } = require('../services/candidateHasher');
const { ObjectId } = require('mongodb');
const { resolveAllowedPath } = require('../services/janitorService');
const storageAgentService = require('../services/storageAgentService');
const { classifyFileMetadata, normalizeContentType } = require('../utils/fileMetadata');
const { log } = require('../utils/logger');

// Track running scans so they can be stopped
const runningScans = new Map();

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathScope(root) {
  if (!root) return {};
  const normalized = String(root).replace(/[\\/]+$/, '');
  return { path: { $regex: `^${escapeRegex(normalized)}(?:[\\/]|$)` } };
}

function validHashExpression() {
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

// Cleanup stale "running" scans on server restart
async function cleanupStaleScans(db) {
  try {
    const result = await db.collection('nas_scans').updateMany(
      { status: 'running', 'config.external': { $ne: true } },
      { $set: { status: 'stopped', finished_at: new Date() } }
    );
    if (result.modifiedCount > 0) {
      log(`[Storage] Cleaned up ${result.modifiedCount} stale running scan(s)`);
    }
  } catch (error) {
    log(`[Storage] Error cleaning up stale scans: ${error.message}`, 'error');
  }
}

const scan = async (req, res) => {
  try {
    const {
      roots, extensions, exclude_extensions, batch_size, compute_hashes,
      hash_mode, hash_max_size, hash_max_files, hash_max_bytes, hash_min_size
    } = req.body;
    const db = req.app.locals.db;
    const scan_id = new ObjectId().toHexString();
    const requestedRoots = Array.isArray(roots) ? roots : [];

    if (requestedRoots.length === 0) {
      return res.status(400).json({ status: 'error', message: 'roots must be a non-empty array' });
    }

    const requestedHashMode = hash_mode || (compute_hashes === true ? 'all' : 'none');
    if (!['none', 'all', 'candidates'].includes(requestedHashMode)) {
      return res.status(400).json({
        status: 'error',
        message: 'hash_mode must be one of: none, all, candidates'
      });
    }

    const safeRoots = [];
    for (const root of requestedRoots) {
      const safePath = await resolveAllowedPath(root, { mustExist: true, type: 'directory' });
      if (!safePath.ok) {
        return res.status(safePath.reason === 'Blocked by safety policy' ? 403 : 400)
          .json({ status: 'error', message: `Invalid scan root "${root}": ${safePath.reason}` });
      }
      safeRoots.push(safePath.realPath);
    }

    const scanner = new Scanner(db);
    runningScans.set(scan_id, scanner);
    scanner.on('done', () => runningScans.delete(scan_id));

    scanner.run({
      roots: safeRoots,
      includeExt: extensions,
      excludeExt: exclude_extensions,
      batchSize: batch_size || 1000,
      scanId: scan_id,
      computeHashes: compute_hashes === true,
      hashMode: requestedHashMode,
      hashMaxSize: hash_max_size || (requestedHashMode === 'all' ? 100 * 1024 * 1024 : undefined),
      hashMaxFiles: hash_max_files,
      hashMaxBytes: hash_max_bytes,
      hashMinSize: hash_min_size
    }).catch(err => {
      log(`[Storage] Scan ${scan_id} failed: ${err.message}`, 'error');
      runningScans.delete(scan_id);
    });

    res.json({
      status: 'success',
      message: 'Scan started successfully',
      data: {
        scan_id,
        roots: safeRoots,
        extensions,
        exclude_extensions,
        batch_size: batch_size || 1000,
        hash_mode: requestedHashMode
      }
    });
  } catch (error) {
    log(`[Storage] Error starting scan: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to start scan', error: error.message });
  }
};

const getStatus = async (req, res) => {
  try {
    const { scan_id } = req.params;
    if (!scan_id) return res.status(400).json({ status: 'error', message: 'Missing scan_id' });

    const db = req.app.locals.db;
    const scanDoc = await db.collection('nas_scans').findOne({ _id: scan_id });
    if (!scanDoc) return res.status(404).json({ status: 'error', message: `Scan not found: ${scan_id}` });
    res.json({
      status: 'success',
      data: {
        _id: scanDoc._id,
        status: scanDoc.status,
        live: runningScans.has(scan_id) || (scanDoc.config?.external === true && scanDoc.status === 'running'),
        counts: scanDoc.counts,
        config: scanDoc.config || { roots: scanDoc.roots || [], extensions: [], batch_size: null },
        started_at: scanDoc.started_at,
        finished_at: scanDoc.finished_at,
        last_error: scanDoc.last_error
      }
    });
  } catch (error) {
    log(`[Storage] Failed to get scan status: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to retrieve scan status', error: error.message });
  }
};

const listAgents = async (req, res, next) => {
  try {
    const scanners = await storageAgentService.listScanners(req.app.locals.db);
    res.json({
      status: 'success',
      data: {
        scanners,
        active: scanners.filter(scanner => scanner.active).length,
        sources: storageAgentService.sourceRegistry()
      }
    });
  } catch (error) { next(error); }
};

const enqueueAgentScan = async (req, res, next) => {
  try {
    const result = await storageAgentService.enqueueScan(req.app.locals.db, {
      source: req.body?.source,
      hashMode: req.body?.hash_mode,
      hashMaxFiles: req.body?.hash_max_files,
      hashMaxBytes: req.body?.hash_max_bytes
    });
    if (!result.ok) {
      return res.status(result.unavailable ? 503 : 400).json({ status: 'error', message: result.error });
    }
    res.status(202).json({
      status: 'success',
      message: 'Storage scan queued to native agent',
      data: {
        scan_id: result.scan._id,
        source: result.scan.config.source,
        root: result.scan.config.roots[0],
        hash_mode: result.scan.config.hash_mode
      }
    });
  } catch (error) { next(error); }
};

const heartbeatAgent = async (req, res, next) => {
  try {
    const { scannerId, hostname, platform, agentVersion, sources = '' } = req.body || {};
    if (!String(scannerId || '').trim()) {
      return res.status(400).json({ status: 'error', message: 'scannerId body field required' });
    }
    const registeredId = await storageAgentService.registerScanner(req.app.locals.db, {
      scannerId, hostname, platform, agentVersion, sources
    });
    res.json({
      status: 'success',
      data: { scanner_id: registeredId, heartbeat_at: new Date().toISOString() }
    });
  } catch (error) { next(error); }
};

const pollAgentScan = async (req, res, next) => {
  try {
    const { scannerId, hostname, platform, agentVersion, sources = '' } = req.query;
    if (!scannerId) {
      return res.status(400).json({ status: 'error', message: 'scannerId query param required' });
    }
    await storageAgentService.registerScanner(req.app.locals.db, {
      scannerId, hostname, platform, agentVersion, sources
    });
    const acceptedSources = String(sources).split(',').map(value => value.trim()).filter(Boolean);
    const scan = await storageAgentService.claimNextScan(req.app.locals.db, scannerId, acceptedSources);
    const metadataProbePaths = scan
      ? await storageAgentService.listMetadataProbePaths(req.app.locals.db, scan.config.roots[0])
      : [];
    res.json({
      status: 'success',
      data: {
        scan: scan ? {
          scan_id: scan._id,
          source: scan.config.source,
          root: scan.config.roots[0],
          hash_mode: scan.config.hash_mode,
          hash_max_files: scan.config.hash_max_files,
          hash_max_bytes: scan.config.hash_max_bytes,
          metadata_probe_paths: metadataProbePaths
        } : null
      }
    });
  } catch (error) { next(error); }
};

const stopScan = async (req, res) => {
  try {
    const { scan_id } = req.params;
    if (!scan_id) return res.status(400).json({ status: 'error', message: 'Missing scan_id' });

    const scanner = runningScans.get(scan_id);
    if (!scanner) return res.status(404).json({ status: 'error', message: 'Scan not running or already completed' });

    scanner.stop();
    res.json({ status: 'success', message: 'Stop request sent', data: { scan_id } });
  } catch (error) {
    log(`[Storage] Failed to stop scan: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to stop scan', error: error.message });
  }
};

const listScans = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const db = req.app.locals.db;
    const parsedPage = Math.max(1, parseInt(page));
    const parsedLimit = Math.max(1, Math.min(100, parseInt(limit)));
    const skip = (parsedPage - 1) * parsedLimit;

    const col = db.collection('nas_scans');
    const [total, scans] = await Promise.all([
      col.countDocuments(),
      col.find({}).sort({ started_at: -1 }).skip(skip).limit(parsedLimit).toArray()
    ]);

    const scansWithLive = scans.map(scan => {
      const isLive = runningScans.has(scan._id) || (scan.config?.external === true && scan.status === 'running');
      let status = scan.status;
      if (status === 'running' && !isLive && scan.config?.external !== true) status = 'stopped';

      return {
        ...scan, status, live: isLive,
        duration: scan.finished_at && scan.started_at
          ? Math.round((new Date(scan.finished_at) - new Date(scan.started_at)) / 1000) : null
      };
    });

    res.json({
      status: 'success',
      data: {
        scans: scansWithLive,
        pagination: { total, page: parsedPage, limit: parsedLimit, pages: Math.ceil(total / parsedLimit) }
      }
    });
  } catch (error) {
    log(`[Storage] Failed to list scans: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to retrieve scans list', error: error.message });
  }
};

const insertBatch = async (req, res) => {
  try {
    const { scan_id } = req.params;
    const { files, meta } = req.body;

    if (!scan_id) return res.status(400).json({ status: 'error', message: 'Missing scan_id' });
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ status: 'error', message: 'files must be a non-empty array' });
    }

    const db = req.app.locals.db;
    const scanDoc = await db.collection('nas_scans').findOne({ _id: scan_id });
    if (!scanDoc) return res.status(404).json({ status: 'error', message: `Scan not found: ${scan_id}` });

    const filesCollection = db.collection('nas_files');
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);

    for (const [index, file] of files.entries()) {
      if (!file || typeof file.path !== 'string' || file.path.trim() === '') {
        return res.status(400).json({ status: 'error', message: `files[${index}].path must be a non-empty string` });
      }
    }

    const bulkOps = files.map(file => {
      const normalizedPath = file.path.replace(/\/+$/, '').trim();
      const pathParts = normalizedPath?.split('/') || [];
      const filename = pathParts.pop() || '';
      const dirname = pathParts.join('/') || '';
      const dotIdx = filename.lastIndexOf('.');
      const extension = String(file.ext || (dotIdx >= 0 ? filename.slice(dotIdx + 1) : '')).toLowerCase();
      const size = Number(file.size || 0);
      const mtime = Number(file.mtime || 0);
      const contentProbeSource = file.content_probe_source === 'native-magic-v1'
        ? 'native-magic-v1'
        : null;
      const contentType = contentProbeSource ? normalizeContentType(file) : null;
      const sourceRoot = file.source_root || scanDoc.config?.roots?.[0] || '';
      const relativePath = file.relative_path || (sourceRoot && normalizedPath.startsWith(sourceRoot)
        ? normalizedPath.slice(sourceRoot.length).replace(/^\/+/, '')
        : filename);
      const relativeParts = relativePath.split('/').filter(Boolean);
      const classification = classifyFileMetadata({
        path: normalizedPath,
        relativePath,
        extension,
        size,
        mtime,
        content_type: contentType
      }, { nowSeconds });
      const set = {
        path: normalizedPath,
        dirname,
        filename,
        ext: extension,
        extension,
        ...classification,
        size,
        mtime,
        modified: mtime ? new Date(mtime * 1000) : (file.modified ? new Date(file.modified) : now),
        source_root: sourceRoot,
        relative_path: relativePath,
        top_level: relativeParts.length > 1 ? relativeParts[0] : '',
        depth: Math.max(0, relativeParts.length - 1),
        metadata_fingerprint: `${size}:${mtime}`,
        scan_id,
        scan_seen_at: now,
        updated_at: now,
        execution_capable: scanDoc.config?.execution_capable !== false
      };
      const unset = {};
      if (contentProbeSource) {
        set.content_probe_source = contentProbeSource;
        set.content_probe_status = contentType ? 'matched' : 'unmatched';
        set.content_probe_fingerprint = `${size}:${mtime}`;
        set.content_probed_at = now;
        if (contentType) {
          set.content_type = contentType;
          set.content_type_source = 'content-signature';
        } else {
          unset.content_type = '';
          unset.content_type_source = '';
        }
      }
      if (file.sha256) {
        set.sha256 = file.sha256;
        set.hash_fingerprint = `${size}:${mtime}`;
        set.hashed_at = now;
        set.hash_strategy = file.hash_strategy || 'external-agent';
      }

      return {
        updateOne: {
          filter: { path: normalizedPath },
          update: {
            $set: set,
            $setOnInsert: { created_at: now, ingested_at: now },
            ...(Object.keys(unset).length ? { $unset: unset } : {})
          },
          upsert: true
        }
      };
    });

    const result = await filesCollection.bulkWrite(bulkOps, { ordered: false });

    await db.collection('nas_scans').updateOne(
      { _id: scan_id },
      {
        $inc: {
          'counts.files_processed': files.length,
          'counts.inserted': result.upsertedCount || 0,
          'counts.updated': result.modifiedCount || 0
        },
        $set: { last_batch_at: now }
      }
    );

    res.json({
      status: 'success',
      message: `Processed ${files.length} files`,
      data: {
        scan_id,
        batch: { received: files.length, inserted: result.upsertedCount || 0, updated: result.modifiedCount || 0 },
        meta: meta || {}
      }
    });
  } catch (error) {
    log(`[Storage] Failed to insert batch: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to insert file batch', error: error.message });
  }
};

const updateScan = async (req, res) => {
  try {
    const { scan_id } = req.params;
    const { status, stats, completedAt } = req.body;
    if (!scan_id) return res.status(400).json({ status: 'error', message: 'Missing scan_id' });

    const db = req.app.locals.db;
    const updateFields = {};
    const normalizedStatus = status === 'completed' ? 'complete' : status;

    if (status) updateFields.status = normalizedStatus;
    if (status === 'complete' || status === 'completed' || completedAt) {
      updateFields.finished_at = completedAt ? new Date(completedAt) : new Date();
    }
    if (stats) {
      const allowedStats = [
        'files_processed', 'files_seen', 'inserted', 'updated', 'errors', 'skipped',
        'directories', 'hashed', 'hash_bytes', 'candidate_groups',
        'candidate_groups_selected', 'candidate_groups_complete',
        'candidate_groups_partial', 'candidate_groups_deferred',
        'candidate_files_deferred', 'candidate_bytes_deferred',
        'candidate_groups_oversized', 'candidate_files_oversized',
        'candidate_bytes_oversized', 'stale_removed',
        'metadata_errors', 'hash_errors', 'content_probed',
        'content_probe_matched', 'content_probe_errors'
      ];
      Object.entries(stats).forEach(([key, value]) => {
        if (allowedStats.includes(key)) updateFields[`counts.${key}`] = value;
      });
    }

    const scans = db.collection('nas_scans');
    const scanDoc = await scans.findOne({ _id: scan_id });
    if (!scanDoc) return res.status(404).json({ status: 'error', message: `Scan not found: ${scan_id}` });

    const terminalStatuses = new Set(['complete', 'partial', 'failed', 'stopped']);
    const existingStatus = scanDoc.status === 'completed' ? 'complete' : scanDoc.status;
    if (
      scanDoc.config?.external === true &&
      scanDoc.finished_at &&
      terminalStatuses.has(normalizedStatus) &&
      normalizedStatus === existingStatus
    ) {
      return res.json({
        status: 'success',
        message: 'Scan already finalized',
        data: {
          scan_id,
          already_finalized: true,
          updated: { status: existingStatus, finished_at: scanDoc.finished_at }
        }
      });
    }

    if ((status === 'complete' || status === 'completed') && scanDoc.config?.external === true) {
      const files = db.collection('nas_files');
      const pruned = await pruneStaleFiles(files, scanDoc.config.roots || [], scan_id);
      updateFields['counts.stale_removed'] = pruned.removed;
      if (pruned.skippedRoots.length) {
        updateFields.status = 'partial';
        updateFields.last_error = pruneSkippedMessage(pruned.skippedRoots);
      }
      updateFields['counts.directories'] = await rebuildDirectoryRollups(
        files,
        db.collection('nas_directories'),
        scanDoc.config.roots || []
      );
    }

    const result = await scans.updateOne({ _id: scan_id }, { $set: updateFields });
    if (result.matchedCount === 0) return res.status(404).json({ status: 'error', message: `Scan not found: ${scan_id}` });

    res.json({ status: 'success', message: 'Scan updated', data: { scan_id, updated: updateFields } });
  } catch (error) {
    log(`[Storage] Failed to update scan: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to update scan', error: error.message });
  }
};

const getDirectoryCount = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const count = await db.collection('nas_directories').countDocuments();
    res.json({ status: 'success', data: { count } });
  } catch (error) {
    next(error);
  }
};

const getSummary = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const files = db.collection('nas_files');
    const scans = db.collection('nas_scans');
    const root = String(req.query.root || '').trim();
    const scope = pathScope(root);
    const scanScope = root ? { 'config.roots': root.replace(/[\\/]+$/, '') } : {};
    const [lastScan, lastHashingScan] = await Promise.all([
      scans.findOne(scanScope, { sort: { started_at: -1 } }),
      scans.findOne(
        {
          ...scanScope,
          status: 'complete',
          'config.hash_mode': { $in: ['all', 'candidates'] }
        },
        { sort: { started_at: -1 } }
      )
    ]);
    const hashBudgetBytes = Math.max(0, Number(lastHashingScan?.config?.hash_max_bytes || 0));

    const [fileStats, duplicateCount, sizeCandidateFacets] = await Promise.all([
      files.aggregate([{ $match: scope }, {
        $group: {
          _id: null,
          totalFiles: { $sum: 1 },
          totalSize: { $sum: '$size' },
          hashedFiles: { $sum: { $cond: [validHashExpression(), 1, 0] } },
          hashedBytes: { $sum: { $cond: [validHashExpression(), '$size', 0] } },
          categorizedFiles: {
            $sum: {
              $cond: [{
                $and: [
                  { $ne: [{ $ifNull: ['$category', null] }, null] },
                  { $ne: ['$category', ''] },
                  { $ne: ['$category', 'unclassified'] }
                ]
              }, 1, 0]
            }
          }
        }
      }]).toArray(),
      files.aggregate([
        { $match: { ...scope, sha256: { $exists: true, $ne: null }, $expr: validHashExpression() } },
        { $group: { _id: '$sha256', count: { $sum: 1 }, size: { $first: '$size' } } },
        { $match: { count: { $gt: 1 } } },
        { $group: { _id: null, groups: { $sum: 1 }, wasted: { $sum: { $multiply: ['$size', { $subtract: ['$count', 1] }] } } } }
      ]).toArray(),
      files.aggregate([
        { $match: { ...scope, size: { $gt: 0 } } },
        {
          $group: {
            _id: '$size',
            count: { $sum: 1 },
            currentHashed: { $sum: { $cond: [validHashExpression(), 1, 0] } }
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
                bytesToHash: {
                  $sum: { $multiply: ['$_id', { $subtract: ['$count', '$currentHashed'] }] }
                }
              }
            }],
            oversized: [
              { $match: { _id: { $gt: hashBudgetBytes || Number.MAX_SAFE_INTEGER } } },
              {
                $group: {
                  _id: null,
                  groups: { $sum: 1 },
                  files: { $sum: { $subtract: ['$count', '$currentHashed'] } },
                  bytesToHash: {
                    $sum: { $multiply: ['$_id', { $subtract: ['$count', '$currentHashed'] }] }
                  }
                }
              }
            ]
          }
        }
      ], { allowDiskUse: true }).toArray()
    ]);

    const { formatFileSize } = require('../utils/file-operations');
    const stats = fileStats[0] || {
      totalFiles: 0, totalSize: 0, hashedFiles: 0, hashedBytes: 0, categorizedFiles: 0
    };
    const dupes = duplicateCount[0] || { groups: 0, wasted: 0 };
    const candidateFacet = sizeCandidateFacets[0] || {};
    const candidates = candidateFacet.totals?.[0]
      || { groups: 0, files: 0, candidateBytes: 0, filesToHash: 0, bytesToHash: 0 };
    const oversized = candidateFacet.oversized?.[0] || { groups: 0, files: 0, bytesToHash: 0 };

    const filesToHash = Math.max(0, Number(candidates.filesToHash || 0));
    const bytesToHash = Math.max(0, Number(candidates.bytesToHash || 0));
    const configuredMaxFiles = Math.max(0, Number(lastHashingScan?.config?.hash_max_files || 0));
    const lastCounts = lastHashingScan?.counts || {};
    const lastRunHashedFiles = Math.max(0, Number(lastCounts.hashed || 0));
    const lastRunHashedBytes = Math.max(0, Number(lastCounts.hash_bytes || 0));
    const rawDurationSeconds = lastHashingScan?.started_at && lastHashingScan?.finished_at
      ? (new Date(lastHashingScan.finished_at) - new Date(lastHashingScan.started_at)) / 1000
      : null;
    const durationSeconds = Number.isFinite(rawDurationSeconds) && rawDurationSeconds > 0
      ? rawDurationSeconds
      : null;
    const backlogExists = filesToHash > 0 || bytesToHash > 0;
    const actualThroughputMeasured = Boolean(
      lastHashingScan
      && durationSeconds
      && lastRunHashedFiles > 0
      && lastRunHashedBytes > 0
    );
    const configuredCapacityMeasured = Boolean(hashBudgetBytes > 0 && configuredMaxFiles > 0);
    const actualRunBounds = actualThroughputMeasured && backlogExists
      ? [
        Math.ceil(filesToHash / lastRunHashedFiles),
        Math.ceil(bytesToHash / lastRunHashedBytes)
      ]
      : [];
    const configuredRunBounds = configuredCapacityMeasured && backlogExists
      ? [
        Math.ceil(filesToHash / configuredMaxFiles),
        Math.ceil(bytesToHash / hashBudgetBytes)
      ]
      : [];
    const verificationOutlook = {
      status: actualThroughputMeasured && configuredCapacityMeasured ? 'measured' : 'unavailable',
      evidence: 'current-indexed-candidate-backlog-and-latest-successful-hashing-scan',
      filesToHash,
      bytesToHash,
      bytesToHashFormatted: formatFileSize(bytesToHash),
      lastCompletedRun: actualThroughputMeasured ? {
        scanId: lastHashingScan._id,
        hashedFiles: lastRunHashedFiles,
        hashedBytes: lastRunHashedBytes,
        hashedBytesFormatted: formatFileSize(lastRunHashedBytes),
        durationSeconds,
        filesPerSecond: Number((lastRunHashedFiles / durationSeconds).toFixed(4)),
        bytesPerSecond: Math.round(lastRunHashedBytes / durationSeconds),
        estimatedComparableRunsLowerBound: backlogExists ? Math.max(...actualRunBounds) : 0
      } : null,
      configuredCapacity: configuredCapacityMeasured ? {
        maxFiles: configuredMaxFiles,
        maxBytes: hashBudgetBytes,
        maxBytesFormatted: formatFileSize(hashBudgetBytes),
        estimatedRunsLowerBound: backlogExists ? Math.max(...configuredRunBounds) : 0
      } : null,
      note: actualThroughputMeasured && configuredCapacityMeasured
        ? 'Counts cover only not-current members of same-size candidate groups. Comparable-run and configured-capacity estimates are lower bounds constrained by both files and bytes; neither is a calendar ETA or reclaimable-space estimate.'
        : 'A successful completed hashing scan with positive file and byte limits is required before verification pace is reported; unavailable does not mean no backlog.'
    };
    const metadataFirstMeasured = lastScan?.status === 'complete'
      && Number.isFinite(Number(stats.totalFiles))
      && Number.isFinite(Number(stats.totalSize));
    const metadataFirst = {
      status: metadataFirstMeasured ? 'measured' : 'unavailable',
      evidence: 'current-complete-indexed-metadata',
      indexedFiles: metadataFirstMeasured ? Math.max(0, Number(stats.totalFiles || 0)) : null,
      indexedBytes: metadataFirstMeasured ? Math.max(0, Number(stats.totalSize || 0)) : null,
      organizationReviewAvailable: metadataFirstMeasured,
      exactDuplicateProofRequired: true,
      filesystemMutationAllowed: false,
      note: metadataFirstMeasured
        ? 'Current indexed metadata supports organization review now. It does not prove duplicates or authorize file changes.'
        : 'A complete current metadata index is required before organization readiness is reported; unavailable does not mean no indexed evidence exists.'
    };
    const verificationQueue = {
      status: candidates.groups > 0 ? 'prioritized' : 'empty',
      evidence: 'same-size-candidates-ranked-by-potential-duplicate-bytes',
      ordering: [...CANDIDATE_QUEUE_ORDER],
      groups: Math.max(0, Number(candidates.groups || 0)),
      files: Math.max(0, Number(candidates.files || 0)),
      potentialDuplicateBytes: Math.max(0, Number(candidates.candidateBytes || 0)),
      filesToHash,
      bytesToHash,
      potentialDuplicateBytesAreNotSavings: true,
      exactDuplicateProofRequired: true,
      filesystemMutationAllowed: false,
      note: candidates.groups > 0
        ? 'Candidate groups are queued by aggregate potential duplicate bytes, then file size. This prioritizes proof effort; it is not a savings estimate and never authorizes an action.'
        : 'No current same-size candidate groups require SHA-256 verification.'
    };

    res.json({
      status: 'success',
      data: {
        root: root || null,
        totalFiles: stats.totalFiles,
        totalSize: stats.totalSize,
        totalSizeFormatted: formatFileSize(stats.totalSize),
        hashedFiles: stats.hashedFiles,
        hashedBytes: stats.hashedBytes,
        hashCoverageFiles: stats.totalFiles ? stats.hashedFiles / stats.totalFiles : 0,
        hashCoverageBytes: stats.totalSize ? stats.hashedBytes / stats.totalSize : 0,
        categorizedFiles: stats.categorizedFiles,
        metadataCoverageFiles: stats.totalFiles ? stats.categorizedFiles / stats.totalFiles : 0,
        lastScan: lastScan ? {
          id: lastScan._id, status: lastScan.status,
          started_at: lastScan.started_at, finished_at: lastScan.finished_at,
          counts: lastScan.counts,
          hashing: {
            mode: lastScan.config?.hash_mode || 'none',
            maxFiles: lastScan.config?.hash_max_files || null,
            maxBytes: Number(lastScan.config?.hash_max_bytes) || null
          }
        } : null,
        lastHashingScan: lastHashingScan ? {
          id: lastHashingScan._id,
          status: lastHashingScan.status,
          started_at: lastHashingScan.started_at,
          finished_at: lastHashingScan.finished_at,
          counts: lastHashingScan.counts,
          hashing: {
            mode: lastHashingScan.config?.hash_mode,
            maxFiles: lastHashingScan.config?.hash_max_files || null,
            maxBytes: hashBudgetBytes || null
          }
        } : null,
        duplicates: {
          evidence: 'sha256-current-metadata',
          completeness: 'lower-bound',
          groups: dupes.groups,
          potentialSavings: dupes.wasted,
          potentialSavingsFormatted: formatFileSize(dupes.wasted)
        },
        duplicateCandidates: {
          evidence: 'same-size-not-fully-hashed',
          groups: candidates.groups,
          files: candidates.files,
          candidateBytes: candidates.candidateBytes,
          candidateBytesFormatted: formatFileSize(candidates.candidateBytes),
          filesToHash,
          bytesToHash,
          bytesToHashFormatted: formatFileSize(bytesToHash)
        },
        metadataFirst,
        verificationQueue,
        verificationOutlook,
        evidenceLimitations: {
          verifiedDuplicatesAreLowerBound: true,
          candidateBytesAreNotSavings: true,
          progressiveLargeGroups: true,
          hashBudgetSourceScanId: lastHashingScan?._id || null,
          hashBudgetBytes: hashBudgetBytes || null,
          hashBudgetFormatted: hashBudgetBytes ? formatFileSize(hashBudgetBytes) : null,
          oversizedCandidateGroups: oversized.groups,
          oversizedCandidateFiles: oversized.files,
          oversizedBytesToHash: oversized.bytesToHash,
          oversizedBytesToHashFormatted: formatFileSize(oversized.bytesToHash),
          note: hashBudgetBytes
            ? `Groups larger than ${formatFileSize(hashBudgetBytes)} can progress across runs when each file fits; an individual unhashed file larger than that budget remains unverified until the budget is explicitly raised.`
            : 'No hash budget was recorded for the latest scan; duplicate totals remain partial evidence.'
        },
        scope: {
          mediaContainsDatalakePhysically: true,
          mediaIndexExcludesNestedDatalake: true,
          portfolioTotalsDoubleCountDatalake: false,
          note: root === '/mnt/media'
            ? 'The physical Media share contains Datalake, but /mnt/media excludes that top-level child.'
            : root === '/mnt/datalake'
              ? 'Datalake is indexed only in its independent /mnt/datalake namespace.'
              : 'Global totals combine disjoint /mnt/media and /mnt/datalake namespaces; the nested physical Datalake folder is not counted twice.'
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  scan, getStatus, stopScan, listScans,
  getDirectoryCount, insertBatch, updateScan,
  cleanupStaleScans, getSummary,
  listAgents, enqueueAgentScan, heartbeatAgent, pollAgentScan
};
