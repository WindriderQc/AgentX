'use strict';
// Chooses the image worker for a new request, before any effect: nothing is
// reserved, unloaded or submitted here. Workers are tried in manifest order.
// A worker is skipped when it is unreachable or lacks the profile's models,
// when one of its Ollama hosts does not answer, when other heavy work holds its
// hosts now, or when its card clearly lacks room even after unloading the
// Ollama residents it manages. Short image jobs do not count as busy: waiting a
// few seconds for the preferred worker beats evicting another host's models.
// If every candidate is reachable but none is clearly free, the first reachable
// one is kept, which is the single-worker behaviour.
const { createComfyClient } = require('./comfyClient');
const { candidates } = require('./workers');
const { hosts: queueHosts } = require('../heavyWorkQueueContract');

const ACTIVE = ['dispatching', 'running', 'uncertain'];

function busyKeys(jobs, now = Date.now(), { includeImages = false } = {}) {
  const keys = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if ((!includeImages && job?.kind === 'image') || !Array.isArray(job?.hosts)) continue;
    const reservedNow = job.state === 'reserved' && job.reservation
      && Date.parse(job.reservation.start) <= now && now < Date.parse(job.reservation.end);
    if (ACTIVE.includes(job.state) || reservedNow) job.hosts.forEach(host => keys.add(host));
  }
  return keys;
}

function workerKeys(worker) {
  try { return queueHosts([...worker.ollamaHosts, new URL(worker.workerUrl).origin]); } catch { return []; }
}

// Lenient room check: the card's free memory plus what its own Ollama
// residents would give back. A model spread over two cards is counted whole,
// so this only rejects a worker that is clearly too full; the exact check still
// runs after the unload, under the reservation.
function hasRoom(stats, residents, ratio) {
  const device = stats?.devices?.[0];
  if (!device || !(device.vram_total > 0)) return true;
  const reclaimable = residents.reduce((sum, r) => sum + (Number(r.size_vram) || 0), 0);
  return Number(device.vram_free) + reclaimable >= device.vram_total * ratio;
}

function defaultDeps() {
  return {
    client: url => createComfyClient(url),
    running: host => require('../hostPinPrimitives').fetchRunningModelInfosStrict(host),
    queueJobs: async () => (await require('../heavyWorkQueueService').list())?.jobs,
    now: () => Date.now()
  };
}

async function probe(worker, profile, deps, busy) {
  let stats;
  try { stats = await deps.client(worker.workerUrl).ready(profile, { allowBusy: true }); }
  catch { return { ready: false, reason: 'unavailable' }; }
  if (workerKeys(worker).some(key => busy.has(key))) return { ready: true, free: false, reason: 'reserved' };
  let residents = [];
  try {
    for (const host of worker.ollamaHosts) residents = residents.concat(await deps.running(host));
  } catch { return { ready: true, free: false, reason: 'ollama-unavailable' }; }
  if (!hasRoom(stats, residents, worker.minFreeVramRatio)) return { ready: true, free: false, reason: 'vram' };
  return { ready: true, free: true };
}

/**
 * @param config loaded image configuration
 * @param profile the validated profile ({ id, ...files })
 * @param options.queueHosts hosts reserved by an already queued request: only
 *   a worker whose Ollama hosts match them exactly may take it, with no fallback
 * @returns { worker, tried } where worker is a scoped configuration or null
 */
async function chooseWorker(config, profile, { queueHosts: reserved = null, opportunisticWorkerId = null, deps = defaultDeps() } = {}) {
  let list = candidates(config, profile.id);
  // Opportunistic callers name one worker, never a preference list. Readiness
  // is only a preflight: the native reservation repeats the no-resident guard.
  if (opportunisticWorkerId !== null) {
    const worker = list.find(item => item.worker.id === opportunisticWorkerId);
    if (!worker || reserved) return { worker: null, tried: [] };
    try {
      const jobs = await deps.queueJobs();
      if (!Array.isArray(jobs)) throw new Error('Image queue evidence unavailable');
      const busy = busyKeys(jobs, deps.now(), { includeImages: true });
      if (workerKeys(worker).some(key => busy.has(key))) return { worker: null, tried: [{ id: worker.worker.id, reason: 'reserved' }] };
      const stats = await deps.client(worker.workerUrl).ready(profile, { requireQueueProof: true });
      for (const host of worker.ollamaHosts) {
        if ((await deps.running(host)).length) return { worker: null, tried: [{ id: worker.worker.id, reason: 'resident' }] };
      }
      const device = stats?.devices?.[0];
      if (!device || !(device.vram_total > 0) || !hasRoom(stats, [], worker.minFreeVramRatio)) {
        return { worker: null, tried: [{ id: worker.worker.id, reason: 'vram' }] };
      }
      return { worker, tried: [{ id: worker.worker.id, reason: 'chosen' }] };
    } catch { return { worker: null, tried: [{ id: worker.worker.id, reason: 'unavailable' }] }; }
  }
  if (reserved) {
    const wanted = JSON.stringify(reserved);
    list = list.filter(worker => {
      try { return JSON.stringify(queueHosts(worker.ollamaHosts)) === wanted || JSON.stringify(workerKeys(worker)) === wanted; }
      catch { return false; }
    });
  }
  const tried = [];
  if (list.length === 1) {
    // A single candidate keeps the original rule: reachable with its models.
    try { await deps.client(list[0].workerUrl).ready(profile, { allowBusy: true }); }
    catch { return { worker: null, tried: [{ id: list[0].worker.id, reason: 'unavailable' }] }; }
    return { worker: list[0], tried: [{ id: list[0].worker.id, reason: 'chosen' }] };
  }
  let busy = new Set();
  try { busy = busyKeys(await deps.queueJobs(), deps.now()); } catch { /* No queue view: rely on the other checks. */ }
  let firstReady = null;
  for (const worker of list) {
    const result = await probe(worker, profile, deps, busy);
    tried.push({ id: worker.worker.id, reason: result.free ? 'chosen' : result.reason });
    if (result.free) return { worker, tried };
    if (result.ready && !firstReady) firstReady = worker;
  }
  if (firstReady) tried.find(t => t.id === firstReady.worker.id).reason = 'chosen-while-busy';
  return { worker: firstReady, tried };
}

module.exports = { chooseWorker, busyKeys, hasRoom, workerKeys };
