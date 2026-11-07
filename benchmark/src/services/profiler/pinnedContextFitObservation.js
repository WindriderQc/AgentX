'use strict';
const { generate } = require('../../clients/ollamaClient');
const { resolveArtifactIdentity, resolveRuntimeArtifactReceipt, digestsMatch } = require('./artifactIdentityService');
const { loadHostPreference } = require('./contextProposalService');
const { snapshotGpuOffload } = require('../probeResidency');
const { stableSerialize, exactModelNamesMatch } = require('../../../../shared/artifactIdentity');

const fail = (message, code = 'PINNED_FIT_CHANGED') => Object.assign(new Error(message), { code, statusCode: 409 });
const pinSet = pref => (pref?.pinnedModels || []).map(pin => ({
  model: pin.model, contextSize: pin.contextSize || 0, keepAlive: pin.keepAlive ?? -1,
  autoRestore: pin.autoRestore !== false, ...(pin.numThread > 0 && { numThread: pin.numThread })
}));

async function assertTarget(row, signal) {
  const preference = await loadHostPreference(row.hostUrl);
  if (preference === undefined) throw fail('Core pins are unavailable', 'PINNED_FIT_PINS_UNKNOWN');
  if (stableSerialize(pinSet(preference)) !== stableSerialize(row.pins)) throw fail('The pinned set changed');
  const artifact = await resolveArtifactIdentity(row.model, row.hostId, row.hostUrl, { refresh: true, signal });
  if (!digestsMatch(artifact.digest, row.artifact.digest)
    || artifact.runtimeFingerprint !== row.artifact.runtimeFingerprint
    || !artifact.runtime?.ollamaVersion
    || artifact.runtime.ollamaVersion !== row.artifact.runtime.ollamaVersion
    || artifact.runtime?.gpuDriver !== row.artifact.runtime?.gpuDriver) throw fail('Artifact or runtime changed');
  return artifact;
}

function residentSetFits(pins, snapshot) {
  if (!Array.isArray(snapshot.coResidents)) return null;
  for (const pin of pins) {
    const resident = snapshot.coResidents.find(item => exactModelNamesMatch(item.model, pin.model));
    if (!resident || !(resident.size > 0) || resident.sizeVram === null) return null;
    if (resident.sizeVram !== resident.size) return false;
    if (pin.contextSize > 0 && resident.contextLength !== pin.contextSize) return null;
  }
  return true;
}

async function observeFit(row, lease, cancellation, { assertQueue } = {}) {
  const signal = AbortSignal.any([lease.signal, cancellation.signal]);
  await assertTarget(row, signal);
  await assertQueue();
  cancellation.assertNotCancelled();
  lease.assertActive();
  const pin = row.pins[row.pinIndex];
  // One bounded allocation/load, no context ladder or semantic qualification.
  const reply = await generate(row.hostUrl, {
    model: row.model, prompt: '', stream: false, keep_alive: pin.keepAlive,
    options: { num_ctx: row.numCtx, num_predict: 1, ...(pin.numThread > 0 && { num_thread: pin.numThread }) }
  }, { signal, timeoutMs: 60_000, benchmarkClaim: lease.identityFor(row.hostUrl) });
  if (reply?.done !== true) throw Object.assign(fail('Ollama returned no terminal load receipt', 'PINNED_FIT_RESPONSE_INCOMPLETE'), { retainAdmission: true });
  cancellation.assertNotCancelled();
  const native = await resolveRuntimeArtifactReceipt(row.model, row.hostId, row.hostUrl, { signal });
  const others = row.pins.filter((_, index) => index !== row.pinIndex);
  const first = await snapshotGpuOffload(row.hostUrl, row.model, signal);
  const second = await snapshotGpuOffload(row.hostUrl, row.model, signal);
  await assertTarget(row, signal);
  lease.assertActive();
  cancellation.assertNotCancelled();
  if (!digestsMatch(native.digest, row.artifact.digest) || native.runtimeVersion !== row.artifact.runtime.ollamaVersion
    || native.contextLength !== row.numCtx || first.contextLength !== row.numCtx || second.contextLength !== row.numCtx) {
    throw fail('The served artifact, runtime or context differs from the frozen pin');
  }
  const coResidentFit = [residentSetFits(others, first), residentSetFits(others, second)];
  const full = snapshot => snapshot.sizeTotal > 0 && snapshot.sizeVram === snapshot.sizeTotal;
  const known = snapshot => snapshot.sizeTotal > 0 && snapshot.sizeVram !== null;
  const unknown = !known(first) || !known(second) || coResidentFit.includes(null);
  const pass = !unknown && native.fullVram === true && full(first) && full(second) && coResidentFit.every(Boolean);
  return { status: unknown ? 'unknown' : pass ? 'pass' : 'fail', fullVram: unknown ? null : pass,
    native, coResidents: second.coResidents,
    reason: unknown ? 'Residency evidence is missing or partial' : pass ? null : 'CPU spill observed in the pinned set',
    scope: 'allocation_and_residency_at_exact_pinned_context',
    qualificationAuthority: 'none' };
}

module.exports = { pinSet, assertTarget, residentSetFits, observeFit, fail };
