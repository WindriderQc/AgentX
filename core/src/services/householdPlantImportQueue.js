'use strict';
// Native executor for folder imports. One durable slot serializes every plant,
// including across Core processes and route changes. A crossed dispatch fence
// is observed by its original identity, never launched again after a restart.
const crypto = require('node:crypto');
const Imports = require('../../models/HouseholdPlantImport');
const Plant = require('../../models/HouseholdPlant');
const queue = require('./heavyWorkQueueService');
const { hosts } = require('./heavyWorkQueueContract');
const { fail } = require('./householdPlantFolder');
const PROCESS = crypto.randomUUID();
const ACTOR = 'core-plant-import';
const WC = { w: 1, j: true };
const ACTIVE = ['dispatching', 'running', 'uncertain'];
let assistant;
function configure(value) { assistant = value; }
async function target() {
  const router = require('./modelRouterConfig');
  await router.ensureTaskModelOverridesLoaded();
  const route = await router.resolvePreferredTaskEntry('plant_identify');
  if (!route?.model || !route.url || route.refusal) throw fail('Configurez une route de vision pour plant_identify.', 503, 'PLANT_VISION_UNAVAILABLE');
  return { model: route.model, host: hosts([route.url])[0] };
}
async function enroll(row, deps = {}) {
  if (!row.imported) throw fail('Import incomplet.', 409);
  const service = deps.queue || queue;
  let job = row.queueId ? await service.get(row.queueId) : null;
  if (!job) {
    // Persist the resolved route before submit: a lost response reuses the same
    // queue intent, even if the operator edits routing between retries.
    const selected = row.target?.model ? row.target : await (deps.target || target)();
    await Imports.updateOne({ _id: row._id, 'target.model': { $exists: false } }, { $set: { target: selected } }, { writeConcern: WC });
    row = await Imports.findById(row._id).lean();
    job = await service.submit({ key: `plant-import:${row._id}`, title: 'Identify an imported household plant', kind: 'other',
      hosts: [row.target.host], estimatedMinutes: 5, source: { type: 'operator', ref: `plant-import:${row._id}` },
      executor: { mode: 'plant-identify', importId: row._id } }, ACTOR);
    await Imports.updateOne({ _id: row._id }, { $set: { queueId: job.id }, $unset: { error: 1 } }, { writeConcern: WC });
  }
  // Mark only a fresh request; never hide a completed or uncertain operation.
  if (['requested', 'reserved'].includes(job.state)) await Plant.updateOne({ _id: row.plantId,
    'assistant.identify.state': { $nin: ['running', 'completed', 'failed'] } },
  { $set: { 'assistant.identify': { state: 'queued', queueId: job.id } } }, { writeConcern: WC });
  return job;
}
async function record(job) {
  const row = await Imports.findById(job.executor.importId).lean();
  if (!row || !row.imported || row.queueId !== job.id) throw fail('Reçu d’import incohérent.', 409);
  return row;
}
async function preDispatch(job, deps = {}) {
  const row = await record(job);
  const current = await (deps.target || target)();
  if (row.target.model !== current.model || row.target.host !== current.host || hosts(job.hosts).join() !== hosts([row.target.host]).join()) {
    throw fail('La route a changé. Annulez cette demande et vérifiez sa configuration.', 409, 'HEAVY_QUEUE_EXECUTOR_CHANGED');
  }
  const plant = await Plant.findById(row.plantId).lean();
  if (plant?.status !== 'draft' || !plant.photos?.length) throw fail('Le brouillon ou ses photos ne sont plus disponibles pour cette identification.', 409, 'PLANT_IMPORT_DRAFT_CHANGED');
  if (plant.assistant?.identify?.state !== 'queued') throw fail('Le brouillon n’est plus prêt pour cette identification.', 409);
}
async function observe(job) {
  const row = await record(job);
  if (row.dispatchId !== job.dispatchId) throw fail('Lancement à réconcilier ; aucune relance automatique.', 409);
  if (!['completed', 'failed'].includes(row.state)) return { operationId: row._id, terminal: false,
    uncertain: row.processId !== PROCESS, reason: 'Le processus d’identification a disparu ; vérifier le reçu et l’admission sans relancer.' };
  // The common queue evidence reader also checks runtime admission release.
  return { operationId: row._id, terminal: true, state: row.state, authority: 'core.plant-import' };
}
async function execute(row, job, selectedAssistant, service) {
  try {
    const result = await selectedAssistant.identify({ id: String(row.plantId), queueId: job.id, wait: true, executionTarget: row.target });
    const state = result.plant.assistant?.identify?.state;
    if (!['completed', 'failed'].includes(state)) throw fail('Résultat à réconcilier.', 409);
    await Imports.updateOne({ _id: row._id, dispatchId: job.dispatchId, state: 'running' },
      { $set: { state, finishedAt: new Date(), error: result.plant.assistant.identify.error || null } }, { writeConcern: WC });
  } catch (error) {
    // An exception is not proof that inference stopped; retain the lane and
    // queue fence until an operator reconciles it. No retry or compensation.
    await service.record(job.id, { dispatchId: job.dispatchId, state: 'uncertain', reason: 'Plant identification outcome requires reconciliation.' }, ACTOR).catch(() => {});
  }
}
async function closeUnstarted(row, job) {
  await Imports.updateOne({ _id: row._id }, { $set: { state: 'failed', error: `Queue: ${job.state}` }, $unset: { workerSlot: 1 } }, { writeConcern: WC });
  await Plant.updateOne({ _id: row.plantId, 'assistant.identify.queueId': job.id, 'assistant.identify.state': { $in: ['queued', 'running'] } },
    { $set: { 'assistant.identify.state': 'failed', 'assistant.identify.error': 'Identification annulée ou à réconcilier dans la file Core.' } }, { writeConcern: WC });
}
async function sweep(deps = {}) {
  const selectedAssistant = deps.assistant || assistant;
  if (!selectedAssistant) return;
  const service = deps.queue || queue, evidence = deps.evidence || require('./heavyWorkQueueEvidence');
  // Planning failures retry only the same identity, never the execution.
  for (const row of await Imports.find({ imported: true, queueId: { $exists: false } }).limit(20).lean()) {
    try { await enroll(row, deps); }
    catch (error) { await Imports.updateOne({ _id: row._id }, { $set: { error: error.code || 'PLANT_IMPORT_QUEUE_UNAVAILABLE' } }); }
  }
  const held = await Imports.findOne({ workerSlot: 'plant-identify' }).lean();
  if (held) {
    const job = held.queueId && await service.get(held.queueId);
    if (!job || !['completed', 'failed', 'cancelled'].includes(job.state)) return;
    if (!['completed', 'failed'].includes(held.state)) await closeUnstarted(held, job);
    await Imports.updateOne({ _id: held._id, workerSlot: 'plant-identify', dispatchId: held.dispatchId }, { $unset: { workerSlot: 1 } }, { writeConcern: WC });
  }
  const rows = await Imports.find({ imported: true, state: 'queued', queueId: { $exists: true } }).sort({ createdAt: 1, _id: 1 }).limit(20).lean();
  for (const row of rows) {
    let job = await service.get(row.queueId);
    if (['completed', 'failed', 'cancelled'].includes(job.state)) {
      await closeUnstarted(row, job);
      continue;
    }
    if (ACTIVE.includes(job.state)) return;
    let claimed;
    try {
      claimed = await Imports.findOneAndUpdate({ _id: row._id, state: 'queued' },
        { $set: { state: 'claimed', workerSlot: 'plant-identify', processId: PROCESS } }, { new: true, writeConcern: WC }).lean();
    } catch (error) { if (error.code === 11000) return; throw error; }
    if (!claimed) return;
    try {
      if (job.state === 'requested') job = await service.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, ACTOR);
      await evidence.preDispatch(job);
      job = await service.begin(job.id, { expectedRevision: job.revision }, ACTOR);
      await Imports.updateOne({ _id: row._id, state: 'claimed' }, { $set: { dispatchId: job.dispatchId, state: 'running' } }, { writeConcern: WC });
      await service.assertDispatch(job.id, job.dispatchId);
      await service.record(job.id, { dispatchId: job.dispatchId, state: 'running', operationId: row._id }, ACTOR);
      const work = execute(claimed, job, selectedAssistant, service);
      if (deps.wait) await work;
      else work.catch(() => {});
    } catch (error) {
      // Read after an uncertain write before deciding that nothing started.
      const current = await service.get(job.id);
      if (error.code === 'PLANT_IMPORT_DRAFT_CHANGED' && ['requested', 'reserved'].includes(current.state)) {
        const cancelled = await service.cancel(job.id, { expectedRevision: current.revision }, ACTOR);
        await closeUnstarted(row, cancelled);
        return;
      }
      if (['requested', 'reserved'].includes(current.state)) await Imports.updateOne({ _id: row._id, state: 'claimed' },
        { $set: { state: 'queued', error: error.code || 'PLANT_IMPORT_WAITING' }, $unset: { workerSlot: 1 } }, { writeConcern: WC });
      // A dispatch gap remains claimed/held for explicit reconciliation.
    }
    return;
  }
}
module.exports = { configure, target, enroll, preDispatch, observe, sweep };
