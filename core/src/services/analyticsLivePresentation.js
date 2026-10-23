'use strict';

const { runtimeView, gpuRows } = require('../../public/js/analytics-live-values');
const CONTRACT = 'agentx.presentation-read/v1';
const LIVE_TTL_MS = 30000;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) : '';
function base(source, now, ttl = LIVE_TTL_MS) {
  return { contract: CONTRACT, page: 'analytics', source, observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(), scope: 'live; independent of historical window' };
}

function runtimeSnapshot(data, now) {
  const view = runtimeView(data, now);
  if (!view) return null;
  const counts = new Map();
  for (const row of view.active) {
    const model = clean(row.model) || 'Unknown model';
    counts.set(model, (counts.get(model) || 0) + 1);
  }
  return { ...base('analytics.live.runtime', now),
    active: view.active.length, uncertain: view.uncertain, workloads: view.workloads, maintenance: view.maintenance,
    byModel: [...counts].slice(0, 40).map(([model, calls]) => ({ model, calls })),
    modelCount: counts.size, units: { active: 'admissions', uncertain: 'admissions', workloads: 'workloads', calls: 'admissions' },
    limits: ['Core admissions are not GPU utilization. Quarantined, expired or malformed admissions remain uncertain.',
      'No prompts, session identifiers, host addresses or workload payloads are included. Up to 40 model rows.'] };
}

function gpuSnapshot(data, now) {
  if (!Array.isArray(data)) return null;
  const rows = gpuRows(data);
  // Do not extend the collector freshness window just because this API was read.
  const remaining = data.filter(host => host.residency !== 'cpu' && host.telemetry?.status === 'fresh'
      && number(host.telemetry?.staleAfterMs) !== null && number(host.telemetry?.ageMs) !== null
      && host.telemetry.ageMs <= host.telemetry.staleAfterMs && host.gpus?.length)
    .map(host => Math.max(0, host.telemetry.staleAfterMs - host.telemetry.ageMs));
  return { ...base('analytics.live.gpus', now, Math.min(LIVE_TTL_MS, ...remaining)),
    gpus: rows.slice(0, 32).map((row, i) => ({ label: 'GPU ' + (i + 1), fresh: row.fresh,
      state: row.fresh ? 'fresh' : clean(row.state),
      ...(row.fresh && { name: clean(row.name), ageMs: number(row.age),
        utilization: number(row.utilization) === null ? null : Math.max(0, Math.min(100, row.utilization)),
        vramUsed: number(row.vramUsed), vramTotal: number(row.vramTotal), powerDraw: number(row.powerDraw) }) })),
    count: rows.length, listed: Math.min(rows.length, 32),
    units: { utilization: 'percent', vramUsed: 'MiB', vramTotal: 'MiB', powerDraw: 'W', ageMs: 'ms' },
    limits: ['Only fresh collector evidence supplies measurements; stale/unavailable GPUs have no numeric values.',
      'CPU endpoints are excluded and GPU aliases deduplicated. Labels are anonymized; no host inventory is shared. Up to 32 rows.'] };
}
module.exports = { runtimeSnapshot, gpuSnapshot, LIVE_TTL_MS };
