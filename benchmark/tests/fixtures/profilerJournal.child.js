'use strict';

// Disposable Benchmark profiler writer. The run journal, mutation observation,
// HostProfile model and MongoDB are real; the Core admission that normally
// provides the recovery identity is a fixture. The parent kills this process
// at the boundary named by PROFILER_CRASH_AT and never lets it finish.
const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('../../config/logger', { info() {}, warn() {}, error() {}, debug() {} });
stub('../../src/helpers/ollamaHostConfig', { getConfiguredHosts: () => [] });
stub('../../src/helpers/ollamaTargetAdmission', { admitOllamaTargetResolved: async url => url });
stub('../../src/clients/coreApiClient', {
  getWorkloadRecoveryIdentity: () => ({ recoveryId: 'recovery-v8', recoveryRequestId: 'request-v8' })
});

const mongoose = require('mongoose');
const { createRunJournal } = require('../../src/services/profiler/profilerRunJournal');
const { observeJsonMutation } = require('../../src/services/profiler/profilerMutationObservation');

const phase = process.env.PROFILER_CRASH_AT;
const host = { hostId: 'fixture', hostUrl: process.env.PROFILER_OLLAMA_URL, modelName: 'fixture:1' };
const send = event => process.send?.({ event });
const hold = () => new Promise(() => {});
const post = async (url, body) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`fixture peer ${response.status}`);
  return response.json();
};

(async () => {
  await mongoose.connect(process.env.PROFILER_MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  if (phase === 'before-journal') { send('boundary'); return hold(); }
  const lease = {
    operationId: 'profile-v8', signal: new AbortController().signal,
    assertActive() {}, assertDispatchActive: async () => true, attachReconciliation() {},
    abandon: async () => ({ abandoned: true }),
    authorityProof: () => ({ admissionId: 'admission-v8', generation: 'generation-v8', principal: 'benchmark-service' })
  };
  const journal = await createRunJournal(lease, host);
  if (phase === 'after-journal') { send('boundary'); return hold(); }
  // after-dispatch: the parent kills this process when Ollama receives the request.
  await journal.run(() => observeJsonMutation(() => post(`${host.hostUrl}/api/generate`, { model: host.modelName })), host.modelName);
  if (phase === 'after-terminal') { send('boundary'); return hold(); }
  await journal.beforeWorkloadRelease({ failed: 0, details: [{ runtimeRestore: { verified: true } }] });
  await post(process.env.PROFILER_CORE_RELEASE_URL, { workloadId: lease.operationId });
  if (phase === 'after-release') { send('boundary'); return hold(); }
  throw new Error(`Unknown crash boundary: ${phase}`);
})().catch(error => {
  send(`error:${error.message}`);
  process.exit(1);
});
