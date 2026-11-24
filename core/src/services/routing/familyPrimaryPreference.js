'use strict';

// Offline decision prototype only: `identity` must come from the same native
// conflict snapshot as `failure`, never from caller input or public metadata.
const CONTRACT = 'agentx.runtime-inference-completion/v1';
const identities = new WeakMap();
const MATCH = ['host', 'admissionId', 'generation', 'principal', 'requestId'];
const exactIdentity = value => value && MATCH.every(key => typeof value[key] === 'string' && value[key].length > 0);

function rememberConflict(failure, holder, observedFrom) {
  if (exactIdentity(holder) && Number.isFinite(observedFrom)) {
    identities.set(failure, Object.freeze({ ...Object.fromEntries(MATCH.map(key => [key, holder[key]])), observedFrom }));
  }
  return failure;
}

function fromRefusal(error) {
  // The trusted runtime wrapper retains the original error in cause and
  // separately copies only the public diagnostic into its public failure.
  return identities.get(error?.cause?.failure) || identities.get(error?.failure);
}

async function readRelease(identity, signal, budget) {
  const collection = require('../../../models/RuntimeCoordination').collection;
  const query = Object.fromEntries(MATCH.map(key => [key, identity[key]]));
  const find = async () => {
    signal.throwIfAborted();
    const matcher = { ...query, contract: CONTRACT, coordinationKind: 'inference', released: true };
    const row = await collection.findOne(
      { _id: 'runtime', releaseReceipts: { $elemMatch: matcher } },
      { maxTimeMS: 100, signal, projection: { _id: 0, releaseReceipts: { $elemMatch: matcher } } }
    );
    return row?.releaseReceipts?.[0] || null;
  };
  const sleep = require('node:timers/promises').setTimeout;
  const start = performance.now();
  // At most two scoped reads, not a new scheduler or cross-process event.
  await sleep(Math.min(350, budget), undefined, { signal });
  const early = await find();
  if (early) return early;
  const remaining = budget - (performance.now() - start);
  if (remaining <= 120) return null;
  await sleep(remaining - 120, undefined, { signal });
  return find();
}

function matchesRelease(receipt, identity, startedAt, now) {
  const value = receipt?.releasedAt;
  const released = value instanceof Date ? value.getTime() : Date.parse(value);
  return receipt?.contract === CONTRACT && receipt?.coordinationKind === 'inference' && receipt.released === true
    && exactIdentity(identity) && MATCH.every(key => receipt[key] === identity[key])
    && Number.isFinite(released) && released >= startedAt && released <= now;
}

async function boundedProof(read, signal) {
  let listener;
  try {
    signal.throwIfAborted();
    return await Promise.race([
      Promise.resolve().then(() => read(signal)),
      new Promise(resolve => {
        listener = () => resolve(null);
        signal.addEventListener('abort', listener, { once: true });
      })
    ]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}

async function preferReleasedPrimary({
  scope, firstError, identity, readRelease, executePrimary, signal,
  isSafeRefusal, notify = () => {}, now = Date.now, windowMs = 1500,
  makeDeadline = ms => AbortSignal.timeout(ms)
}) {
  const fallback = error => ({ action: 'existing_fallback_decision', error });
  signal?.throwIfAborted();
  if (!scope?.enabled || scope.surface !== 'family' || scope.backend !== 'agentx' || scope.channel !== 'voice'
      || !exactIdentity(identity) || firstError?.code !== 'RUNTIME_INFERENCE_ADMISSION_DENIED'
      || firstError?.failure?.cause !== 'inference_active' || firstError.failure.safeToRetry !== true
      || firstError.failure.holder?.type !== 'inference') return fallback(firstError);
  const budget = Number.isFinite(windowMs) ? Math.max(1, Math.min(1800, windowMs)) : 1500;
  const startedAt = now();
  const deadline = makeDeadline(budget), proofSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try { notify({ stage: 'waiting_primary', cause: 'inference_active' }); } catch { /* No routing dependency on UI. */ }
  let receipt;
  try { receipt = await boundedProof(proofSignal => readRelease(identity, proofSignal, budget), proofSignal); } catch { /* No proof, do not retry. */ }
  signal?.throwIfAborted();
  const checkedAt = now();
  if (proofSignal.aborted || checkedAt - startedAt >= budget || !matchesRelease(receipt, identity, Math.min(startedAt, identity.observedFrom ?? startedAt), checkedAt)) return fallback(firstError);
  // Deadline belongs to the proof stage ONLY; never race an issued native call
  // against fallback. Its own sole native admission remains decisive.
  try {
    const result = await executePrimary(signal);
    if (!result || typeof result.ok !== 'boolean') throw Object.assign(Error('Unverified native result'), { code: 'INFERENCE_UPSTREAM_UNAVAILABLE' });
    return { action: 'primary', result };
  }
  catch (error) {
    signal?.throwIfAborted();
    if (!isSafeRefusal(error)) throw error;
    return fallback(error);
  }
}

module.exports = { preferReleasedPrimary, rememberConflict, fromRefusal, readRelease };
