'use strict';

/**
 * GPU occupancy over a window, per physical GPU (#365), from the samples the
 * native gpu-agent stores in `hardware_gpu_samples`.
 *
 * A GPU is its collector host and its UUID (its index when no UUID was read).
 * Each sample stands for the time since the GPU's previous sample, up to one
 * and a half collector intervals; past that, samples were missed and the sample
 * stands for one interval only. Time no sample covers is reported as missing,
 * never as idle: busy share, mean utilization, mean power and throttled time
 * are shares of the time observed.
 */

const { HOSTS, SAMPLES, MAX_HOSTS, MAX_GPUS } = require('./hardwareTelemetryService');

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_WINDOW_MS = 24 * 3600_000;
const MAX_WINDOW_MS = 90 * 24 * 3600_000;
const DEFAULT_BUSY_AT_PCT = 10;
const PERCENTILES = [0.5, 0.95];
// Names decoded by the collector from clocks_throttle_reasons.active. Idle,
// application and display clocks are not throttling. The driver also reports
// the power cap on a card at rest (0 % utilization, idle power), where it slows
// nothing down: the power cap counts only while the GPU is busy.
const THROTTLE_CLASSES = Object.freeze({
  powerCap: ['sw_power_cap', 'hw_power_brake'],
  thermal: ['sw_thermal', 'hw_thermal'],
  hardware: ['hw_slowdown'],
});
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function parseDate(value, name) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw validationError(`${name} must be a date`);
  return date;
}

function occupancyQuery(raw = {}, now = new Date()) {
  const to = parseDate(raw.to, 'to') || now;
  const from = parseDate(raw.from, 'from') || new Date(to.getTime() - DEFAULT_WINDOW_MS);
  const windowMs = to.getTime() - from.getTime();
  if (windowMs <= 0 || windowMs > MAX_WINDOW_MS) throw validationError('from must precede to by at most 90 days');
  let busyAtPct = DEFAULT_BUSY_AT_PCT;
  if (raw.busyAtPct != null && raw.busyAtPct !== '') {
    busyAtPct = Number(raw.busyAtPct);
    if (!Number.isFinite(busyAtPct) || busyAtPct <= 0 || busyAtPct > 100) throw validationError('busyAtPct must be in (0, 100]');
  }
  const hostId = raw.hostId == null || raw.hostId === '' ? null : String(raw.hostId).trim();
  if (hostId !== null && !SAFE_ID.test(hostId)) throw validationError('hostId must be a stable identifier');
  return { from, to, windowMs, busyAtPct, hostId };
}

const isNumber = field => ({ $isNumber: field });
const coveredWhen = condition => ({ $sum: { $cond: [condition, '$coveredMs', 0] } });
const weighted = field => ({ $sum: { $cond: [isNumber(field), { $multiply: [field, '$coveredMs'] }, 0] } });
const throttledBy = reasons => ({
  $gt: [{ $size: { $setIntersection: [{ $ifNull: ['$throttleReasons', []] }, reasons] } }, 0]
});

function intervalExpression(intervals) {
  const branches = [...intervals].map(([hostId, intervalMs]) => ({ case: { $eq: ['$hostId', hostId] }, then: intervalMs }));
  return branches.length ? { $switch: { branches, default: DEFAULT_INTERVAL_MS } } : DEFAULT_INTERVAL_MS;
}

function buildOccupancyPipeline({ from, to, busyAtPct, hostId }, intervals = new Map()) {
  const busy = { $and: [isNumber('$utilizationPct'), { $gte: ['$utilizationPct', busyAtPct] }] };
  const throttled = {
    powerCap: { $and: [throttledBy(THROTTLE_CLASSES.powerCap), busy] },
    thermal: throttledBy(THROTTLE_CLASSES.thermal),
    hardware: throttledBy(THROTTLE_CLASSES.hardware),
  };
  return [
    { $match: { sampledAt: { $gte: from, $lte: to }, ...(hostId && { hostId }) } },
    { $set: {
      gpuKey: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$uuid', ''] } }, 0] }, '$uuid', { $concat: ['index:', { $toString: '$index' }] }] },
      intervalMs: intervalExpression(intervals),
    } },
    { $setWindowFields: {
      partitionBy: { hostId: '$hostId', gpuKey: '$gpuKey' },
      sortBy: { sampledAt: 1 },
      output: { previousAt: { $shift: { output: '$sampledAt', by: -1 } } },
    } },
    { $set: { gapMs: { $subtract: ['$sampledAt', { $ifNull: ['$previousAt', from] }] } } },
    { $set: { coveredMs: { $cond: [{ $lte: ['$gapMs', { $multiply: ['$intervalMs', 1.5] }] }, '$gapMs', '$intervalMs'] } } },
    { $group: {
      _id: { hostId: '$hostId', gpuKey: '$gpuKey' },
      gpu: { $top: { sortBy: { sampledAt: -1 }, output: { index: '$index', name: '$name', uuid: '$uuid', busId: '$busId' } } },
      samples: { $sum: 1 },
      firstSampleAt: { $min: '$sampledAt' },
      lastSampleAt: { $max: '$sampledAt' },
      observedMs: { $sum: '$coveredMs' },
      utilizationMs: coveredWhen(isNumber('$utilizationPct')),
      busyMs: coveredWhen(busy),
      utilizationWeighted: weighted('$utilizationPct'),
      utilizationPct: { $percentile: { input: '$utilizationPct', p: PERCENTILES, method: 'approximate' } },
      memoryUsedMiB: { $percentile: { input: '$memoryUsedMiB', p: PERCENTILES, method: 'approximate' } },
      memoryUsedMaxMiB: { $max: '$memoryUsedMiB' },
      memoryTotalMiB: { $max: '$memoryTotalMiB' },
      powerMs: coveredWhen(isNumber('$powerDrawW')),
      powerWeighted: weighted('$powerDrawW'),
      powerDrawW: { $percentile: { input: '$powerDrawW', p: [0.95], method: 'approximate' } },
      powerMaxW: { $max: '$powerDrawW' },
      powerLimitW: { $max: '$powerLimitW' },
      throttleMs: coveredWhen({ $gt: [{ $strLenCP: { $ifNull: ['$throttleReasonsActive', ''] } }, 0] }),
      throttledMs: coveredWhen({ $or: Object.values(throttled) }),
      ...Object.fromEntries(Object.entries(throttled)
        .map(([name, condition]) => [`throttle_${name}Ms`, coveredWhen(condition)])),
    } },
  ];
}

const round = (value, digits = 0) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const share = (part, whole) => (whole > 0 ? round(part / whole, 3) : null);
const percentile = (values, index) => round(Array.isArray(values) ? values[index] : null, 1);

function shapeGpu(row, windowMs) {
  const observedMs = Math.min(row?.observedMs || 0, windowMs);
  const gpu = row?.gpu || {};
  return {
    index: Number.isInteger(gpu.index) ? gpu.index : null,
    name: gpu.name || '',
    uuid: gpu.uuid || '',
    busId: gpu.busId || '',
    samples: row?.samples || 0,
    firstSampleAt: row?.firstSampleAt || null,
    lastSampleAt: row?.lastSampleAt || null,
    observedMs,
    missingMs: windowMs - observedMs,
    coverage: share(observedMs, windowMs) ?? 0,
    busy: { ms: row?.busyMs || 0, share: share(row?.busyMs || 0, row?.utilizationMs || 0) },
    utilizationPct: {
      mean: row?.utilizationMs > 0 ? round(row.utilizationWeighted / row.utilizationMs, 1) : null,
      p50: percentile(row?.utilizationPct, 0),
      p95: percentile(row?.utilizationPct, 1),
    },
    memoryUsedMiB: {
      p50: percentile(row?.memoryUsedMiB, 0),
      p95: percentile(row?.memoryUsedMiB, 1),
      max: round(row?.memoryUsedMaxMiB),
    },
    memoryTotalMiB: round(row?.memoryTotalMiB),
    powerW: {
      mean: row?.powerMs > 0 ? round(row.powerWeighted / row.powerMs, 1) : null,
      p95: percentile(row?.powerDrawW, 0),
      max: round(row?.powerMaxW, 1),
      limit: round(row?.powerLimitW, 1),
    },
    throttled: {
      observedMs: row?.throttleMs || 0,
      ms: row?.throttledMs || 0,
      share: share(row?.throttledMs || 0, row?.throttleMs || 0),
      ...Object.fromEntries(Object.keys(THROTTLE_CLASSES).map(name => [`${name}Ms`, row?.[`throttle_${name}Ms`] || 0])),
    },
  };
}

const gpuKeyOf = gpu => (gpu?.uuid ? gpu.uuid : `index:${gpu?.index}`);

/**
 * @returns {Promise<object>} the window, the busy threshold and, per collector
 *   host, its GPUs: sampled ones with their aggregates, and the GPUs the host
 *   last reported with no sample in the window (coverage 0).
 */
async function occupancy(db, raw = {}, now = new Date()) {
  const query = occupancyQuery(raw, now);
  const hostDocs = await db.collection(HOSTS).find(query.hostId ? { hostId: query.hostId } : {})
    .project({ _id: 0, hostId: 1, name: 1, ollamaUrl: 1, intervalMs: 1, gpus: 1 })
    .sort({ hostId: 1 }).limit(MAX_HOSTS * 4).toArray();
  const intervals = new Map(hostDocs.map(host => [host.hostId, host.intervalMs || DEFAULT_INTERVAL_MS]));
  const rows = await db.collection(SAMPLES).aggregate(buildOccupancyPipeline(query, intervals), { allowDiskUse: true }).toArray();

  const hosts = new Map(hostDocs.map(host => [host.hostId, {
    hostId: host.hostId, name: host.name || host.hostId, ollamaUrl: host.ollamaUrl || '',
    intervalMs: host.intervalMs || DEFAULT_INTERVAL_MS, gpus: new Map(),
  }]));
  for (const row of rows) {
    const hostId = row._id?.hostId;
    if (!hosts.has(hostId)) {
      hosts.set(hostId, { hostId, name: hostId, ollamaUrl: '', intervalMs: DEFAULT_INTERVAL_MS, gpus: new Map() });
    }
    hosts.get(hostId).gpus.set(row._id.gpuKey, shapeGpu(row, query.windowMs));
  }
  for (const host of hostDocs) {
    for (const gpu of (host.gpus || []).slice(0, MAX_GPUS)) {
      const target = hosts.get(host.hostId).gpus;
      if (!target.has(gpuKeyOf(gpu))) target.set(gpuKeyOf(gpu), shapeGpu({ gpu }, query.windowMs));
    }
  }
  return {
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    windowMs: query.windowMs,
    busyAtPct: query.busyAtPct,
    hosts: [...hosts.values()].map(host => ({
      ...host,
      gpus: [...host.gpus.values()].sort((a, b) => (a.index ?? 99) - (b.index ?? 99) || a.uuid.localeCompare(b.uuid)),
    })),
  };
}

module.exports = { THROTTLE_CLASSES, buildOccupancyPipeline, occupancy, occupancyQuery };
