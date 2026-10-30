'use strict';
const Transcription = require('../../models/Transcription');
const queue = require('./heavyWorkQueueService');
const contract = require('./transcriptionContract');
const WC = { w: 1, j: true };
const ACTOR = 'core-transcriptions';
const TERMINAL = ['completed', 'failed', 'cancelled'];
let sweeping = false;
async function get(id, result = false) {
  if (!contract.UUID.test(id || '')) throw contract.fail('Transcription introuvable.', 404);
  const row = await Transcription.findById(id).select(result ? '+result' : '').lean();
  if (!row) throw contract.fail('Transcription introuvable.', 404);
  return project(row);
}
async function project(row, jobs) {
  if (!row.queueId || TERMINAL.includes(row.state)) return row;
  let job;
  try { job = jobs ? jobs.find(item => item.id === row.queueId) : await queue.get(row.queueId); } catch { return { ...row, planning: { available: false } }; }
  row = { ...row, planning: require('./transcriptionPresentation').planning(job) };
  if (job?.state === 'uncertain' || row.stage === 'reconciling') return { ...row, state: 'uncertain', stage: 'reconciling', error: 'La réponse du service vocal est à vérifier. Cette tentative reste réservée ; aucun doublon ne sera lancé.' };
  return row;
}
async function enroll(row) {
  const cfg = contract.config();
  let job = await queue.submit({ key: 'transcription:' + row._id, title: 'Local audio transcription', kind: 'transcription',
    hosts: cfg.hosts, estimatedMinutes: cfg.minutes, notBefore: new Date(row.requestedAt || row.createdAt).toISOString(),
    source: { type: 'operator', ref: 'transcriptions:' + row._id }, executor: { transcriptionId: row._id } }, ACTOR);
  await Transcription.updateOne({ _id: row._id }, { $set: { queueId: job.id } }, { writeConcern: WC });
  if (job.state === 'requested') {
    try {
      const start = new Date(Math.max(Date.now(), new Date(row.requestedAt || row.createdAt).getTime())).toISOString();
      job = await queue.reserve(job.id, { expectedRevision: job.revision, start, autoStart: true }, ACTOR);
      await Transcription.updateOne({ _id: row._id }, { $unset: { planningError: 1 } });
    } catch (error) {
      if (!['HEAVY_QUEUE_CONFLICT', 'HEAVY_QUEUE_STALE', 'HEAVY_QUEUE_TOPOLOGY_CHANGED'].includes(error.code)) throw error;
      await Transcription.updateOne({ _id: row._id }, { $set: { planningError: 'En attente d’un créneau libre dans la file de traitements.' } });
    }
  }
  return job;
}
async function create(body, { linkedRetry = false } = {}) {
  if (body?.retryOf && !linkedRetry) throw contract.fail('Utilisez l’action Réessayer pour lier une tentative.');
  contract.config();
  const input = contract.intent(body);
  const prior = await Transcription.findById(input.id).lean();
  if (prior) {
    if (prior.intentHash !== input.intentHash) throw contract.fail('Cette identité correspond à une autre demande.', 409);
    if (!prior.queueId) await enroll(prior);
    return get(input.id);
  }
  if (input.requestedAt && Date.parse(input.requestedAt) <= Date.now()) throw contract.fail('Choisissez une date future.');
  const row = { _id: input.id, ...input, state: 'queued', stage: 'queued' };
  delete row.id;
  try { await Transcription.create([row], { writeConcern: WC }); }
  catch (error) { if (error.code !== 11000) throw error; }
  const saved = await get(input.id);
  if (saved.intentHash !== input.intentHash) throw contract.fail('Cette identité correspond à une autre demande.', 409);
  await enroll(saved);
  return get(input.id);
}
async function list({ search = '', offset = 0 } = {}) {
  const query = {};
  if (search) query.$or = ['title', 'url', 'result.text'].map(field => ({ [field]: { $regex: String(search).slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }));
  const skip = Number(offset);
  if (!Number.isInteger(skip) || skip < 0) throw contract.fail('Page invalide.');
  const rows = await Transcription.find(query).sort({ createdAt: -1, _id: 1 }).skip(skip).limit(30).lean();
  const jobs = (await queue.list())?.jobs || [];
  return { rows: await Promise.all(rows.map(row => project(row, jobs))), count: await Transcription.countDocuments(query), offset: skip, limit: 30 };
}
async function cancel(id) {
  const row = await get(id);
  if (TERMINAL.includes(row.state)) return row;
  if (!row.queueId) throw contract.fail('Demande encore en préparation. Actualisez puis annulez.', 409);
  await Transcription.updateOne({ _id: id }, { $set: { cancelRequested: true } }, { writeConcern: WC });
  const job = await queue.get(row.queueId);
  if (['requested', 'reserved'].includes(job.state)) {
    await queue.cancel(job.id, { expectedRevision: job.revision }, ACTOR);
    await Transcription.updateOne({ _id: id }, { $set: { state: 'cancelled', stage: 'cancelled', finishedAt: new Date() } }, { writeConcern: WC });
  } else {
    // Stable native identity; never select a fallback or clear its active fence.
    // A launch may not yet have a native receipt. Persist the intent; the observer
    // sends it under the original identity as soon as that receipt exists.
    await require('./transcriptionExecutor').cancelNative(job).catch(() => {});
    await Transcription.updateOne({ _id: id }, { $set: { stage: 'cancelling' } }, { writeConcern: WC });
  }
  return get(id);
}
async function retry(id, body) {
  const row = await get(id);
  if (!['failed', 'cancelled'].includes(row.state) || (row.queueId && !TERMINAL.includes((await queue.get(row.queueId)).state))) {
    throw contract.fail('Attendez la fin confirmée de la tentative avant de réessayer.', 409);
  }
  const request = { requestKey: body.requestKey, url: row.url, language: row.language, timeZone: row.timeZone, retryOf: id };
  const input = contract.intent(request);
  const replay = await Transcription.findById(input.id).lean();
  if (replay) return create(request, { linkedRetry: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const parent = await Transcription.findById(id).select('+retryRequestId').lean();
    const current = parent.retryRequestId;
    if (current === input.id) return create(request, { linkedRetry: true });
    if (current) {
      const child = await Transcription.findById(current).lean();
      if (!child) {
        // Recover the already accepted retry intent after a crash between its
        // parent CAS and child insert. Never substitute this caller's new key.
        await create({ ...request, requestKey: current }, { linkedRetry: true });
        throw contract.fail('La tentative déjà acceptée a été récupérée. Actualisez la bibliothèque.', 409);
      }
      if (!TERMINAL.includes(child.state) || (child.queueId && !TERMINAL.includes((await queue.get(child.queueId)).state))) {
        throw contract.fail('Une nouvelle tentative est déjà active ou en préparation. Consultez la bibliothèque.', 409);
      }
    }
    const claimed = await Transcription.updateOne({ _id: id, retryRequestId: current || null },
      { $set: { retryRequestId: input.id } }, { writeConcern: WC });
    if (claimed.modifiedCount) return create(request, { linkedRetry: true });
  }
  throw contract.fail('La tentative a changé. Actualisez la bibliothèque.', 409);
}
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const row of await Transcription.find({ state: 'queued' }).limit(50).lean()) {
      try {
        const job = row.queueId ? await queue.get(row.queueId) : null;
        if (!job || job.state === 'requested') await enroll(row);
        else if (job.state === 'failed') await Transcription.updateOne({ _id: row._id }, { $set: { state: 'failed', stage: 'admission', error: 'Le démarrage a été refusé. Vous pouvez réessayer.', finishedAt: new Date() } });
        else if (job.state === 'cancelled') await Transcription.updateOne({ _id: row._id }, { $set: { state: 'cancelled', stage: 'cancelled', finishedAt: new Date() } });
        else if (job.state === 'reserved' && Date.parse(job.reservation.end) <= Date.now()) {
          await Transcription.updateOne({ _id: row._id }, { $set: { planningError: 'Le créneau a expiré sans démarrage. Annulez puis réessayez.' } });
        }
      } catch { /* Keep the durable request visible; the next sweep retries only planning. */ }
    }
  } finally { sweeping = false; }
}
module.exports = { create, get, list, cancel, retry, sweep, enroll, TERMINAL };
