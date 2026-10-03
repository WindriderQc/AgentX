'use strict';
const coordination = require('../runtimeCoordinationService');
const { captureBenchmarkRuntime, benchmarkRuntimeSnapshotIdentity, benchmarkResidentExpiryMatches, desiredBenchmarkResidents } = require('../benchmarkRuntimeSnapshot');
const { fetchRunningModelInfosStrict, isEmbeddingModelName } = require('../hostPinPrimitives');
const { warmDefaultModel, unloadModel } = require('../hostModelRuntime');
const { placementRestored } = require('../benchmarkRuntimeRestore');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PRINCIPAL = 'core-local-images';

async function restoreSnapshots(snapshots, assertOwned) {
  for (const [host, snap] of Object.entries(snapshots)) {
    if (!snap?.exact || !Array.isArray(snap.residents) || snap.identityDigest !== benchmarkRuntimeSnapshotIdentity(snap)) throw new Error('Exact GPU snapshot is required');
    const residents = desiredBenchmarkResidents(snap);
    residents.sort((a, b) => Number(isEmbeddingModelName(a.model)) - Number(isEmbeddingModelName(b.model)));
    const runningBefore = await fetchRunningModelInfosStrict(host);
    if (runningBefore.some(x => !residents.some(r => r.model === (x.name || x.model)))) throw new Error('Unexpected GPU resident prevents restoration');
    for (const resident of residents) {
      await assertOwned();
      const existing = runningBefore.find(x => (x.name || x.model) === resident.model);
      if (existing && (existing.context_length !== resident.contextLength || !placementRestored(resident, existing))) {
        const reset = await unloadModel(host, resident.model);
        if (reset.status !== 'ok') throw new Error('Resident reset is unverified');
        const deadline = Date.now() + 15000;
        while ((await fetchRunningModelInfosStrict(host)).some(x => (x.name || x.model) === resident.model)) {
          await assertOwned();
          if (Date.now() >= deadline) throw new Error('Resident reset did not settle');
          await sleep(250);
        }
      }
      const remaining = () => resident.keepAlive === -1 ? -1 : Math.max(1, Math.ceil((new Date(resident.expiresAt) - Date.now()) / 1000));
      const options = { keepAlive: remaining(), contextSize: resident.contextLength,
        numThread: await require('../pinThreadLookup').pinNumThread(host, resident.model) };
      const started = Date.now();
      let r = await warmDefaultModel(host, resident.model, options);
      if (r.status === 'ok' && options.keepAlive !== -1 && Date.now() - started > 1000) {
        await assertOwned(); r = await warmDefaultModel(host, resident.model, { ...options, keepAlive: remaining() });
      }
      if (r.status !== 'ok') throw new Error('GPU resident restoration failed');
    }
    await assertOwned();
    const running = await fetchRunningModelInfosStrict(host);
    if (running.length !== residents.length || !residents.every(target => {
      const actual = running.find(x => (x.name || x.model) === target.model);
      return actual && actual.digest === target.digest && Number(actual.size) === target.artifactSize
        && actual.context_length === target.contextLength && placementRestored(target, actual)
        && benchmarkResidentExpiryMatches(target, actual);
    })) throw new Error('GPU resident restoration is unverified');
  }
}

async function reserve(config, operation, save, isCancelled) {
  if (operation.workerUrl && operation.workerUrl !== config.workerUrl) {
    throw new Error('Image operation is bound to its original worker');
  }
  const end = Date.now() + config.drainMs;
  let lease;
  do {
    if (await isCancelled()) throw Object.assign(new Error('Image request cancelled'), { cancelled: true });
    lease = await coordination.acquireWorkload({ principal: PRINCIPAL, requestId: operation._id,
      workloadId: operation._id, kind: 'images',
      hosts: [config.workerUrl, ...config.ollamaHosts].filter(Boolean), ttl: 120000 });
    if (lease.acquired) break;
    if (Date.now() >= end) throw new Error('GPU occupé. Fais une nouvelle demande quand il sera disponible.');
    await sleep(1000);
  } while (true);
  let lost = false, version = lease.recoveryVersion;
  const proof = { id: lease.admissionId, generation: lease.generation, principal: PRINCIPAL };
  const recovery = { recoveryId: lease.recoveryId, recoveryGeneration: lease.recoveryGeneration, principal: PRINCIPAL };
  const assertOwned = async () => {
    if (lost || !(await coordination.assertWorkloadAdmission({ ...proof, workloadId: operation._id })).admitted) {
      throw new Error('Image GPU reservation lost; recovery is required');
    }
  };
  const timer = setInterval(() => {
    coordination.heartbeat('workload', { ...proof, ttl: 120000 })
      .then(r => { if (!r.heartbeat) lost = true; }).catch(() => { lost = true; });
  }, 20000);
  timer.unref();
  const transition = async (state, receipt) => {
    await assertOwned();
    const r = await coordination.transitionWorkloadRecovery({ ...recovery, expectedVersion: version, state,
      receipt: { contract: 'agentx.image-runtime/v1', operationId: operation._id, ...receipt } });
    if (!r.transitioned) throw new Error('Image GPU recovery journal update refused');
    version = r.recoveryVersion;
  };
  const snapshots = {};
  let mutated = false;
  try {
    await save({ admission: lease });
    for (const host of config.ollamaHosts) {
      await assertOwned(); snapshots[host] = await captureBenchmarkRuntime(host);
    }
    await save({ snapshot: snapshots });
    await transition('MUTATING', { snapshots }); mutated = true;
    for (const [host, snap] of Object.entries(snapshots)) {
      for (const resident of snap.residents) {
        await assertOwned();
        const r = await unloadModel(host, resident.model);
        if (r.status !== 'ok') throw new Error('Unable to unload a GPU resident');
      }
      // Ollama acknowledges scheduling unload before /api/ps loses the runner.
      // Observe settlement under the same fence; an acknowledgement is not enough.
      const deadline = Date.now() + 15000;
      while (true) {
        await assertOwned();
        const running = await fetchRunningModelInfosStrict(host);
        if (!running.length) break;
        if (Date.now() >= deadline || running.some(x => !snap.residents.some(r => r.model === (x.name || x.model)))) {
          throw new Error('GPU residents were not unloaded');
        }
        await sleep(250);
      }
    }
  } catch (error) {
    clearInterval(timer);
    if (!mutated) {
      const released = await coordination.release('workload', proof);
      if (!released.released) mutated = true;
    }
    // A failed unload can still be in flight. Keep the durable reservation.
    throw Object.assign(error, { runtimeUnknown: mutated });
  }
  async function restore() {
    await restoreSnapshots(snapshots, assertOwned);
    await transition('RESTORED', { residentsRestored: true });
    const released = await coordination.resolveWorkloadRecovery(recovery);
    if (!released.released) throw new Error('Image GPU reservation release is unverified');
    clearInterval(timer);
  }
  return { assertOwned, verified: receipt => transition('VERIFIED', receipt), restore,
    quarantine: async reason => {
      clearInterval(timer);
      await transition('UNKNOWN', { reason }).catch(() => {});
    } };
}
module.exports = { reserve, restoreSnapshots, PRINCIPAL };
