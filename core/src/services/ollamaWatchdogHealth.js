'use strict';

// Process-local evidence, collected by the existing watchdog cycle only.
const stats = {
  probesSent: 0, probesOk: 0, probesFailed: 0, jamsDetected: 0, unjamsDone: 0,
  lastProbeAt: null, lastJamAt: null, history: []
};
const observations = new Map();

function recordEvent(type, host, details) {
  const event = {
    type, hostId: host.id, hostName: host.name, hostUrl: host.url,
    timestamp: new Date().toISOString(), ...details
  };
  stats.history.push(event);
  if (stats.history.length > 50) stats.history.shift();
  return event;
}

function observeHost(host, result, dispatched) {
  const state = observations.get(host.url) || { probesSent: 0, probesOk: 0, probesFailed: 0 };
  const now = new Date().toISOString();
  state.lastObservedAt = now;
  state.lastStatus = result.status || null;
  state.reason = result.reason || (result.mode === 'control-plane' ? 'control_plane_only' : 'probe_ok');
  state.health = result.ok && result.mode === 'loaded-model' ? 'ok'
    : result.reason === 'model_error' && result.status >= 500 && result.status < 600 ? 'error' : 'unknown';
  if (dispatched) {
    state.probesSent++;
    if (result.ok) state.probesOk++;
    else state.probesFailed++;
    state.lastProbeAt = now;
    state.lastResult = {
      ok: result.ok, mode: result.mode || null, status: result.status || null,
      reason: result.reason || null, model: result.model || null
    };
  }
  observations.set(host.url, state);
}

function hostSnapshots(hosts) {
  // Only currently configured hosts appear; snapshots cannot mutate evidence.
  return hosts.map(host => {
    const state = observations.get(host.url);
    return {
      hostId: host.id, hostName: host.name, hostUrl: host.url,
      probesSent: 0, probesOk: 0, probesFailed: 0,
      health: 'unknown', reason: 'not_observed', ...state,
      ...(state?.lastResult && { lastResult: { ...state.lastResult } })
    };
  });
}

module.exports = { stats, recordEvent, observeHost, hostSnapshots };
