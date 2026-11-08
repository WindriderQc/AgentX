'use strict';

const crypto = require('node:crypto');
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const HostPreference = require('../../models/HostPreference');
const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const { ensureDocument } = require('./runtimeCoordinationState');
const { resourceTopology, resourcesFor, topologyGuard, topologyMatches } = require('./runtimePhysicalResources');
const { hostname, matchingControl, pausedControl } = require('./hostControlFence');
const { hasActiveSessionHold } = require('./hostSessionHoldService');
const { hasActiveBenchmarkClaim } = require('./benchmarkClaimService');
const { fencesHost } = require('./runtimeDeployGate');

function fail(message, code = 'HOST_CONTROL_CONFLICT', statusCode = 409) {
  throw Object.assign(new Error(message), { code, statusCode });
}

// Include every configured lane of a machine, and aliases connected by physical
// resources. Recompute transitively: a pooled endpoint may use several devices.
function hostGroup(hostId) {
  const configured = getConfiguredHosts();
  const target = configured.find(host => host.id === hostId);
  if (!target) fail('Unknown inference host.', 'HOST_NOT_FOUND', 404);
  const topology = resourceTopology();
  const hosts = new Set([target.url]);
  let previous;
  do {
    previous = hosts.size;
    const names = new Set([...hosts].map(hostname));
    const ids = resourcesFor(topology, [...hosts]);
    for (const row of topology.resources) {
      if (ids.includes(row.id)) row.endpoints.forEach(url => hosts.add(url));
    }
    for (const host of configured) if (names.has(hostname(host.url))) hosts.add(host.url);
  } while (hosts.size !== previous);
  return { hosts: [...hosts].sort(), hostnames: [...new Set([...hosts].map(hostname))].sort(),
    resourceIds: resourcesFor(topology, [...hosts]), topology };
}

function covers(control, item) {
  return Boolean(pausedControl([control], [item.host, ...(item.hosts || [])].filter(Boolean), item.resourceIds || []));
}

function projectControl(control, state, preferences = []) {
  if (!control) return { state: 'playing', revision: 0, pauseId: null, blockers: [] };
  const common = { revision: control.revision, pauseId: control.pauseId,
    pausedAt: control.acquiredAt, hosts: control.hosts, active: control.active };
  if (!control.active) return { ...common, state: 'playing', blockers: [] };
  const blockers = [];
  for (const item of state.inferences || []) if (covers(control, item)) {
    blockers.push({ type: 'inference', kind: item.kind, recoveryRequired: item.state === 'UNKNOWN' });
  }
  for (const item of state.workloads || []) if (!(item.hosts || []).length || covers(control, item)) {
    blockers.push({ type: 'workload', kind: item.kind, recoveryRequired: item.recoveryState === 'UNKNOWN' });
  }
  if (state.maintenance && control.hosts.some(host => fencesHost(state.maintenance, host, control.resourceIds))) {
    blockers.push({ type: 'maintenance', recoveryRequired: state.maintenance.state === 'UNKNOWN' });
  }
  for (const pref of preferences) if (covers(control, { host: pref.hostUrl })) {
    if (hasActiveSessionHold(pref)) blockers.push({ type: 'session', expiresAt: pref.sessionHold.expiresAt });
    if (hasActiveBenchmarkClaim(pref)) blockers.push({ type: 'benchmark', recoveryRequired: false });
  }
  return { ...common, state: blockers.length ? 'draining' : 'paused', blockers };
}

async function readControls() {
  const [state, preferences] = await Promise.all([
    RuntimeCoordination.findById('runtime').lean(),
    HostPreference.find({}).select('hostUrl sessionHold.holdId sessionHold.model sessionHold.expiresAt status benchmarkClaim.batchId').lean()
  ]);
  return { state: state || {}, preferences };
}

async function listHostControls(hosts) {
  const { state, preferences } = await readControls();
  const topology = resourceTopology();
  return hosts.map(host => ({ ...host, control: projectControl(
    matchingControl(state.hostControls, [host.url], resourcesFor(topology, [host.url])), state, preferences) }));
}

async function changeHostControl(hostId, body = {}) {
  const { action, requestId, expectedRevision } = body;
  if (Object.keys(body).some(key => !['action', 'requestId', 'expectedRevision'].includes(key))
    || !['pause', 'play'].includes(action) || typeof requestId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(requestId)
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail('action, requestId and a non-negative expectedRevision are required.', 'HOST_CONTROL_INVALID', 400);
  }
  const group = hostGroup(hostId);
  await ensureDocument();
  const state = await RuntimeCoordination.findById('runtime').lean();
  const current = matchingControl(state.hostControls, group.hosts, group.resourceIds);
  if (current?.requestId === requestId) {
    if (current.action !== action || current.revision !== expectedRevision + 1) fail('Request identity already has another intent.');
    return (await listHostControls([{ id: hostId, url: group.hosts[0] }]))[0].control;
  }
  if ((current?.revision || 0) !== expectedRevision) fail('Host control changed. Refresh before trying again.');
  if (Boolean(current?.active) === (action === 'pause')) fail('Host is already in the requested state.');
  if (!topologyMatches(state, group.topology)) fail('Physical resource mapping changed while work remains held.');
  // A retained request identity cannot be reused on another host.
  if ((state.hostControls || []).some(row => row.requestId === requestId)) fail('Request identity already belongs to another host.');
  const next = { key: current?.key || crypto.randomUUID(), pauseId: action === 'pause' ? crypto.randomUUID() : current.pauseId,
    hosts: group.hosts, hostnames: group.hostnames, resourceIds: group.resourceIds,
    active: action === 'pause', action, requestId, revision: expectedRevision + 1,
    acquiredAt: action === 'pause' ? new Date() : current.acquiredAt };
  // Pause stores only a dispatch fence: it neither unloads a model nor cancels
  // another owner. Existing proof-bound work drains through its native owner.
  const updated = await RuntimeCoordination.findOneAndUpdate({
    _id: 'runtime', ...topologyGuard(group.topology),
    hostControls: state.hostControls || { $exists: false }
  }, { $set: { hostControls: [...(state.hostControls || []).filter(row => row.key !== next.key), next],
    resourceTopologyHash: group.topology.hash } }, { new: true }).lean();
  if (!updated) fail('Host control changed. Refresh to reconcile the original request.');
  if (action === 'play') require('./hostHealthDaemon').requestReconcile();
  const { state: fresh, preferences } = await readControls();
  return projectControl(next, fresh, preferences);
}

module.exports = { changeHostControl, listHostControls, readControls, projectControl, hostGroup };
