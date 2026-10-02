'use strict';

const { ObjectId } = require('mongodb');

const SCANNERS = 'storage_scanners';
const SCANS = 'nas_scans';
const ACTIVE_WINDOW_MS = 90_000;
const MAX_HASH_FILES = 20_000;
const MAX_HASH_BYTES = 250 * 1024 * 1024 * 1024;
const MAX_METADATA_PROBE_PATHS = 1_000;

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
  await db.collection(SCANNERS).updateOne(
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

async function enqueueScan(db, input = {}) {
  const registry = sourceRegistry();
  const source = String(input.source || '').trim();
  const sourceConfig = registry[source];
  if (!sourceConfig?.canonicalRoot) return { ok: false, error: `unknown storage source: ${source}` };
  if (!(await hasActiveSource(db, source))) {
    return { ok: false, unavailable: true, error: `no active storage agent for source: ${source}` };
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
  return { ok: true, scan: doc };
}

async function claimNextScan(db, scannerId, sources = []) {
  const accepted = sources.filter(source => sourceRegistry()[source]);
  if (accepted.length === 0) return null;
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
  return result?.value || result || null;
}

module.exports = {
  SCANNERS,
  ACTIVE_WINDOW_MS,
  MAX_HASH_FILES,
  MAX_HASH_BYTES,
  MAX_METADATA_PROBE_PATHS,
  sourceRegistry,
  listMetadataProbePaths,
  registerScanner,
  listScanners,
  hasActiveSource,
  enqueueScan,
  claimNextScan
};
