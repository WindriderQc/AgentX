'use strict';

/**
 * A stand-in for Core's workload coordination routes, small enough to read in
 * one pass. It keeps the rules the Benchmark recovery path depends on: a
 * workload is born with a recovery identity, an UNKNOWN transition ends the
 * owner's lease, adoption needs the exact identity and an expired owner, and
 * release needs a RESTORED recovery held by the adopting owner.
 */

const PRINCIPAL = 'benchmark-service';
const BASE = '/api/nerve-center';
const TRANSITIONS = {
  PREPARED: ['MUTATING', 'UNKNOWN'],
  MUTATING: ['UNKNOWN', 'VERIFIED'],
  UNKNOWN: ['VERIFIED'],
  VERIFIED: ['RESTORED'],
  RESTORED: []
};

function refuse(path, reason) {
  return Object.assign(new Error(`Core API 409: ${path} — ${reason}`), { status: 409, body: reason });
}

function createFakeCore() {
  const state = { workloads: [], hostRestoreBlockedBy: null };
  let minted = 0;
  const mint = label => `${label}-${++minted}`;
  const live = date => date && new Date(date).getTime() > Date.now();
  const ownerLive = (item, ownerId) => (item.recoveryOwnerId
    ? item.recoveryOwnerId === (ownerId || null) && live(item.recoveryExpiresAt)
    : live(item.expiresAt));
  const identity = item => ({
    admissionId: item.admissionId, generation: item.generation, principal: item.principal,
    requestId: item.requestId, workloadId: item.workloadId, kind: item.kind, batchId: item.batchId,
    hosts: item.hosts, recoveryRequired: true, recoveryId: item.recoveryId,
    recoveryGeneration: item.recoveryGeneration, recoveryRequestId: item.recoveryRequestId,
    recoveryOwnerId: item.recoveryOwnerId, recoveryState: item.recoveryState,
    recoveryVersion: item.recoveryVersion, recoveryReceipt: item.recoveryReceipt, expiresAt: item.expiresAt
  });

  const routes = [
    ['GET', /^\/runtime-coordination\/active$/, () => ({
      workloads: state.workloads.map(item => ({
        admissionId: item.admissionId, principal: item.principal, workloadId: item.workloadId,
        kind: item.kind, batchId: item.batchId, hosts: item.hosts, recoveryRequired: true,
        expiresAt: item.expiresAt
      })),
      inferences: []
    })],
    ['POST', /^\/workload-admissions$/, (_match, body) => {
      const existing = state.workloads.find(item => item.requestId === body.requestId);
      if (existing && !live(existing.expiresAt)) throw new Error('expired workload requires fenced recovery adoption');
      if (existing) return { acquired: true, ...identity(existing), idempotent: true };
      const item = {
        admissionId: mint('admission'), generation: mint('generation'), principal: PRINCIPAL,
        requestId: body.requestId, workloadId: body.workloadId, kind: body.kind || 'benchmark',
        batchId: body.batchId || null, hosts: body.hosts || [],
        expiresAt: new Date(Date.now() + (body.ttlMs || 60_000)),
        recoveryId: mint('recovery'), recoveryGeneration: mint('recovery-generation'),
        recoveryRequestId: body.recoveryRequestId, recoveryOwnerId: null, recoveryExpiresAt: null,
        recoveryState: 'PREPARED', recoveryVersion: 0, recoveryReceipt: null
      };
      state.workloads.push(item);
      return { acquired: true, ...identity(item) };
    }],
    ['POST', /^\/workload-admissions\/([^/]+)\/recovery$/, (match, body) => {
      const item = state.workloads.find(entry => entry.admissionId === match[1] && entry.generation === body.generation);
      if (!item) throw new Error('lease proof no longer owns coordination state');
      return { armed: true, ...identity(item) };
    }],
    ['POST', /^\/workload-admissions\/([^/]+)\/release-receipt$/, () => ({ recovered: false, released: false })],
    ['POST', /^\/workload-recoveries\/lookup$/, (_match, body) => {
      const item = state.workloads.find(entry => entry.workloadId === body.workloadId);
      if (!item || item.recoveryRequestId !== body.recoveryRequestId) {
        throw new Error('recovery identity no longer owns coordination state');
      }
      if (live(item.expiresAt)) throw new Error('original workload owner remains live');
      return { found: true, ...identity(item) };
    }],
    ['POST', /^\/workload-recoveries\/([^/]+)\/adopt$/, (match, body) => {
      const item = state.workloads.find(entry => entry.recoveryId === match[1]);
      if (!item || item.recoveryRequestId !== body.recoveryRequestId) {
        throw new Error('recovery identity no longer owns coordination state');
      }
      if (item.recoveryOwnerId !== body.ownerId || !live(item.recoveryExpiresAt)) {
        if (live(item.expiresAt)) throw new Error('original workload owner remains live');
        if (item.recoveryOwnerId && live(item.recoveryExpiresAt)) throw new Error('recovery owner lease remains live');
        Object.assign(item, {
          recoveryGeneration: mint('recovery-generation'),
          recoveryOwnerId: body.ownerId,
          recoveryExpiresAt: new Date(Date.now() + 60_000)
        });
      }
      return { adopted: true, ...identity(item) };
    }],
    ['POST', /^\/workload-recoveries\/([^/]+)\/(heartbeat|assert|transition|restore-hosts)$/, (match, body) => {
      const item = state.workloads.find(entry => entry.recoveryId === match[1]);
      if (!item || item.recoveryGeneration !== body.recoveryGeneration || !ownerLive(item, body.ownerId)) {
        throw new Error('recovery proof no longer owns quarantine');
      }
      const receipt = {
        recoveryId: item.recoveryId, recoveryGeneration: item.recoveryGeneration,
        recoveryOwnerId: item.recoveryOwnerId
      };
      if (match[2] === 'heartbeat') return { heartbeat: true, ...receipt };
      if (match[2] === 'assert') return { owned: true, ...receipt, recoveryState: item.recoveryState };
      if (match[2] === 'restore-hosts') {
        if (state.hostRestoreBlockedBy) throw new Error(state.hostRestoreBlockedBy);
        return { restored: true, ...receipt };
      }
      if (item.recoveryVersion !== body.expectedVersion || !TRANSITIONS[item.recoveryState].includes(body.state)) {
        throw new Error(`invalid recovery transition ${item.recoveryState} -> ${body.state}`);
      }
      Object.assign(item, {
        recoveryState: body.state, recoveryVersion: item.recoveryVersion + 1, recoveryReceipt: body.receipt || null
      });
      // Handing the quarantine over ends the owner's lease, as Core does.
      if (body.state === 'UNKNOWN') item.expiresAt = new Date();
      return { transitioned: true, ...receipt, recoveryState: item.recoveryState, recoveryVersion: item.recoveryVersion };
    }],
    ['DELETE', /^\/workload-recoveries\/([^/]+)$/, (match, body) => {
      const item = state.workloads.find(entry => entry.recoveryId === match[1]);
      if (!item || item.recoveryGeneration !== body.recoveryGeneration || !ownerLive(item, body.ownerId)) {
        throw new Error('recovery proof no longer owns quarantine');
      }
      if (item.recoveryState !== 'RESTORED') throw new Error('recovery quarantine is not VERIFIED and RESTORED with a receipt');
      state.workloads.splice(state.workloads.indexOf(item), 1);
      return { released: true, ...identity(item), releasedAt: new Date().toISOString() };
    }]
  ];

  async function coreRequest(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    for (const [routeMethod, pattern, handler] of routes) {
      const match = method === routeMethod && path.startsWith(BASE) && pattern.exec(path.slice(BASE.length));
      if (!match) continue;
      try {
        return { status: 'success', data: handler(match, body) };
      } catch (error) {
        throw refuse(path, error.message);
      }
    }
    throw new Error(`fake Core has no route for ${method} ${path}`);
  }

  return {
    coreRequest,
    workloads: () => state.workloads,
    workload: workloadId => state.workloads.find(item => item.workloadId === String(workloadId)) || null,
    /** The owner process died without a word: its lease simply runs out. */
    expireOwner(workloadId) {
      const item = state.workloads.find(entry => entry.workloadId === String(workloadId));
      Object.assign(item, { expiresAt: new Date(Date.now() - 1_000), recoveryState: 'UNKNOWN' });
    },
    /** A host that cannot be restored yet, e.g. an inference of unknown outcome. */
    blockHostRestore(reason) { state.hostRestoreBlockedBy = reason; },
    reset() { state.workloads.length = 0; state.hostRestoreBlockedBy = null; }
  };
}

module.exports = { createFakeCore };
