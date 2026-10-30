'use strict';
const contract = require('./transcriptionContract');
const coordination = require('./runtimeCoordinationService');
const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const { resourceTopology, resourcesFor, overlaps } = require('./runtimePhysicalResources');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
let cached, pending;
function machine(base) {
  const hostname = new URL(base).hostname;
  const host = getConfiguredHosts().find(item => new URL(item.url).hostname === hostname);
  return { name: host?.name || hostname, hostname };
}
async function read(base, path) {
  const response = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw Error('unavailable');
  const text = await response.text();
  if (Buffer.byteLength(text) > 128 * 1024) throw Error('oversized');
  return JSON.parse(text);
}
async function snapshot() {
  const observedAt = new Date().toISOString();
  let cfg;
  try { cfg = contract.config(); }
  catch (error) { return { observedAt, configured: false, message: error.message }; }
  const [models, health, capability, runtime] = await Promise.allSettled([
    read(cfg.base, '/v1/models'), read(cfg.base, '/health'),
    read(cfg.base, '/v1/audio/long-transcriptions/capabilities'),
    coordination.listActive()
  ]);
  const value = item => item.status === 'fulfilled' ? item.value : null;
  const catalog = value(models), h = value(health), cap = value(capability);
  const model = catalog?.data?.find(row => row.id === catalog.default) || null;
  const configuredModel = typeof catalog?.default === 'string' ? catalog.default.split(/[\\/]/).filter(Boolean).pop() : null;
  const hosts = cfg.hosts.map(hostUrlKey), resourceIds = resourcesFor(resourceTopology(), hosts);
  const state = value(runtime);
  const relevant = item => hosts.some(host => overlaps(item, host, resourceIds));
  const maintenance = state?.maintenance;
  const blockers = state ? [
    ...(maintenance && (!maintenance.hosts.length || relevant(maintenance)) ? [{ type: 'maintenance', uncertain: maintenance.quarantined }] : []),
    ...state.workloads.filter(relevant).map(item => ({ type: 'workload', kind: item.kind, uncertain: item.recoveryRequired })),
    ...state.inferences.filter(relevant).map(item => ({ type: 'inference', uncertain: item.quarantined }))
  ] : null;
  return {
    observedAt, configured: true,
    configuration: { machine: machine(cfg.base), model: configuredModel, device: model?.configured_device || null,
      computeType: model?.configured_compute_type || null, modelSelectionSupported: false, reservationMinutes: cfg.minutes },
    service: { reachable: Boolean(h), ready: Boolean(h?.recognition?.available && cap?.durable), degraded: h?.recognition?.degraded ?? null,
      activity: cap?.observation ? { observedAt: cap.observation.observedAt, jobs: cap.observation.activeJobs } : null },
    limits: cap ? { maxSeconds: cap.maxSeconds ?? null, maxDownloadBytes: cap.maxDownloadBytes ?? null,
      maxDecodedBytes: cap.maxDecodedBytes ?? null, effectiveDownloadBytes: cap.effectiveDownloadBytes ?? null,
      reserveDiskBytes: cap.reserveDiskBytes ?? null } : null,
    coordination: { available: Boolean(state), blockers }
  };
}
async function status() {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!pending) pending = snapshot().then(value => {
    cached = { value, expiresAt: Date.now() + 5000 }; return value;
  }).finally(() => { pending = null; });
  return pending;
}
module.exports = { status, snapshot, machine };
