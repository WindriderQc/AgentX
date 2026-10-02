'use strict';

const crypto = require('crypto');
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');

// Shared input normalisation, the singleton coordination document and the
// expiry reaper used by every runtime coordination capability.
const MIN_TTL_MS = 15_000;
const MAX_TTL_MS = 30 * 60_000;
const DEFAULT_TTL_MS = 120_000;

function clean(value, max = 160) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : null;
}

function ttlMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.round(parsed)));
}

function secret() {
  return crypto.randomUUID();
}

function canonicalHost(value) {
  const raw = clean(value, 500);
  return raw ? hostUrlKey(raw) : null;
}

function normalizedHosts(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(canonicalHost)
    .filter(Boolean))].sort();
}

async function ensureDocument() {
  try {
    await RuntimeCoordination.updateOne(
      { _id: 'runtime' },
      { $setOnInsert: { maintenance: null, workloads: [], inferences: [], releaseReceipts: [] } },
      { upsert: true }
    );
  } catch (error) {
    // Two first-ever callers can race the singleton upsert. The unique _id is
    // the authority boundary, so the losing E11000 means the document now
    // exists and is safe to read; every other persistence failure is fatal.
    if (error?.code !== 11000) throw error;
  }
}

async function reapExpired(now = new Date()) {
  await ensureDocument();
  // Workloads are born with a durable recovery identity. Expiry therefore
  // means the owner outcome is unknown; it never proves that an external
  // database or Ollama effect stopped. Preserve the admission and force an
  // adopted recovery generation to reconcile it.
  await RuntimeCoordination.updateOne(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        recoveryRequired: true,
        recoveryState: { $in: ['PREPARED', 'MUTATING'] },
        expiresAt: { $lte: now }
      } }
    },
    {
      $set: {
        'workloads.$[entry].recoveryState': 'UNKNOWN',
        'workloads.$[entry].recoveryReceipt': {
          contract: 'agentx.workload-recovery/v1',
          event: 'workload-heartbeat-expired'
        }
      }
    },
    { arrayFilters: [{
      'entry.recoveryRequired': true,
      'entry.recoveryState': { $in: ['PREPARED', 'MUTATING'] },
      'entry.expiresAt': { $lte: now }
    }] }
  );
  // Never infer that an Ollama request terminated merely because its Core
  // process stopped heartbeating. Preserve a non-expiring quarantine so
  // maintenance and exclusive benchmark ownership remain fail-closed.
  await RuntimeCoordination.updateOne(
    { _id: 'runtime', inferences: { $elemMatch: { state: 'ACTIVE', expiresAt: { $lte: now } } } },
    {
      $set: {
        'inferences.$[entry].state': 'UNKNOWN',
        'inferences.$[entry].unknownAt': now
      }
    },
    { arrayFilters: [{ 'entry.state': 'ACTIVE', 'entry.expiresAt': { $lte: now } }] }
  );
  // Maintenance may have dispatched mutations whose server-side lifetime
  // exceeds the caller connection. Expiry is not a terminal receipt: retain a
  // durable quarantine until an authenticated operator verifies or rolls back
  // every side effect.
  await RuntimeCoordination.updateOne(
    {
      _id: 'runtime',
      'maintenance.state': { $in: ['ACTIVE', null] },
      'maintenance.expiresAt': { $lte: now }
    },
    { $set: {
      'maintenance.state': 'UNKNOWN',
      'maintenance.unknownAt': now,
      'maintenance.unknownReason': 'maintenance heartbeat expired without a terminal receipt'
    } }
  );
}

module.exports = {
  clean,
  ttlMs,
  secret,
  canonicalHost,
  normalizedHosts,
  ensureDocument,
  reapExpired
};
