'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const { resourceTopology, resourcesFor } = require('./runtimePhysicalResources');
const { parseHeavyQueue } = require('./heavyQueueProjectionService');
const { fail, text, hosts, instant, digest, validateRequest } = require('./heavyWorkQueueContract');
const { planId, planRef, batchRequest } = require('../../../shared/benchmarkBatchPlan.cjs');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');

const FILE = '/instance/config/QUEUE.md';
const ACTIVE = ['dispatching', 'running', 'uncertain'];
const TERMINAL = ['completed', 'failed', 'cancelled'];
// Bound the singleton below BSON limits. Refuse explicitly; never discard history.
const MAX_JOBS = 400;
const WC = { w: 1, j: true };

async function legacySnapshot(file = FILE) {
  try {
    const markdown = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(markdown) > 1024 * 1024) throw fail('Legacy queue exceeds the migration budget', 409);
    return { markdown, sha256: crypto.createHash('sha256').update(markdown).digest('hex'), ...parseHeavyQueue(markdown) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function ensure({ file = FILE } = {}) {
  let state = await Queue.findById('heavy-work').lean();
  if (state) return state;
  if (await legacySnapshot(file)) throw fail('Migrate the mounted legacy queue before submitting Core work', 409, 'HEAVY_QUEUE_MIGRATION_REQUIRED');
  try {
    await Queue.updateOne({ _id: 'heavy-work' }, { $setOnInsert: { revision: 0, jobs: [], legacy: null } }, { upsert: true, writeConcern: WC });
  } catch (error) { if (error.code !== 11000) throw error; }
  return Queue.findById('heavy-work').lean();
}
async function mutate(change, options) {
  await ensure(options);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const state = await Queue.findById('heavy-work').lean();
    const result = await change(state);
    if (result.readOnly) return result.value;
    const budget = TERMINAL.includes(result.value?.state) ? 12 : 8;
    if (Buffer.byteLength(JSON.stringify(state.jobs)) > budget * 1024 * 1024) throw fail('Queue storage budget reached; export/archive explicitly', 409, 'HEAVY_QUEUE_FULL');
    const saved = await Queue.updateOne({ _id: 'heavy-work', revision: state.revision },
      { $set: { jobs: state.jobs }, $inc: { revision: 1 } }, { writeConcern: WC });
    if (saved.modifiedCount) return result.value;
  }
  throw fail('Queue changed concurrently; read it before trying again', 409, 'HEAVY_QUEUE_BUSY');
}
function jobIn(state, id, expectedRevision) {
  const job = state.jobs.find(item => item.id === id);
  if (!job) throw fail('Queue request not found', 404);
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || job.revision !== expectedRevision)) {
    throw fail('Request changed; read its current revision', 409, 'HEAVY_QUEUE_STALE');
  }
  return job;
}
function revision(body) {
  if (!Number.isInteger(body?.expectedRevision) || body.expectedRevision < 0) throw fail('expectedRevision required');
}
function event(job, actor, action, details = null) {
  if (job.events.length >= 100 && !TERMINAL.includes(job.state)) throw fail('Request audit is full; reconcile it before further changes', 409);
  job.revision += 1;
  job.updatedAt = new Date().toISOString();
  job.events.push({ at: job.updatedAt, actor: text(actor, 'actor', 100), action, details });
  return { value: job };
}
function sameResources(a, b) {
  return a.hosts.some(host => b.hosts.includes(host)) || a.resourceIds.some(id => b.resourceIds.includes(id));
}
function runtimeOverlaps(job, item) {
  const endpoints = (item.hosts || [item.host]).filter(Boolean).map(hostUrlKey);
  const physical = [...new Set([...job.resourceIds, ...resourcesFor(resourceTopology(), job.hosts)])];
  return (!endpoints.length && !(item.resourceIds || []).length)
    || endpoints.some(host => job.hosts.includes(host))
    || (item.resourceIds || []).some(id => physical.includes(id));
}
function conflicts(state, proposed, start, end) {
  return state.jobs.filter(job => job.id !== proposed.id && sameResources(job, proposed) && (
    ACTIVE.includes(job.state) || (job.state === 'reserved' && job.reservation.start < end && job.reservation.end > start)
  )).map(job => ({ id: job.id, title: job.title, state: job.state, reservation: job.reservation }));
}
function assertTopology(state, topology) {
  if (state.jobs.some(job => (job.state === 'reserved' || ACTIVE.includes(job.state)) && job.topologyHash !== topology.hash)) {
    throw fail('Resource mapping changed; reconcile existing reservations first', 409, 'HEAVY_QUEUE_TOPOLOGY_CHANGED');
  }
}
async function submit(body, actor, options) {
  const input = validateRequest(body);
  const topology = resourceTopology();
  return mutate(async state => {
    const prior = state.jobs.find(job => job.key === input.key);
    if (prior) {
      if (prior.intentHash !== input.intentHash) throw fail('This key belongs to another request', 409, 'HEAVY_QUEUE_KEY_CONFLICT');
      return { readOnly: true, value: prior };
    }
    const archived = await Archive.findOne({ key: input.key }).lean();
    if (archived) {
      if (archived.job.intentHash !== input.intentHash) throw fail('This key belongs to an archived request', 409, 'HEAVY_QUEUE_KEY_CONFLICT');
      return { readOnly: true, value: { ...archived.job, archived: true } };
    }
    if (state.jobs.length >= MAX_JOBS) throw fail('Queue is full; export/archive it explicitly before adding work', 409, 'HEAVY_QUEUE_FULL');
    const now = new Date().toISOString();
    const job = { id: crypto.randomUUID(), key: input.key, ...input.request, intentHash: input.intentHash,
      resourceIds: resourcesFor(topology, input.request.hosts), topologyHash: topology.hash,
      priority: 5, state: 'requested', revision: 0, reservation: null, operation: null,
      dispatchId: null, createdAt: now, updatedAt: now, events: [] };
    state.jobs.push(job);
    return event(job, actor, 'requested');
  }, options);
}
async function reserve(id, body, actor) {
  revision(body);
  const start = instant(body.start, 'start');
  const priority = body.priority ?? 5;
  if (!Number.isInteger(priority) || priority < 1 || priority > 9) throw fail('priority needs 1 to 9');
  return mutate(state => {
    const job = jobIn(state, id, body.expectedRevision);
    if (!['requested', 'reserved'].includes(job.state)) throw fail('Only unstarted requests can be reserved', 409);
    const topology = resourceTopology();
    assertTopology(state, topology);
    if (!job.hosts.length) throw fail('Legacy request needs explicit hosts and an executor in a new linked request', 409);
    job.resourceIds = resourcesFor(topology, job.hosts); job.topologyHash = topology.hash;
    const end = new Date(Date.parse(start) + job.estimatedMinutes * 60000).toISOString();
    if (Date.parse(end) <= Date.now() || (job.notBefore && start < job.notBefore) || (job.startBefore && start >= job.startBefore)) throw fail('Reservation is outside the permitted start window', 409);
    const collisions = conflicts(state, job, start, end);
    if (collisions.length) throw fail('Heavy-work reservation overlaps another request', 409, 'HEAVY_QUEUE_CONFLICT', { conflicts: collisions });
    job.state = 'reserved'; job.priority = priority; job.reservation = { start, end, estimated: true };
    return event(job, actor, 'reserved', job.reservation);
  });
}
async function begin(id, body, actor) {
  revision(body);
  return mutate(state => {
    const job = jobIn(state, id, body.expectedRevision);
    if (job.state !== 'reserved' || !job.executor) throw fail('A reserved request with a supported executor is required', 409);
    const now = new Date().toISOString();
    if (now < job.reservation.start || now >= job.reservation.end || (job.startBefore && now >= job.startBefore)) throw fail('Execution window is not open', 409, 'HEAVY_QUEUE_WINDOW_CLOSED');
    assertTopology(state, resourceTopology());
    const collisions = conflicts(state, job, now, job.reservation.end);
    if (collisions.length) throw fail('Another request is running, uncertain or reserved here', 409, 'HEAVY_QUEUE_CONFLICT', { conflicts: collisions });
    job.state = 'dispatching'; job.dispatchId = crypto.randomUUID(); job.dispatchedAt = now;
    return event(job, actor, 'dispatching');
  });
}
async function record(id, body, actor) {
  return mutate(state => {
    const job = jobIn(state, id);
    if (!ACTIVE.includes(job.state) || !body.dispatchId || body.dispatchId !== job.dispatchId) throw fail('Exact dispatch identity required', 409);
    if (body.state === 'running') {
      const operation = text(body.operationId, 'operationId', 160);
      if (job.operation && job.operation.id !== operation) throw fail('Dispatch already names another operation', 409);
      if (job.state === 'running' && job.operation?.id === operation) return { readOnly: true, value: job };
      job.operation = { kind: job.kind, id: operation, authority: 'executor-receipt' };
      job.state = 'running';
    } else if (body.state === 'uncertain') {
      if (job.state === 'uncertain' && job.reason === body.reason) return { readOnly: true, value: job };
      job.state = 'uncertain'; job.reason = text(body.reason, 'reason', 1000);
    } else throw fail('Record running or uncertain only; completion requires reconciliation');
    return event(job, actor, job.state, job.operation || job.reason);
  });
}
async function cancel(id, body, actor) {
  revision(body);
  return mutate(state => {
    const job = jobIn(state, id, body.expectedRevision);
    if (!['requested', 'reserved'].includes(job.state)) throw fail('Cancel running work through its executor, then reconcile; its fence stays held', 409);
    job.state = 'cancelled'; job.finishedAt = new Date().toISOString();
    return event(job, actor, 'cancelled');
  });
}
async function assertDispatch(id, dispatchId) {
  const job = await get(id);
  const now = new Date().toISOString();
  if (job.state !== 'dispatching' || job.dispatchId !== dispatchId || now < job.reservation.start
    || now >= job.reservation.end || (job.startBefore && now >= job.startBefore)) {
    throw fail('Dispatch identity or execution window is no longer valid', 409, 'HEAVY_QUEUE_WINDOW_CLOSED');
  }
  const state = await Queue.findById('heavy-work').lean();
  assertTopology(state, resourceTopology());
  return { admitted: true, id, dispatchId, checkedAt: now, runtimeAdmissionRequired: true };
}
async function settle(id, observation, actor) {
  return mutate(state => {
    const job = jobIn(state, id);
    if (TERMINAL.includes(job.state)) return { readOnly: true, value: job };
    if (!job.operation || observation.operationId !== job.operation.id || !TERMINAL.includes(observation.state)) throw fail('Exact terminal executor observation required', 409);
    job.state = observation.state; job.finishedAt = new Date().toISOString(); job.releaseReceipt = observation;
    return event(job, actor, 'reconciled', observation);
  });
}
async function get(id) {
  const state = await Queue.findById('heavy-work').lean();
  if (!state?.jobs?.some(job => job.id === id)) {
    const archived = await Archive.findById(id).lean();
    if (archived) return { ...archived.job, archived: true };
  }
  return jobIn(state || { jobs: [] }, id);
}
async function list() {
  const state = await Queue.findById('heavy-work').lean();
  if (!state) return null;
  const jobs = [...state.jobs].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  return { available: true, authority: 'core.heavy-work-queue', scope: 'planned-heavy-work',
    observedAt: new Date().toISOString(), revision: state.revision, jobs, count: jobs.length,
    archivedCount: await Archive.countDocuments(),
    legacy: state.legacy ? { sha256: state.legacy.sha256, migratedAt: state.legacy.migratedAt, frozen: true } : null };
}
async function archive(actor) {
  return mutate(async state => {
    const terminal = state.jobs.filter(job => TERMINAL.includes(job.state));
    await require('./heavyWorkQueueNotifications').publishJobs(terminal);
    for (const job of terminal) {
      const hash = digest(job);
      try {
        await Archive.updateOne({ _id: job.id }, { $setOnInsert: { key: job.key, digest: hash, job, archivedAt: new Date() } }, { upsert: true, writeConcern: WC });
      } catch (error) { if (error.code !== 11000) throw error; }
      const saved = await Archive.findById(job.id).lean();
      if (saved.digest !== hash) throw fail('Archive identity differs; no queue rows removed', 409);
    }
    state.jobs = state.jobs.filter(job => !TERMINAL.includes(job.state));
    return { readOnly: !terminal.length, value: { archived: terminal.length, actor: text(actor, 'actor', 100) } };
  });
}
// Custom coding checks have an explicit operator attestation, not a native
// executor result. This never runs a command or releases runtime coordination.
async function operatorFinish(id, body, actor) {
  revision(body);
  if (body.confirmation !== 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED'
    || !['completed', 'failed', 'cancelled'].includes(body.state)
    || !/^[a-f0-9]{64}$/.test(body.receiptSha256 || '')) throw fail('Exact operator outcome, receipt hash and release confirmation required');
  return mutate(async state => {
    const job = jobIn(state, id, body.expectedRevision);
    if (job.executor?.mode !== 'operator' || !['diagnostic', 'other'].includes(job.kind)
      || !ACTIVE.includes(job.state) || !body.dispatchId || body.dispatchId !== job.dispatchId
      || body.receiptRef !== job.executor.receiptRef) throw fail('Exact active operator dispatch and planned receipt reference required', 409);
    const runtime = await require('../../models/RuntimeCoordination').findById('runtime').lean();
    if ([...(runtime?.workloads || []), ...(runtime?.inferences || [])].some(item => runtimeOverlaps(job, item))) {
      throw fail('Native runtime authority remains held; reconcile it through its owner first', 409);
    }
    job.state = body.state; job.finishedAt = new Date().toISOString();
    job.operation = { kind: 'operator', id: job.dispatchId, authority: 'operator-attestation' };
    job.releaseReceipt = { authority: 'operator-attestation', operationId: job.dispatchId, state: body.state,
      receiptRef: body.receiptRef, receiptSha256: body.receiptSha256, confirmation: body.confirmation,
      actor, observedAt: job.finishedAt };
    return event(job, actor, 'operator-finished', job.releaseReceipt);
  });
}
async function archived(offset = 0, limit = 50) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('Archive offset/limit invalid');
  return { jobs: await Archive.find().sort({ archivedAt: -1, _id: 1 }).skip(offset).limit(limit).lean(),
    count: await Archive.countDocuments(), offset, limit };
}
async function recover(id, body, actor) {
  revision(body);
  if (body.confirmation !== 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED') throw fail('Exact operator termination/release confirmation required');
  const receiptRef = text(body.receiptRef, 'receiptRef', 500);
  return mutate(async state => {
    const job = jobIn(state, id, body.expectedRevision);
    if (!ACTIVE.includes(job.state) || body.dispatchId !== job.dispatchId) throw fail('Exact active dispatch identity required', 409);
    const runtime = await require('../../models/RuntimeCoordination').findById('runtime').lean();
    const overlap = item => runtimeOverlaps(job, item);
    if ((runtime?.workloads || []).some(overlap) || (runtime?.inferences || []).some(overlap)) {
      throw fail('Native runtime authority remains held; reconcile it through its owner first', 409);
    }
    job.state = 'failed'; job.finishedAt = new Date().toISOString();
    job.releaseReceipt = { authority: 'operator-reconciliation', receiptRef, actor, confirmation: body.confirmation, observedAt: job.finishedAt };
    return event(job, actor, 'operator-reconciled', job.releaseReceipt);
  });
}
async function prepared(id, body, actor) {
  return mutate(async state => {
    const job = jobIn(state, id);
    if (!ACTIVE.includes(job.state) || body.dispatchId !== job.dispatchId || job.kind !== 'benchmark' || job.executor.prepare !== true) throw fail('Exact preparation dispatch required', 409);
    if (planRef(planId(body.plan), batchRequest(job.executor.request, { judgeRequired: true })) !== body.plan) throw fail('Prepared plan differs from the queued request', 409);
    const runtime = await require('../../models/RuntimeCoordination').findById('runtime').lean();
    if ((runtime?.workloads || []).some(item => runtimeOverlaps(job, item)) || (runtime?.inferences || []).some(item => runtimeOverlaps(job, item))) {
      throw fail('Preparation still has overlapping native runtime authority', 409);
    }
    job.state = 'completed'; job.finishedAt = new Date().toISOString();
    job.operation = { id: body.plan, kind: 'benchmark-preparation', authority: 'operator-plan-receipt' };
    job.releaseReceipt = { authority: 'operator-plan-receipt', preparedPlan: body.plan, observedAt: job.finishedAt };
    return event(job, actor, 'prepared', job.releaseReceipt);
  });
}
async function migrate(body, actor, { file = FILE } = {}) {
  const legacy = await legacySnapshot(file);
  if (!legacy || body.sha256 !== legacy.sha256) throw fail('Read and confirm the exact legacy snapshot before migration', 409);
  const now = new Date().toISOString();
  const jobs = [...legacy.running.map(row => ({ ...row, state: 'uncertain' })), ...legacy.waiting.map(row => ({ ...row, state: 'requested' }))]
    .map((row, i) => ({ id: crypto.randomUUID(), key: `legacy:${legacy.sha256}:${i}`, intentHash: digest(row),
      title: row.job, kind: 'legacy', hosts: [], resourceIds: [], topologyHash: null, estimatedMinutes: null,
      priority: row.priority, state: row.state, revision: 1, executor: null, reservation: null, operation: null,
      source: { type: 'legacy', ref: `QUEUE.md:${legacy.sha256}` }, legacyRow: row, createdAt: now, updatedAt: now,
      events: [{ at: now, actor: text(actor, 'actor', 100), action: 'imported' }] }));
  if (legacy.running.length) throw fail('Reconcile legacy running work before migrating the queue', 409);
  if (jobs.length > MAX_JOBS) throw fail('Legacy queue exceeds queue capacity', 409);
  try {
    await Queue.create([{ _id: 'heavy-work', revision: 1, jobs, legacy: { markdown: legacy.markdown, sha256: legacy.sha256, migratedAt: now } }], { writeConcern: WC });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const state = await Queue.findById('heavy-work').lean();
    if (state.legacy?.sha256 !== legacy.sha256) throw fail('Core queue already has another authority; no import applied', 409);
  }
  return list();
}

module.exports = { submit, reserve, begin, assertDispatch, record, cancel, settle, prepared, get, list, migrate, legacySnapshot, sameResources, runtimeOverlaps, archive, archived, recover, operatorFinish, MAX_JOBS };
