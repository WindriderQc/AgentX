'use strict';

const WINDOWS = Object.freeze({ '6h': 6, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 });
const MEASURES = Object.freeze(['power', 'current', 'voltage', 'energy']);

function rangeFor(raw, now = new Date()) {
  const window = Object.hasOwn(WINDOWS, raw) ? raw : '24h';
  const to = new Date(now);
  return { window, from: new Date(to.getTime() - WINDOWS[window] * 3_600_000), to };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentile(values, ratio) {
  const sorted = values.map(finite).filter(value => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function seriesFromHistory(history, key) {
  const measure = history?.measures?.[key];
  return (measure?.points || []).map(point => ({
    at: point.ts,
    value: finite(point.median ?? point.mean),
    min: finite(point.min),
    max: finite(point.max),
    partial: point.partial === true
  })).filter(point => point.value !== null && Number.isFinite(Date.parse(point.at)));
}

function latestFromLive(live, key) {
  const rows = live?.measures?.[key]?.points || [];
  const point = rows.at(-1);
  return point && finite(point.value) !== null ? { value: finite(point.value), at: point.ts || point.at || null } : null;
}

function normalizeInference(row) {
  const endMs = new Date(row.timestamp).getTime();
  if (!Number.isFinite(endMs)) return null;
  const durationMs = Math.max(0, finite(row.durationMs) || 0);
  return {
    id: String(row._id), kind: 'inference', label: row.callerDetail || row.taskType || row.caller || 'Inférence',
    host: row.hostKey || row.host || null, model: row.model || null, status: row.status || 'unknown',
    startAt: new Date(endMs - durationMs).toISOString(), endAt: new Date(endMs).toISOString(), durationMs,
    correlationId: row.correlationId || null
  };
}

function normalizeOperation(row) {
  const startMs = Date.parse(row.startedAt || '');
  const endMs = Date.parse(row.finishedAt || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return {
    id: row.requestId, kind: 'automation', label: row.jobName || row.jobId || 'Automatisation',
    host: row.hostLabel || null, model: null, status: row.state || 'unknown',
    startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString(), durationMs: endMs - startMs,
    correlationId: row.requestId
  };
}

function overlaps(a, b) {
  return Date.parse(a.startAt) < Date.parse(b.endAt) && Date.parse(b.startAt) < Date.parse(a.endAt);
}

function attribute(events, power, baselineW, bucketSeconds) {
  return events.map(event => {
    const start = Date.parse(event.startAt);
    const end = Date.parse(event.endAt);
    const samples = power.filter(point => {
      const at = Date.parse(point.at);
      return at >= start && at <= end;
    });
    const avgW = samples.length ? samples.reduce((sum, point) => sum + point.value, 0) / samples.length : null;
    const deltaW = avgW === null || baselineW === null ? null : Math.max(0, avgW - baselineW);
    const observedMs = samples.length * bucketSeconds * 1000;
    const coverage = event.durationMs ? Math.min(1, observedMs / event.durationMs) : 0;
    const concurrent = events.some(other => other !== event && overlaps(event, other));
    const confidence = !samples.length ? 'unavailable' : coverage < 0.65 || concurrent ? 'low' : coverage < 0.9 ? 'medium' : 'high';
    return { ...event, averageW: avgW, deltaW,
      estimatedWh: deltaW === null ? null : deltaW * event.durationMs / 3_600_000,
      sampleCount: samples.length, coverage, confidence };
  });
}

function cumulativeDelta(points) {
  if (points.length < 2) return null;
  const delta = points.at(-1).value - points[0].value;
  return delta >= 0 ? delta : null;
}

function compose({ history, live, inferences = [], inferenceCount, operations = [], range, deviceId }) {
  const power = seriesFromHistory(history, 'power');
  const current = seriesFromHistory(history, 'current');
  const voltage = seriesFromHistory(history, 'voltage');
  const energy = seriesFromHistory(history, 'energy');
  const baselineW = percentile(power.map(point => point.value), 0.25);
  const events = [...inferences.map(normalizeInference), ...operations.map(normalizeOperation)]
    .filter(Boolean).filter(event => Date.parse(event.endAt) >= range.from.getTime() && Date.parse(event.startAt) <= range.to.getTime())
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const bucketSeconds = finite(history?.bucketSeconds) || 60;
  const attributed = attribute(events, power, baselineW, bucketSeconds);
  const latest = Object.fromEntries(MEASURES.map(key => [key, latestFromLive(live, key) || seriesFromHistory(history, key).at(-1) || null]));
  return {
    contract: 'agentx.energy-observability/v1', deviceId, window: range.window,
    from: range.from.toISOString(), to: range.to.toISOString(), observedAt: new Date().toISOString(),
    freshness: latest.power?.at || power.at(-1)?.at || null,
    bucket: history?.bucket || null, bucketSeconds,
    latest, summary: { baselineW, energyKwh: cumulativeDelta(energy), eventCount: (inferenceCount ?? inferences.length) + operations.length,
      returnedEventCount: attributed.length,
      attributedWh: attributed.reduce((sum, event) => sum + (event.estimatedWh || 0), 0) },
    series: { power, current, voltage, energy }, events: attributed,
    methodology: { scope: 'shared_meter', exactPerProcess: false, baseline: 'lower_quartile_of_observed_power',
      note: 'Energy is measured for the configured shared meter. Event energy is an estimate above baseline and loses confidence when events overlap or samples are missing.' }
  };
}

module.exports = { WINDOWS, MEASURES, rangeFor, percentile, seriesFromHistory, normalizeInference, normalizeOperation, attribute, compose };
