'use strict';

const { hostUrlKey } = require('../../../../shared/ollamaHostConfig');
const clean = (value, limit = 160) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit);
const ACTIVE = new Set(['dispatching', 'running', 'uncertain']);
const LABELS = Object.freeze({
  dispatching: 'démarrage enregistré', running: 'en cours', uncertain: 'issue non confirmée'
});

function reasonOf(error) {
  if (error?.code === 'PRINCIPAL_MODEL_UNAVAILABLE') return `topology_${error.reason || 'unavailable'}`;
  if (error?.code === 'BENCHMARK_CLAIM_ACTIVE') return 'benchmark_claim';
  if (error?.code === 'RUNTIME_INFERENCE_RECOVERY_REQUIRED') return 'quarantined';
  if (error?.code === 'HOST_SESSION_HOLD_BUSY') return 'session_hold';
  if (error?.failure?.holder?.type === 'inference') return 'primary_busy';
  if (error?.ollamaRequestNotSent || error?.cause?.ollamaRequestNotSent) return 'host_down';
  return 'admission_blocked';
}

function primaryHosts(snapshot, target) {
  if (target?.hostUrl) return [target.hostUrl];
  const group = snapshot?.principalTopology?.topology?.group;
  try {
    const topology = require('../runtimeTopologyService').parseTopology();
    const groups = topology.groups.filter(row => group ? row.id === group : topology.groups.length === 1);
    return [...new Set(groups.flatMap(row => row.modes.flatMap(mode => mode.endpoints.map(endpoint => endpoint.url))))];
  } catch { return []; }
}

// Job titles are reference data, never model instructions. Only an actual
// active native/queue record covering the principal is described as active.
function describe(error, hosts, queue = null) {
  const keys = new Set(hosts.map(hostUrlKey));
  const jobs = (queue?.jobs || []).filter(job => ACTIVE.has(job.state)
    && job.hosts?.some(host => keys.has(hostUrlKey(host)))).slice(0, 3);
  const holder = error?.failure?.holder;
  let text = 'Le cerveau principal est temporairement indisponible.';
  if (jobs.length) text += ' Travaux vérifiés par Core : ' + jobs.map(job =>
    `${JSON.stringify(clean(job.title))} (${LABELS[job.state]})`).join('; ') + '.';
  else if (error?.code === 'BENCHMARK_CLAIM_ACTIVE') text += ' Le serveur est réservé par une campagne Benchmark.';
  else if (holder?.type === 'maintenance') text += ' Une maintenance détient les ressources.';
  else if (holder?.type === 'workload' || holder?.kind) text += ` Réservation native : ${JSON.stringify(clean(holder.kind || holder.type))}.`;
  else if (error?.code === 'PRINCIPAL_MODEL_UNAVAILABLE') text += ' Aucun mode de topologie utilisable ne résout le principal pour ce tour.';
  else if (reasonOf(error) === 'primary_busy') text += ' Une autre requête utilise le cerveau principal.';
  else if (reasonOf(error) === 'quarantined') text += ' Son moteur attend une récupération vérifiée.';
  const estimate = error?.estimatedEndAt;
  const until = estimate && Number.isFinite(Date.parse(estimate)) && Date.parse(estimate) > Date.now() ? estimate : null;
  text += until ? ` Fin estimée par le propriétaire natif : ${until}; cet horaire n’est pas garanti.`
    : ' L’heure de disponibilité n’est pas connue.';
  return text;
}

async function readQueue() {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) return null;
  // A bounded read projection, not a second queue or a dispatch operation.
  const state = await require('../../../models/HeavyWorkQueue').findById('heavy-work')
    .select('jobs.title jobs.state jobs.hosts').maxTimeMS(1000).lean();
  return state;
}

async function boundedRead(read, timeoutMs = 1500, signal) {
  let timer, aborted;
  try {
    signal?.throwIfAborted();
    return await Promise.race([Promise.resolve().then(read), new Promise((resolve, reject) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      if (signal) {
        aborted = () => reject(signal.reason || new Error('cancelled'));
        signal.addEventListener('abort', aborted, { once: true });
      }
    })]);
  } finally {
    clearTimeout(timer);
    if (aborted) signal.removeEventListener('abort', aborted);
  }
}

module.exports = { reasonOf, primaryHosts, describe, readQueue, boundedRead };
