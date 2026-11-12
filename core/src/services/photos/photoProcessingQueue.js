'use strict';
const crypto = require('node:crypto');
const Batches = require('../../../models/PhotoProcessingBatch');
const queue = require('../heavyWorkQueueService');
const { hosts } = require('../heavyWorkQueueContract');
const { hash, id } = require('./phoneLibrary');
const { fail } = require('./importFiles');
const { loadProcessingConfig } = require('./photoProcessingConfig');
const { createPhotoProcessingWork } = require('./photoProcessingWork');
const PROCESS = crypto.randomUUID(), ACTOR = 'core-photo-processing', WC = { w: 1, j: true };
const configIdentity = c => hash([c.libraryId, c.originalPathPrefix, c.nasHost]);
async function target() {
  const router = require('../modelRouterConfig');
  await router.ensureTaskModelOverridesLoaded();
  const route = await router.resolvePreferredTaskEntry('analysis');
  if (!route?.model || !route.url || route.refusal) throw fail('PHOTO_VISION_UNAVAILABLE', 'Configure the analysis vision route');
  // /api/show reads the exact routed model's manifest; it loads no model and
  // starts no inference. Refuse before planning if image support is absent.
  await require('../inferenceImageSupport').requireImageSupport({ messages: [{ images: ['capability-check'] }],
    model: route.model, hostUrl: route.url, fetch: require('node-fetch') });
  return { model: route.model, host: hosts([route.url])[0] };
}
async function enroll(row, deps = {}) {
  const service = deps.queue || queue;
  let job = row.queueId && await service.get(row.queueId);
  if (!job) {
    const config = (deps.config || loadProcessingConfig)();
    if (!config || configIdentity(config) !== row.configHash) throw fail('PHOTO_PROCESSING_CONFIG_CHANGED', 'Photo processing configuration changed');
    job = await service.submit({ key: 'photo-processing:' + row._id, title: 'Index and analyze verified phone media',
      kind: 'other', hosts: [config.nasHost, row.target.host], estimatedMinutes: 90,
      source: { type: 'operator', ref: 'photo-processing:' + row._id },
      executor: { mode: 'photo-processing', processingId: row._id } }, ACTOR);
    await Batches.updateOne({ _id: row._id }, { $set: { queueId: job.id }, $unset: { error: 1 } }, { writeConcern: WC });
  }
  return job;
}
async function enqueue(input, deps = {}) {
  const operationId = id(input.operationId), runId = id(input.runId);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 24)
    throw fail('INVALID_SELECTION', 'Select between one and twenty-four verified imports');
  const items = [...new Set(input.items.map(id))].sort(), inputHash = hash({ runId, items });
  await Batches.ensureProcessingIndexes();
  let row = await Batches.findById(operationId).lean();
  if (!row) {
    const config = (deps.config || loadProcessingConfig)();
    if (!config) throw fail('PHOTO_PROCESSING_NOT_CONFIGURED', 'Configure photo processing before launch');
    const selected = await (deps.target || target)();
    try { await Batches.create([{ _id: operationId, runId, items, inputHash, configHash: configIdentity(config), target: selected }], { writeConcern: WC }); }
    catch (error) { if (error.code !== 11000) throw error; }
    row = await Batches.findById(operationId).lean();
  }
  if (row.inputHash !== inputHash) throw fail('REQUEST_CONFLICT', 'This photo processing identity already has another selection');
  const job = await enroll(row, deps);
  return { operationId, queueId: job.id, state: row.state };
}
async function record(job) {
  const row = await Batches.findById(job.executor.processingId).lean();
  if (!row || row.queueId !== job.id) throw fail('PHOTO_PROCESSING_RECEIPT_MISMATCH', 'Photo processing receipt belongs to another queue');
  return row;
}
async function preDispatch(job, deps = {}) {
  const row = await record(job), config = (deps.config || loadProcessingConfig)();
  const current = await (deps.target || target)();
  if (!config || configIdentity(config) !== row.configHash || hash(current) !== hash(row.target)
    || hosts(job.hosts).join() !== hosts([config.nasHost, row.target.host]).join())
    throw fail('HEAVY_QUEUE_EXECUTOR_CHANGED', 'Photo processing route or library changed; review the original request');
}
async function observe(job, deps = {}) {
  const row = await record(job);
  if (row.dispatchId !== job.dispatchId) throw fail('PHOTO_PROCESSING_DISPATCH_UNKNOWN', 'Observe the original photo processing dispatch');
  const base = { operationId: row._id, progress: row.progress };
  if (row.state === 'completed') {
    const client = deps.client || require('./immichClient').createImmichClient();
    if (!require('./photoProcessingWork').queuesIdle(await client.json('/jobs')))
      return { ...base, terminal: false, reason: 'Immich background work still holds the planned window' };
    return { ...base, terminal: true, state: 'completed', authority: 'core.photo-processing' };
  }
  return { ...base, terminal: false, uncertain: row.state === 'uncertain' || row.processId !== PROCESS,
    reason: row.error || 'Observe the original processing operation; no automatic replay' };
}
async function sweep(deps = {}) {
  if (!(deps.config || loadProcessingConfig)()) return;
  await require('./photoProcessingRuns').discover(deps);
  const service = deps.queue || queue;
  for (const row of await Batches.find({ state: 'queued', queueId: { $exists: false } }).limit(20).lean()) {
    try { await enroll(row, deps); }
    catch (error) { await Batches.updateOne({ _id: row._id }, { $set: { error: error.code || 'PHOTO_QUEUE_UNAVAILABLE' } }); }
  }
  const held = await Batches.findOne({ workerSlot: 'photo-processing' }).lean();
  if (held) {
    const job = held.queueId && await service.get(held.queueId);
    if (!job || !['completed', 'failed', 'cancelled'].includes(job.state)) return;
    await Batches.updateOne({ _id: held._id, workerSlot: 'photo-processing', dispatchId: held.dispatchId },
      { $unset: { workerSlot: 1 }, ...(!['completed', 'failed'].includes(held.state) ? { $set: { state: 'failed', error: 'Queue: ' + job.state } } : {}) }, { writeConcern: WC });
  }
  const rows = await Batches.find({ state: 'queued', queueId: { $exists: true } }).sort({ createdAt: 1 }).limit(20).lean();
  for (const row of rows) {
    let job = await service.get(row.queueId);
    if (['completed', 'failed', 'cancelled'].includes(job.state)) {
      await Batches.updateOne({ _id: row._id, state: 'queued' }, { $set: { state: 'failed', error: 'Queue: ' + job.state } }); continue;
    }
    if (['dispatching', 'running', 'uncertain'].includes(job.state)) return;
    let claimed;
    try { claimed = await Batches.findOneAndUpdate({ _id: row._id, state: 'queued' },
      { $set: { state: 'claimed', workerSlot: 'photo-processing', processId: PROCESS } }, { new: true, writeConcern: WC }).lean(); }
    catch (error) { if (error.code === 11000) return; throw error; }
    if (!claimed) return;
    try {
      if (job.state === 'requested') job = await service.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, ACTOR);
      await (deps.preDispatch || require('../heavyWorkQueueEvidence').preDispatch)(job);
      job = await service.begin(job.id, { expectedRevision: job.revision }, ACTOR);
      await Batches.updateOne({ _id: row._id, state: 'claimed' }, { $set: { dispatchId: job.dispatchId, state: 'running' } }, { writeConcern: WC });
      await service.assertDispatch(job.id, job.dispatchId);
      await service.record(job.id, { dispatchId: job.dispatchId, state: 'running', operationId: row._id }, ACTOR);
      const work = (deps.work || createPhotoProcessingWork(deps)).run(claimed, job).catch(async error => {
        await Batches.updateOne({ _id: row._id, dispatchId: job.dispatchId }, { $set: { state: 'uncertain', error: error.code || 'PHOTO_PROCESSING_UNKNOWN' } }, { writeConcern: WC });
        await service.record(job.id, { dispatchId: job.dispatchId, state: 'uncertain', reason: 'Observe original photo processing effects before any retry.' }, ACTOR).catch(() => {});
      });
      if (deps.wait) await work; else work.catch(() => {});
    } catch (error) {
      const current = await service.get(job.id);
      if (['requested', 'reserved'].includes(current.state)) await Batches.updateOne({ _id: row._id, state: 'claimed' },
        { $set: { state: 'queued', error: error.code || 'PHOTO_PROCESSING_WAITING' }, $unset: { workerSlot: 1 } }, { writeConcern: WC });
    }
    return;
  }
}
module.exports = { enqueue, enroll, target, preDispatch, observe, sweep, configIdentity };
