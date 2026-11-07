'use strict';
// Worker lookups shared by the image service, the queue evidence and the
// workshop view. Kept free of dependencies so read-only views can use them.

// Raw manifests in older callers and tests have no workers list.
function workersOf(config) {
  if (Array.isArray(config?.workers)) return config.workers;
  return config?.workerUrl || config?.ollamaHosts ? [{ id: 'default', url: config.workerUrl, ollamaHosts: config.ollamaHosts || [] }] : [];
}
// The configuration seen by one worker. The reservation, queue and client code
// read workerUrl and ollamaHosts, so here they always name that worker.
function scoped(config, worker) {
  return { ...config, worker, workerUrl: worker.url, ollamaHosts: worker.ollamaHosts,
    minFreeVramRatio: worker.minFreeVramRatio ?? 0.75, releasedVramRatio: worker.releasedVramRatio ?? 0.85,
    ...(worker.presentation && { presentation: worker.presentation }) };
}
function workerFor(config, url) {
  const worker = workersOf(config).find(w => w.url === url);
  return worker ? scoped(config, worker) : null;
}
// Workers that may render a profile, in manifest order.
function candidates(config, profileId) {
  return workersOf(config).filter(w => !w.profiles || w.profiles.includes(profileId)).map(w => scoped(config, w));
}

module.exports = { workersOf, workerFor, candidates, scoped };
