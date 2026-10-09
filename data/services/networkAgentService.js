/**
 * Network Agent Service — DB logic for agent-fed LAN scanning.
 *
 * The data container can't ARP-discover the real LAN (Docker Desktop / WSL2
 * net), so a native Data collector runs `nmap` where it can see the network and
 * POSTs results here. This module holds the shared device upsert (reused by
 * both the in-container fallback scan AND the agent-ingest path), the on-demand
 * scan-request queue, and the scanner heartbeat registry.
 *
 * Collections (owned by data):
 *   network_devices        — the merged device store (see networkController)
 *   network_scan_requests  — queued on-demand scan jobs the agent polls
 *   network_scanners       — registered scanner agents + last-seen heartbeat
 */
const { ObjectId } = require('mongodb');
const { sanitizeDevice } = require('../utils/networkInput');
const activityEvents = require('./activityEvents');

// A scanner whose heartbeat is within this window is considered "active".
const ACTIVE_WINDOW_MS = 90_000;       // 90s — ~18 missed 5s polls of slack
// A pending request is served to agents for this long after it is enqueued.
const REQUEST_TTL_MS = 120_000;        // 2 minutes
const MAX_PENDING_PER_POLL = 5;        // cap requests handed to one agent at once

const DEVICES = 'network_devices';
const REQUESTS = 'network_scan_requests';
const SCANNERS = 'network_scanners';

/**
 * Upsert discovered devices into network_devices. Shared by the in-container
 * fallback scan and the agent-ingest path. Tags each device with `scanSource`
 * (which scanner/vantage reported it) and stamps `lastScanAt`.
 *
 * Entries that are not a plain IPv4 `ip` with an optional MAC and string
 * hostname/vendor are dropped and counted in `rejected`.
 *
 * `pruneMissing` is scoped to the SAME scanSource so one vantage never marks
 * another vantage's exclusively-seen devices offline. A result with no valid
 * device prunes nothing (`pruneSkipped`): a scanner that sees not even itself
 * has observed nothing, and must not turn its whole inventory offline.
 */
async function applyScanResults(db, devices, { scanSource = 'unknown', pruneMissing = false } = {}) {
  const reported = Array.isArray(devices) ? devices : [];
  const list = reported.map(sanitizeDevice).filter(Boolean);
  const rejected = reported.length - list.length;
  const now = new Date();

  const bulkOps = list.map(device => ({
    updateOne: {
      filter: device.mac ? { mac: device.mac } : { ip: device.ip, mac: { $in: [null, ''] } },
      update: {
        $set: {
          ip: device.ip,
          mac: device.mac,
          hostname: device.hostname,
          vendor: device.vendor,
          status: 'online',
          lastSeen: now,
          scanSource,
          lastScanAt: now
        },
        $setOnInsert: { firstSeen: now, alias: '', notes: '' }
      },
      upsert: true
    }
  }));

  if (bulkOps.length > 0) {
    const written = await db.collection(DEVICES).bulkWrite(bulkOps);
    // An upserted row is a device the inventory did not hold: a later sweep
    // updates it, so a device is announced once.
    const inserted = Object.keys(written?.upsertedIds || {}).map(index => list[Number(index)]).filter(Boolean);
    await activityEvents.devicesFirstSeen(db, inserted, { scanSource });
  }

  let markedOffline = 0;
  const pruneSkipped = pruneMissing === true && list.length === 0;
  if (pruneMissing === true && !pruneSkipped) {
    const discoveredIps = new Set(list.map(d => d.ip));
    // Only prune devices THIS scanner previously reported — never another vantage's.
    const ownOnline = await db.collection(DEVICES)
      .find({ status: 'online', scanSource }).toArray();
    const offlineOps = ownOnline
      .filter(d => !discoveredIps.has(d.ip))
      .map(d => ({ updateOne: { filter: { _id: d._id }, update: { $set: { status: 'offline' } } } }));

    if (offlineOps.length > 0) {
      await db.collection(DEVICES).bulkWrite(offlineOps);
      markedOffline = offlineOps.length;
    }
  }

  const summary = { discovered: list.length, updated: bulkOps.length, markedOffline, rejected };
  if (pruneSkipped) summary.pruneSkipped = 'no valid device reported';
  return summary;
}

/** Upsert a scanner heartbeat. Called on every agent poll and every result post. */
async function registerScanner(db, info = {}) {
  const scannerId = String(info.scannerId || '').trim();
  if (!scannerId) return null;
  const now = new Date();

  const set = { scannerId, lastSeen: now };
  if (info.hostname !== undefined) set.hostname = String(info.hostname || '');
  if (info.ip !== undefined) set.ip = String(info.ip || '');
  if (info.platform !== undefined) set.platform = String(info.platform || '');
  if (info.agentVersion !== undefined) set.agentVersion = String(info.agentVersion || '');
  if (info.cidr !== undefined) set.cidr = String(info.cidr || '');
  if (info.capabilities !== undefined) set.capabilities = info.capabilities;
  if (info.lastScanAt) set.lastScanAt = new Date(info.lastScanAt);

  const result = await db.collection(SCANNERS).updateOne(
    { scannerId },
    { $set: set, $setOnInsert: { firstSeen: now } },
    { upsert: true }
  );
  await activityEvents.collectorSeen(db, 'network', scannerId, {
    inserted: (result?.upsertedCount || 0) > 0, hostname: set.hostname
  });
  return scannerId;
}

function decorateScanner(doc, now = Date.now()) {
  const lastSeenMs = doc.lastSeen ? new Date(doc.lastSeen).getTime() : 0;
  return { ...doc, active: now - lastSeenMs < ACTIVE_WINDOW_MS };
}

/** List all registered scanners with a derived `active` flag. */
async function listScanners(db) {
  const docs = await db.collection(SCANNERS).find({}).sort({ lastSeen: -1 }).toArray();
  const now = Date.now();
  return docs.map(d => decorateScanner(d, now));
}

/** True when at least one scanner heartbeat is within ACTIVE_WINDOW_MS. */
async function hasActiveScanner(db) {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS);
  const doc = await db.collection(SCANNERS).findOne({ lastSeen: { $gt: cutoff } });
  return !!doc;
}

/** Enqueue an on-demand scan request for agents to pick up. Returns the job. */
async function enqueueScanRequest(db, { target, source = 'ui' } = {}) {
  const now = new Date();
  const doc = {
    target,
    status: 'pending',
    source,
    requestedAt: now,
    completedBy: [],
    results: []
  };
  const { insertedId } = await db.collection(REQUESTS).insertOne(doc);
  return { jobId: insertedId.toString(), ...doc, _id: insertedId };
}

/**
 * Pending, still-fresh requests this scanner has not yet completed. No `status`
 * filter — so every active vantage services a request once (two vantage points),
 * while `status` flips to 'done' on first post purely as a UI signal.
 */
async function getPendingRequestsForScanner(db, scannerId) {
  const cutoff = new Date(Date.now() - REQUEST_TTL_MS);
  const docs = await db.collection(REQUESTS)
    .find({ requestedAt: { $gt: cutoff }, completedBy: { $ne: scannerId } })
    .sort({ requestedAt: -1 })
    .limit(MAX_PENDING_PER_POLL)
    .toArray();
  return docs.map(d => ({ requestId: d._id.toString(), target: d.target, requestedAt: d.requestedAt, source: d.source }));
}

/** Record a scanner's completion of a request (complete-on-post). */
async function completeScanRequest(db, requestId, scannerId, summary = {}) {
  let _id;
  try { _id = new ObjectId(requestId); } catch { return null; }
  const now = new Date();
  await db.collection(REQUESTS).updateOne(
    { _id },
    {
      $set: { status: 'done', lastCompletedAt: now },
      $addToSet: { completedBy: scannerId },
      $push: { results: { scannerId, ...summary, at: now } },
      $min: { firstCompletedAt: now }
    }
  );
  return true;
}

/** Fetch one scan request (for UI job-status polling). */
async function getScanRequest(db, id) {
  let _id;
  try { _id = new ObjectId(id); } catch { return null; }
  const doc = await db.collection(REQUESTS).findOne({ _id });
  if (!doc) return null;
  return {
    jobId: doc._id.toString(),
    target: doc.target,
    status: doc.status,
    source: doc.source,
    requestedAt: doc.requestedAt,
    completedBy: doc.completedBy || [],
    results: doc.results || [],
    done: doc.status === 'done'
  };
}

module.exports = {
  ACTIVE_WINDOW_MS,
  REQUEST_TTL_MS,
  applyScanResults,
  registerScanner,
  listScanners,
  hasActiveScanner,
  enqueueScanRequest,
  getPendingRequestsForScanner,
  completeScanRequest,
  getScanRequest
};
