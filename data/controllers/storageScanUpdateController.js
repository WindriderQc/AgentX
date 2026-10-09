'use strict';

/**
 * PATCH /storage/scan/:scan_id — a native collector reports progress or the
 * end of its scan. A completion prunes the rows the scan did not see, rebuilds
 * the directory rollups, then hands the final state to the scan lifecycle
 * (activity log, growth snapshot).
 */

const { rebuildDirectoryRollups, pruneStaleFiles, pruneSkippedMessage } = require('../services/scanner');
const { scanEnded } = require('../services/storageScanLifecycle');
const { log } = require('../utils/logger');

const UPDATE_STATUSES = new Set(['running', 'hashing', 'complete', 'completed', 'partial', 'failed', 'stopped']);
const TERMINAL_STATUSES = new Set(['complete', 'partial', 'failed', 'stopped']);

const updateScan = async (req, res) => {
  try {
    const { scan_id } = req.params;
    const { status, stats, completedAt } = req.body || {};
    if (!scan_id) return res.status(400).json({ status: 'error', message: 'Missing scan_id' });

    if (status != null && !(typeof status === 'string' && UPDATE_STATUSES.has(status))) {
      return res.status(400).json({
        status: 'error',
        message: `status must be one of: ${[...UPDATE_STATUSES].join(', ')}`
      });
    }
    let finishedAt = null;
    if (completedAt != null) {
      finishedAt = typeof completedAt === 'string' || typeof completedAt === 'number' ? new Date(completedAt) : null;
      if (!finishedAt || Number.isNaN(finishedAt.getTime())) {
        return res.status(400).json({ status: 'error', message: 'completedAt must be a valid date' });
      }
    }
    if (stats != null && (typeof stats !== 'object' || Array.isArray(stats))) {
      return res.status(400).json({ status: 'error', message: 'stats must be an object' });
    }

    const db = req.app.locals.db;
    const updateFields = {};
    const normalizedStatus = status === 'completed' ? 'complete' : status;

    if (status) updateFields.status = normalizedStatus;
    if (status === 'complete' || status === 'completed' || finishedAt) {
      updateFields.finished_at = finishedAt || new Date();
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
      for (const [key, value] of Object.entries(stats)) {
        if (!allowedStats.includes(key)) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          return res.status(400).json({
            status: 'error',
            message: `stats.${key} must be a finite non-negative number`
          });
        }
        updateFields[`counts.${key}`] = value;
      }
    }

    const scans = db.collection('nas_scans');
    const scanDoc = await scans.findOne({ _id: scan_id });
    if (!scanDoc) return res.status(404).json({ status: 'error', message: `Scan not found: ${scan_id}` });

    const existingStatus = scanDoc.status === 'completed' ? 'complete' : scanDoc.status;
    if (
      scanDoc.config?.external === true &&
      scanDoc.finished_at &&
      TERMINAL_STATUSES.has(normalizedStatus) &&
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

    // A finished external scan (for instance one failed for lack of heartbeat)
    // is not reopened: a late completion must not prune on its behalf.
    if (scanDoc.config?.external === true && TERMINAL_STATUSES.has(existingStatus)) {
      return res.status(409).json({
        status: 'error',
        message: `Scan ${scan_id} already ended as ${existingStatus}`
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

    // Only a collector's scan ends here: an in-container scan reports its own end.
    if (scanDoc.config?.external === true && TERMINAL_STATUSES.has(updateFields.status)) {
      // The document as it now stands, without a second read.
      const finalCounts = { ...(scanDoc.counts || {}) };
      const finalScan = { ...scanDoc, counts: finalCounts };
      for (const [key, value] of Object.entries(updateFields)) {
        if (key.startsWith('counts.')) finalCounts[key.slice('counts.'.length)] = value;
        else finalScan[key] = value;
      }
      if (!finalScan.finished_at) finalScan.finished_at = new Date();
      await scanEnded(req.app.locals.db, finalScan);
    }

    res.json({ status: 'success', message: 'Scan updated', data: { scan_id, updated: updateFields } });
  } catch (error) {
    log(`[Storage] Failed to update scan: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to update scan', error: error.message });
  }
};

module.exports = { updateScan };
