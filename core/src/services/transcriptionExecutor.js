'use strict';
const Model = require('../../models/Transcription');
const { fail, config } = require('./transcriptionContract');
const coordination = require('./runtimeCoordinationService');
const PRINCIPAL = 'core-long-transcriptions';
const WC = { w: 1, j: true };
async function native(base, method, path, body) {
  const response = await fetch(base + '/v1/audio/long-transcriptions' + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) })
  });
  if (!response.ok) throw fail('Le service vocal est indisponible ou ne prend pas encore en charge ce traitement.', response.status === 404 ? 409 : 503, 'TRANSCRIPTION_NATIVE_UNAVAILABLE');
  const text = await response.text();
  if (Buffer.byteLength(text) > 9 * 1024 ** 2) throw fail('Réponse vocale trop volumineuse.', 503);
  return JSON.parse(text);
}
async function record(job) {
  const row = await Model.findById(job.executor.transcriptionId).select('+nativeBase +admission +result').lean();
  if (!row || row.queueId !== job.id) throw fail('Identité de transcription incohérente.', 409);
  return row;
}
async function preDispatch(job) {
  const row = await record(job), cfg = config();
  const normalize = values => require('./heavyWorkQueueContract').hosts(values).join('|');
  if (normalize(job.hosts) !== normalize(cfg.hosts) || row.state !== 'queued') throw fail('Configuration de transcription modifiée.', 409);
  try {
    const capability = await native(cfg.base, 'GET', '/capabilities');
    if (capability.contract !== 'voix.long-transcriptions/v1' || capability.durable !== true) throw fail('Service vocal incompatible.', 503);
  } catch (error) {
    await Model.updateOne({ _id: row._id }, { $set: { error: 'Le service vocal n’est pas prêt pour les tâches longues. La demande attend sa configuration, sans lancement.' } });
    throw error;
  }
}
async function start(job) {
  const row = await record(job), cfg = config();
  // Admission is exclusive and uses the same physical-resource topology as the queue.
  // No model unload, model replacement or pin mutation is requested.
  const admission = await coordination.acquireWorkload({ principal: PRINCIPAL, requestId: job.id,
    workloadId: job.id, kind: 'transcription', hosts: job.hosts, ttl: 120000 });
  if (!admission.acquired) {
    await Model.updateOne({ _id: row._id }, { $set: { state: 'failed', stage: 'admission', error: 'Les ressources sont réservées. Réessayez une fois disponibles.', finishedAt: new Date() } }, { writeConcern: WC });
    throw Object.assign(fail('Les ressources sont réservées. Réessayez une fois disponibles.', 409), { notStarted: true });
  }
  await Model.updateOne({ _id: row._id, state: 'queued' }, { $set: {
    admission, nativeBase: cfg.base, state: 'running', stage: 'dispatching', error: null, startedAt: new Date()
  } }, { writeConcern: WC });
  // An ambiguous response leaves the dispatch and admission held. Observe by job.id.
  const receipt = await native(cfg.base, 'POST', '', { id: job.id, url: row.url, language: row.language });
  if (receipt.id !== job.id || receipt.url !== row.url) throw fail('Reçu vocal incohérent.', 503);
  return { id: receipt.id };
}
function proof(admission) { return { id: admission.admissionId, generation: admission.generation, principal: PRINCIPAL }; }
async function observe(job) {
  try { return await observeReceipt(job); }
  catch (error) {
    await Model.updateOne({ _id: job.executor.transcriptionId, state: { $nin: ['completed', 'failed', 'cancelled'] } }, { $set: { stage: 'reconciling',
      error: 'Le reçu du service vocal ou sa libération reste à vérifier. La tentative est conservée sans relance automatique.' } }).catch(() => {});
    throw error;
  }
}
async function observeReceipt(job) {
  const row = await record(job);
  if (!row.nativeBase || !row.admission) throw fail('Le lancement nécessite une réconciliation opérateur.', 409);
  let receipt = await native(row.nativeBase, 'GET', '/' + encodeURIComponent(job.id));
  if (receipt.id !== job.id || receipt.url !== row.url || receipt.language !== row.language) throw fail('Reçu vocal incohérent.', 409);
  if (row.cancelRequested && !['completed', 'failed', 'cancelled'].includes(receipt.state) && receipt.stage !== 'cancelling') {
    receipt = await native(row.nativeBase, 'POST', '/' + encodeURIComponent(job.id) + '/cancel');
  }
  const terminal = ['completed', 'failed', 'cancelled'].includes(receipt.state);
  if (!terminal) {
    const heartbeat = await coordination.heartbeat('workload', { ...proof(row.admission), ttl: 120000 });
    if (!heartbeat.heartbeat) throw fail('Admission GPU à réconcilier ; aucune nouvelle tentative ne sera lancée.', 409);
  }
  const updates = { stage: receipt.stage, ...(receipt.title && { title: receipt.title }), duration: receipt.duration,
    error: receipt.error || null };
  if (terminal) {
    if (!row.runtimeReleased) {
      const released = await coordination.release('workload', proof(row.admission));
      if (!released.released) {
        const recovered = await coordination.recoverRelease('workload', proof(row.admission));
        if (!recovered.released) throw fail('Le traitement est terminé ; la libération GPU reste à vérifier.', 409);
      }
    }
    updates.runtimeReleased = true;
    updates.result = receipt.result || null;
    updates.detectedLanguage = receipt.result?.detectedLanguage;
    updates.finishedAt = new Date(receipt.finishedAt * 1000);
    // Personal result is persisted before the queue receives its terminal receipt.
    updates.state = receipt.state;
  }
  await Model.updateOne({ _id: row._id }, { $set: updates }, { writeConcern: WC });
  return { operationId: job.id, terminal, state: receipt.state, authority: 'voix.long-transcription', stage: receipt.stage };
}
async function cancelNative(job) {
  const row = await record(job);
  if (!row.nativeBase) throw fail('Lancement en cours de réconciliation. Actualisez avant d’annuler.', 409);
  return native(row.nativeBase, 'POST', '/' + encodeURIComponent(job.id) + '/cancel');
}
module.exports = { start, observe, preDispatch, cancelNative, native };
