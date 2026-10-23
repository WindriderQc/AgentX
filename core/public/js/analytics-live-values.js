'use strict';
// Shared projections for the Analytics view and its Core presentation receipt.
(function (root) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function runtimeView(data, now = Date.now()) {
    if (!Array.isArray(data?.inferences) || !Array.isArray(data?.workloads)) return null;
    const known = data.inferences.filter(row => row.active === true && !row.quarantined && Date.parse(row.expiresAt) > now);
    return { active: known, uncertain: data.inferences.length - known.length, workloads: data.workloads.length, maintenance: Boolean(data.maintenance) };
  }

  function gpuRows(hosts, elapsedMs = 0) {
    const seen = new Set(), rows = [];
    for (const host of hosts || []) {
      if (host.residency === 'cpu') continue;
      const telemetry = host.telemetry || {};
      const age = telemetry.ageMs == null ? null : telemetry.ageMs + elapsedMs;
      const fresh = telemetry.status === 'fresh' && finite(age) && finite(telemetry.staleAfterMs) && age <= telemetry.staleAfterMs;
      if (!fresh || !host.gpus?.length) {
        rows.push({ label: host.hostname || host.hostId, fresh: false, state: telemetry.status === 'fresh' ? 'stale' : telemetry.status || 'unavailable' });
        continue;
      }
      for (const gpu of host.gpus) {
        const key = `${telemetry.collectorHostId || host.hostId}:${gpu.busId || gpu.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ ...gpu, label: `${host.hostname || host.hostId} / GPU ${gpu.index ?? '?'}`, fresh: true, age });
      }
    }
    return rows;
  }

  const api = Object.freeze({ runtimeView, gpuRows });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentXAnalyticsLiveValues = api;
})(typeof window === 'undefined' ? globalThis : window);
