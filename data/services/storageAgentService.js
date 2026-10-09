'use strict';

const { ObjectId } = require('mongodb');
const activityEvents = require('./activityEvents');

const SCANNERS = 'storage_scanners';
const SCANS = 'nas_scans';
const ACTIVE_WINDOW_MS = 90_000;
const MAX_HASH_FILES = 20_000;
const MAX_HASH_BYTES = 250 * 1024 * 1024 * 1024;
const MAX_METADATA_PROBE_PATHS = 1_000;
const ACTIVE_SCAN_STATUSES = Object.freeze(['queued', 'running', 'hashing']);
// The collector heartbeats a running scan every 30 s (60 s at most) and polls
// for queued work every 15 s. The queued bound exceeds the nightly job's 4 h
// wait, since one collector serves its queued scans one after the other.
const RUNNING_STALE_MS = 10 * 60 * 1000;
const QUEUED_STALE_MS = 6 * 60 * 60 * 1000;

const DEFAULT_SOURCES = Object.freeze({
  media: Object.freeze({ canonicalRoot: '/mnt/media', executionCapable: false }),
  datalake: Object.freeze({ canonicalRoot: '/mnt/datalake', executionCapable: false })
});

function boundedNumber(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listMetadataProbePaths(db, root, limit = MAX_METADATA_PROBE_PATHS) {
  const canonicalRoot = String(root || '').replace(/\/+$/, '');
  if (!canonicalRoot) return [];
  const boundedLimit = Math.max(1, Math.min(MAX_METADATA_PROBE_PATHS, Number(limit) || MAX_METADATA_PROBE_PATHS));
  const collection = db.collection('nas_files');
  const rootFilter = { $regex: `^${escapeRegex(canonicalRoot)}(?:/|$)` };
  const queryPaths = async (filter, queryLimit) => {
    const documents = await collection.find({ path: rootFilter, ...filter })
      .sort({ path: 1 })
      .project({ _id: 0, path: 1 }).limit(queryLimit).toArray();
    return documents
      .map(document => String(document?.path || '').trim())
      .filter(path => path === canonicalRoot || path.startsWith(`${canonicalRoot}/`));
  };

  // New unknowns must not be starved by the bounded revalidation queue.
  const unclassified = await queryPaths({ category: 'unclassified' }, boundedLimit);
  if (unclassified.length >= boundedLimit) return unclassified.slice(0, boundedLimit);
  const unresolved = await queryPaths({
    category: { $ne: 'unclassified' },
    extension_status: 'missing_unresolved',
    content_probe_status: { $exists: false }
  }, boundedLimit - unclassified.length);
  if (unclassified.length + unresolved.length >= boundedLimit) {
    return [...new Set([...unclassified, ...unresolved])].slice(0, boundedLimit);
  }
  const revalidated = await queryPaths({
    content_type_source: 'content-signature',
    category: { $ne: 'unclassified' }
  }, boundedLimit - unclassified.length - unresolved.length);
  return [...new Set([...unclassified, ...unresolved, ...revalidated])].slice(0, boundedLimit);
}

function sourceRegistry() {
  if (!process.env.STORAGE_AGENT_SOURCES) return DEFAULT_SOURCES;
  try {
    const parsed = JSON.parse(process.env.STORAGE_AGENT_SOURCES);
    return Object.fromEntries(Object.entries(parsed).map(([id, config]) => [id, {
      canonicalRoot: String(config.canonicalRoot || ''),
      executionCapable: config.executionCapable === true
    }]));
  } catch (_) {
    return DEFAULT_SOURCES;
  }
}

async function registerScanner(db, info = {}) {
  const scannerId = String(info.scannerId || '').trim();
  if (!scannerId) return null;
  const now = new Date();
  const sources = String(info.sources || '').split(',').map(value => value.trim()).filter(Boolean);
  const result = await db.collection(SCANNERS).updateOne(
    { scannerId },
    {
      $set: {
        scannerId,
        hostname: String(info.hostname || ''),
        platform: String(info.platform || ''),
        agentVersion: String(info.agentVersion || ''),
        sources,
        lastSeen: now
      },
      $setOnInsert: { firstSeen: now }
    },
    { upsert: true }
  );
  await activityEvents.collectorSeen(db, 'storage', scannerId, {
    inserted: (result?.upsertedCount || 0) > 0, hostname: String(info.hostname || '')
  });
  return scannerId;
}

async function listScanners(db) {
  const docs = await db.collection(SCANNERS).find({}).sort({ lastSeen: -1 }).toArray();
  const now = Date.now();
  return docs.map(doc => ({
    ...doc,
    active: now - new Date(doc.lastSeen || 0).getTime() < ACTIVE_WINDOW_MS
  }));
}

async function hasActiveSource(db, source) {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS);
  return !!(await db.collection(SCANNERS).findOne({ lastSeen: { $gt: cutoff }, sources: source }));
}

function normalizeRoot(root) {
  return String(root || '').replace(/[\\/]+$/, '');
}

function rootsOverlap(left, right) {
  const a = normalizeRoot(left);
  const b = normalizeRoot(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// A scan that completes removes the rows under its roots that it did not stamp,
// so two scans may never be active on overlapping roots at the same time.
async function findOverlappingScan(db, roots = []) {
  const active = await db.collection(SCANS).find({ status: { $in: ACTIVE_SCAN_STATUSES } }).toArray();
  return active.find(doc => {
    const existing = doc.config?.roots || doc.roots;
    return Array.isArray(existing) && existing.some(root => roots.some(wanted => rootsOverlap(root, wanted)));
  }) || null;
}

// Fails external scans whose collector went silent, and queued scans nobody
// claimed. It only changes the scan record: the index rows are never pruned here.
async function expireStaleScans(db, now = new Date()) {
  const scans = db.collection(SCANS);
  const runningCutoff = new Date(now.getTime() - RUNNING_STALE_MS);
  const queuedCutoff = new Date(now.getTime() - QUEUED_STALE_MS);
  const running = await scans.updateMany(
    {
      status: 'running',
      'config.external': true,
      $nor: [
        { last_heartbeat_at: { $gte: runningCutoff } },
        { last_batch_at: { $gte: runningCutoff } },
        { started_at: { $gte: runningCutoff } }
      ]
    },
    {
      $set: {
        status: 'failed',
        finished_at: now,
        last_error: `No heartbeat or batch from the storage agent for ${RUNNING_STALE_MS / 60000} minutes; scan marked failed, index rows kept`
      }
    }
  );
  const queued = await scans.updateMany(
    { status: 'queued', 'config.external': true, requested_at: { $lt: queuedCutoff } },
    {
      $set: {
        status: 'failed',
        finished_at: now,
        last_error: `No storage agent claimed the scan within ${QUEUED_STALE_MS / 3600000} hours; scan marked failed`
      }
    }
  );
  const expired = { running: running?.modifiedCount || 0, queued: queued?.modifiedCount || 0 };
  if (expired.running + expired.queued > 0) await reportExpiredScans(db, now);
  return expired;
}

// The scans this pass just failed carry its exact `finished_at`.
async function reportExpiredScans(db, now) {
  try {
    const expired = await db.collection(SCANS)
      .find({ status: 'failed', finished_at: now, 'config.external': true }).limit(50).toArray();
    for (const scan of expired) await activityEvents.scanExpired(db, scan);
  } catch (_) { /* the log never fails the reaper */ }
}

async function touchScanHeartbeat(db, scanId) {
  if (typeof scanId !== 'string' || !scanId) return false;
  const result = await db.collection(SCANS).updateOne(
    { _id: scanId, status: 'running', 'config.external': true },
    { $set: { last_heartbeat_at: new Date() } }
  );
  return (result?.matchedCount || 0) > 0;
}

async function enqueueScan(db, input = {}) {
  const registry = sourceRegistry();
  const source = String(input.source || '').trim();
  const sourceConfig = registry[source];
  if (!sourceConfig?.canonicalRoot) return { ok: false, error: `unknown storage source: ${source}` };
  if (!(await hasActiveSource(db, source))) {
    return { ok: false, unavailable: true, error: `no active storage agent for source: ${source}` };
  }

  await expireStaleScans(db);
  const overlapping = await findOverlappingScan(db, [sourceConfig.canonicalRoot]);
  if (overlapping) {
    // The nightly job only needs a scan id to wait on: join the scan already
    // queued or running for this source instead of starting a second one.
    if (overlapping.config?.external === true && overlapping.config.source === source) {
      return { ok: true, coalesced: true, scan: overlapping };
    }
    return {
      ok: false,
      conflict: true,
      error: `scan ${overlapping._id} is already ${overlapping.status} on an overlapping root`
    };
  }

  const scanId = new ObjectId().toHexString();
  const now = new Date();
  const hashMode = ['none', 'all', 'candidates'].includes(input.hashMode) ? input.hashMode : 'candidates';
  const doc = {
    _id: scanId,
    type: 'external-storage-agent',
    status: 'queued',
    requested_at: now,
    started_at: null,
    finished_at: null,
    counts: {},
    config: {
      external: true,
      source,
      roots: [sourceConfig.canonicalRoot],
      execution_capable: sourceConfig.executionCapable,
      hash_mode: hashMode,
      hash_max_files: boundedNumber(input.hashMaxFiles, 5000, MAX_HASH_FILES),
      hash_max_bytes: boundedNumber(input.hashMaxBytes, 50 * 1024 * 1024 * 1024, MAX_HASH_BYTES)
    }
  };
  await db.collection(SCANS).insertOne(doc);
  await activityEvents.scanQueued(db, doc);
  return { ok: true, scan: doc };
}

async function claimNextScan(db, scannerId, sources = []) {
  const accepted = sources.filter(source => sourceRegistry()[source]);
  if (accepted.length === 0) return null;
  await expireStaleScans(db);
  const now = new Date();
  const result = await db.collection(SCANS).findOneAndUpdate(
    {
      status: 'queued',
      type: 'external-storage-agent',
      'config.source': { $in: accepted }
    },
    {
      $set: {
        status: 'running',
        claimed_by: scannerId,
        started_at: now,
        last_heartbeat_at: now
      }
    },
    { sort: { requested_at: 1 }, returnDocument: 'after' }
  );
  const claimed = result?.value || result || null;
  if (claimed) await activityEvents.scanStarted(db, claimed, { scannerId });
  return claimed;
}

module.exports = {
  SCANNERS,
  ACTIVE_WINDOW_MS,
  MAX_HASH_FILES,
  MAX_HASH_BYTES,
  MAX_METADATA_PROBE_PATHS,
  ACTIVE_SCAN_STATUSES,
  RUNNING_STALE_MS,
  QUEUED_STALE_MS,
  sourceRegistry,
  listMetadataProbePaths,
  registerScanner,
  listScanners,
  hasActiveSource,
  findOverlappingScan,
  expireStaleScans,
  touchScanHeartbeat,
  enqueueScan,
  claimNextScan
};
