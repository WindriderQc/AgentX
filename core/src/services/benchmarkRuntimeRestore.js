'use strict';
const HostPreference = require('../../models/HostPreference');
const hostGate = require('./hostGate');
const { isOllamaPermanentExpiry } = require('../../../shared/ollamaResidency');
const { positiveInteger, fetchRunningModelInfosStrict, findLoadedModelInfo, readLoadedContextLength, pinNamesMatch, getWarmOrder } = require('./hostPinPrimitives');

const vramOf = entry => Number(entry?.size_vram ?? entry?.sizeVram);
const sizeOf = entry => Number(entry?.size ?? entry?.artifact_size ?? entry?.artifactSize);

// GPU placement rule (owner decision 2026-09-29): a resident that was wholly in
// VRAM before the claim must be wholly in VRAM again; one that already spilled
// may come back with a different GPU share. Exact byte equality cannot hold on
// a GPU shared with co-residents or non-Ollama processes, and demanding it left
// hosts claimed and reloading forever (#50, #145). A CPU host's residents
// must come back with no VRAM share at all.
function placementRestored(target, entry, residency = 'gpu') {
  const observed = vramOf(entry);
  if (!Number.isFinite(observed) || observed < 0) return false;
  if (residency === 'cpu') return observed === 0;
  const wasWhollyOnGpu = vramOf(target) >= Number(target.artifactSize);
  return wasWhollyOnGpu ? observed >= sizeOf(entry) : true;
}

async function restoreBenchmarkRuntime(hostUrl, snapshot, benchmarkClaim, { warmDefaultModel, unloadModel, benchmarkRuntimeSnapshotIdentity,
  benchmarkResidentExpiryMatches, desiredBenchmarkResidents }) {
  const residency = require('../helpers/hostResidency').hostResidency(hostUrl);
  const snapshotIdentityValid = /^[a-f0-9]{64}$/i.test(String(snapshot?.identityDigest || ''))
    && snapshot.identityDigest === benchmarkRuntimeSnapshotIdentity(snapshot);
  const residentsComplete = Array.isArray(snapshot?.residents)
    && snapshot.residents.every(entry => typeof entry?.model === 'string'
      && typeof entry?.digest === 'string'
      && entry.digest.trim()
      && Number.isFinite(Number(entry?.artifactSize))
      && Number(entry.artifactSize) > 0
      && Number.isFinite(Number(entry?.sizeVram))
      && Number(entry.sizeVram) >= 0
      && positiveInteger(entry?.contextLength));
  if (!snapshot || snapshot.exact !== true || !snapshotIdentityValid || !residentsComplete) {
    return {
      host: hostUrl,
      status: 'error',
      code: 'BENCHMARK_RUNTIME_SNAPSHOT_MISSING',
      verified: false,
      degraded: true,
      error: 'Exact pre-claim runtime snapshot is unavailable'
    };
  }

  const assertFence = async () => {
    benchmarkClaim?.assertAuthorityActive?.();
    if (benchmarkClaim?.signal?.aborted) {
      throw benchmarkClaim.signal.reason instanceof Error
        ? benchmarkClaim.signal.reason
        : Object.assign(new Error('Benchmark finalizer fence was aborted'), { code: 'BENCHMARK_CLAIM_LOST' });
    }
    const current = await HostPreference.findOne(
      { hostUrl },
      null,
      benchmarkClaim?.signal ? { signal: benchmarkClaim.signal } : undefined
    ).lean();
    if (current?.status !== 'benchmarking'
      || current?.benchmarkClaim?.batchId !== benchmarkClaim?.batchId
      || current?.benchmarkClaim?.claimGeneration !== benchmarkClaim?.claimGeneration
      || (benchmarkClaim?.finalizeToken
        && current?.benchmarkClaim?.finalizeToken !== benchmarkClaim.finalizeToken)) {
      const error = new Error('Benchmark claim no longer owns the host while restoring runtime');
      error.code = 'BENCHMARK_CLAIM_LOST';
      throw error;
    }
  };

  const desired = benchmarkClaim?.snapshotAlreadyFiltered === true
    ? (snapshot?.residents || [])
    : desiredBenchmarkResidents(snapshot);
  const desiredNames = desired.map(entry => entry.model);
  let running = await fetchRunningModelInfosStrict(hostUrl, 5_000, { signal: benchmarkClaim?.signal });
  await assertFence();
  if (await hostGate.hostHasInflightAnywhere(hostUrl)) return {
    host: hostUrl, status: 'busy', verified: false, degraded: false,
    error: 'Cannot restore pre-claim runtime while host inference is active'
  };

  for (const entry of running) {
    const loaded = entry.name || entry.model;
    if (desired.some(target => pinNamesMatch(target.model, loaded))) continue;
    if (hostGate.inFlightFor(hostUrl, loaded) > 0) {
      return {
        host: hostUrl,
        status: 'busy',
        verified: false,
        degraded: false,
        error: `Cannot restore pre-claim runtime while ${loaded} has active inference`
      };
    }
    await assertFence();
    const unloaded = await unloadModel(hostUrl, loaded, {
      signal: benchmarkClaim?.signal,
      assertAuthorityActive: benchmarkClaim?.assertAuthorityActive
    });
    if (unloaded.status !== 'ok') {
      return {
        host: hostUrl,
        status: 'error',
        verified: false,
        degraded: false,
        error: `Failed to unload post-claim resident ${loaded}: ${unloaded.error}`
      };
    }
  }

  const restoreTarget = async (target, forceReload = false) => {
    await assertFence();
    if (await hostGate.hostHasInflightAnywhere(hostUrl)) return {
      host: hostUrl, status: 'busy', verified: false, degraded: false,
      error: 'Cannot restore pre-claim runtime while host inference is active'
    };
    running = await fetchRunningModelInfosStrict(hostUrl, 5_000, { signal: benchmarkClaim?.signal });
    const loaded = findLoadedModelInfo(running, target.model);
    const loadedCtx = readLoadedContextLength(loaded);
    if (loaded && (forceReload || (target.contextLength && loadedCtx !== target.contextLength))) {
      const unloaded = await unloadModel(hostUrl, loaded.name || loaded.model || target.model, {
        signal: benchmarkClaim?.signal,
        assertAuthorityActive: benchmarkClaim?.assertAuthorityActive
      });
      if (unloaded.status !== 'ok') {
        return {
          host: hostUrl,
          status: 'error',
          verified: false,
          degraded: false,
          error: `Failed to reset ${target.model} to pre-claim context: ${unloaded.error}`
        };
      }
    }
    // Interpret snapshots captured by older Product builds too: Ollama 0.33.x
    // exposes its permanent sentinel near year 2318, so the stored numeric
    // delta may be huge even though the requested policy was keep_alive=-1.
    const remainingKeepAlive = target.keepAlive === -1
      || isOllamaPermanentExpiry(target.expiresAt, Date.now())
      ? -1
      : Math.max(1, Math.ceil((new Date(target.expiresAt).getTime() - Date.now()) / 1000));
    const warmStartedAt = Date.now();
    const warmOptions = {
      keepAlive: remainingKeepAlive,
      contextSize: target.contextLength || 0,
      signal: benchmarkClaim?.signal,
      assertAuthorityActive: benchmarkClaim?.assertAuthorityActive
    };
    let warmed = await warmDefaultModel(hostUrl, target.model, warmOptions);
    // Ollama starts keep_alive after loading. Reset a finite deadline once the
    // model is warm so a slow reload does not extend the captured lifetime.
    const remainingAfterLoad = Math.ceil((new Date(target.expiresAt).getTime() - Date.now()) / 1000);
    if (warmed.status === 'ok' && remainingKeepAlive !== -1
      && Date.now() - warmStartedAt > 1_000 && remainingAfterLoad > 0) {
      await assertFence();
      warmed = await warmDefaultModel(hostUrl, target.model, {
        ...warmOptions,
        keepAlive: remainingAfterLoad
      });
    }
    if (warmed.status !== 'ok') {
      return {
        host: hostUrl,
        status: 'error',
        verified: false,
        degraded: false,
        error: `Failed to restore pre-claim resident ${target.model}: ${warmed.error}`
      };
    }
    return null;
  };
  for (const target of getWarmOrder(desired)) {
    const failure = await restoreTarget(target);
    if (failure) return failure;
  }

  await assertFence();
  let verifiedRunning;
  let verified = false;
  for (let verificationPass = 0; verificationPass < 2; verificationPass += 1) {
    await assertFence();
    verifiedRunning = await fetchRunningModelInfosStrict(hostUrl, 5_000, { signal: benchmarkClaim?.signal });
    const noExtraResidents = verifiedRunning.every(entry => desired.some(target =>
      pinNamesMatch(target.model, entry.name || entry.model)
    ));
    const residentsVerified = desired.every((target) => {
      const entry = findLoadedModelInfo(verifiedRunning, target.model);
      if (!entry) return false;
      return String(entry.digest || '').trim() === String(target.digest || '').trim()
        && sizeOf(entry) === Number(target.artifactSize)
        && placementRestored(target, entry, residency)
        && readLoadedContextLength(entry) === target.contextLength
        && benchmarkResidentExpiryMatches(target, entry);
    });
    verified = noExtraResidents
      && residentsVerified
      && verifiedRunning.length === desired.length;
    if (verified) break;
    // Every earlier warm completed with a terminal receipt. Retry restoration
    // once for observed residency mismatch, never for an interrupted warm or
    // an unexpected extra resident that could belong to concurrent execution.
    const retryableResidencyMismatch = desired.some(target => {
      const entry = findLoadedModelInfo(verifiedRunning, target.model);
      return !entry || readLoadedContextLength(entry) !== target.contextLength
        || !placementRestored(target, entry, residency);
    });
    if (verificationPass === 0 && noExtraResidents && retryableResidencyMismatch) {
      for (const target of getWarmOrder(desired)) {
        const failure = await restoreTarget(target, true);
        if (failure) return failure;
      }
    } else break;
  }
  if (!verified) {
    return {
      host: hostUrl,
      status: 'error',
      verified: false,
      degraded: false,
      error: 'Pre-claim runtime restore did not verify the resident model/context set and GPU placement',
      expectedResidents: desiredNames,
      runningResidents: verifiedRunning.map(entry => entry.name || entry.model).filter(Boolean)
    };
  }

  const updated = await HostPreference.findOneAndUpdate(
    {
      hostUrl,
      status: 'benchmarking',
      'benchmarkClaim.batchId': benchmarkClaim.batchId,
      'benchmarkClaim.claimGeneration': benchmarkClaim.claimGeneration,
      ...(benchmarkClaim.finalizeToken
        ? { 'benchmarkClaim.finalizeToken': benchmarkClaim.finalizeToken }
        : {})
    },
    { $set: {
      loadedModel: desiredNames[0] || null,
      loadedModels: desiredNames
    } },
    { new: true, ...(benchmarkClaim?.signal ? { signal: benchmarkClaim.signal } : {}) }
  ).lean();
  if (!updated) {
    const error = new Error('Benchmark claim changed after runtime restore verification');
    error.code = 'BENCHMARK_CLAIM_LOST';
    throw error;
  }
  const observedResidents = verifiedRunning.map(entry => ({
    model: entry.name || entry.model,
    digest: entry.digest || null,
    artifactSize: Number(entry.size ?? entry.artifact_size ?? entry.artifactSize),
    sizeVram: Number(entry.size_vram ?? entry.sizeVram),
    contextLength: readLoadedContextLength(entry),
    expiresAt: entry.expires_at || entry.expiresAt || null
  }));
  // A spilled resident may come back with another GPU share; say so in the
  // receipt instead of hiding it.
  const placementDrift = desired
    .map(target => ({ target, entry: findLoadedModelInfo(verifiedRunning, target.model) }))
    .filter(({ target, entry }) => vramOf(entry) !== vramOf(target))
    .map(({ target, entry }) => ({ model: target.model, expectedVram: vramOf(target), observedVram: vramOf(entry) }));
  return {
    host: hostUrl,
    status: 'ready',
    verified: true,
    degraded: false,
    mode: 'exact_runtime_snapshot',
    snapshotIdentity: snapshot.identityDigest || benchmarkRuntimeSnapshotIdentity(snapshot),
    residents: desired,
    observedResidents,
    ...(placementDrift.length ? { placementDrift } : {})
  };
}

module.exports = { restoreBenchmarkRuntime };
