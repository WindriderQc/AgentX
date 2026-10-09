'use strict';

/**
 * What happens around a storage scan besides indexing: the repair of scans a
 * restart interrupted, the activity-log entries of a scan's life, and the
 * growth snapshot of a scan that ended `complete`.
 */

const { log } = require('../utils/logger');
const storageAgentService = require('./storageAgentService');
const activityEvents = require('./activityEvents');
const storageTrends = require('./storageTrends');

const RESTART_REASON = 'Data restarted while the scan was running';

// Cleanup stale "running" scans on server restart
async function cleanupStaleScans(db) {
  try {
    const scans = db.collection('nas_scans');
    // An in-container scan cannot survive a restart, whichever phase it was in.
    const interrupted = { status: { $in: ['running', 'hashing'] }, 'config.external': { $ne: true } };
    const now = new Date();
    const result = await scans.updateMany(interrupted, { $set: { status: 'stopped', finished_at: now } });
    if (result.modifiedCount > 0) {
      log(`[Storage] Cleaned up ${result.modifiedCount} stale running scan(s)`);
      try {
        const stopped = await scans.find({ status: 'stopped', finished_at: now, 'config.external': { $ne: true } }).limit(20).toArray();
        for (const scan of stopped) await activityEvents.scanFinished(db, { ...scan, last_error: scan.last_error || RESTART_REASON });
      } catch (_) { /* the log never fails the repair */ }
    }
    const expired = await storageAgentService.expireStaleScans(db);
    if (expired.running + expired.queued > 0) {
      log(`[Storage] Marked ${expired.running} silent and ${expired.queued} unclaimed external scan(s) failed`);
    }
  } catch (error) {
    log(`[Storage] Error cleaning up stale scans: ${error.message}`, 'error');
  }
}

/**
 * A scan reached its final state. `scan` is the scan document as it ends.
 * A growth snapshot is written only for a `complete` scan that covered every
 * file of its roots and rebuilt their directory rollups: `rollupsRebuilt` and
 * `filtered` are how an in-container scan says it did not.
 * Never throws: neither the log nor the snapshot may fail the scan.
 */
async function scanEnded(db, scan, { rollupsRebuilt = true, filtered = false } = {}) {
  await activityEvents.scanFinished(db, scan);
  if (!rollupsRebuilt || filtered || !storageTrends.snapshotEligible(scan)) return [];
  try {
    return await storageTrends.recordSnapshots(db, scan);
  } catch (error) {
    log(`[Storage] Growth snapshot of scan ${scan._id} failed: ${error.message}`, 'warn');
    return [];
  }
}

module.exports = { RESTART_REASON, cleanupStaleScans, scanEnded };
