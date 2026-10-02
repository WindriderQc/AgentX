'use strict';

/**
 * Projects collector evidence (agentx.profiler-hardware-collector/v1, read from
 * Data) onto the profiler's hardware telemetry shape. Only a fresh snapshot
 * makes a metric `observed`; stale or absent evidence leaves it `unknown`.
 */

const ADVANCED_METRICS = [
  'gpu_utilization', 'temperature', 'power', 'clocks', 'throttle_reasons',
  'pcie_link', 'topology', 'per_gpu_balance'
];
const THERMAL_REASONS = new Set(['sw_thermal', 'hw_thermal']);
const POWER_REASONS = new Set(['sw_power_cap', 'hw_power_brake']);

const has = value => value !== null && value !== undefined && Number.isFinite(Number(value));
const values = (gpus, field) => gpus.map(gpu => gpu[field]).filter(has).map(Number);
const round = (value, places = 1) => Number(value.toFixed(places));

function mapGpu(gpu, position) {
  return {
    index: gpu.index ?? position,
    name: gpu.name || '',
    uuid: gpu.uuid || '',
    busId: gpu.busId || '',
    utilizationPct: gpu.utilizationPct ?? null,
    memoryUtilizationPct: gpu.memoryUtilizationPct ?? null,
    memoryUsedMiB: gpu.memoryUsedMiB ?? null,
    memoryTotalMiB: gpu.memoryTotalMiB ?? null,
    powerDrawW: gpu.powerDrawW ?? null,
    powerLimitW: gpu.powerLimitW ?? null,
    temperatureC: gpu.temperatureC ?? null,
    smClockMHz: gpu.smClockMHz ?? null,
    smClockMaxMHz: gpu.smClockMaxMHz ?? null,
    pcieGen: gpu.pcieGen ?? null,
    pcieGenMax: gpu.pcieGenMax ?? null,
    pcieWidth: gpu.pcieWidth ?? null,
    pcieWidthMax: gpu.pcieWidthMax ?? null,
    throttleReasonsActive: gpu.throttleReasonsActive ?? null,
    throttleReasons: Array.isArray(gpu.throttleReasons) ? gpu.throttleReasons : [],
    source: 'nvidia-smi'
  };
}

function metricStatus(observed) {
  return observed ? { status: 'observed', source: 'nvidia-smi' } : { status: 'unknown', source: 'none' };
}

function collectorBlock(hardware) {
  const block = {
    requiredContract: 'agentx.profiler-hardware-collector/v1',
    status: hardware?.status || 'not_configured',
    ownershipBoundary: 'deployment_extension'
  };
  if (!hardware) return block;
  for (const key of ['source', 'collectorId', 'hostId', 'sampledAt', 'ageMs', 'staleAfterMs', 'reason']) {
    if (hardware[key] !== undefined && hardware[key] !== null) block[key] = hardware[key];
  }
  return block;
}

function summarizeGpuNames(gpus) {
  const names = gpus.map(gpu => gpu.name).filter(Boolean);
  if (!names.length) return '';
  return names.every(name => name === names[0]) && names.length > 1 ? `${names[0]} x${names.length}` : [...new Set(names)].join(' + ');
}

function diagnose(gpus) {
  const notes = [];
  const utilization = values(gpus, 'utilizationPct');
  const imbalance = gpus.length >= 2 && utilization.length === gpus.length
    ? Math.max(...utilization) - Math.min(...utilization)
    : null;

  const narrowLinks = gpus.filter(gpu => has(gpu.pcieWidth) && has(gpu.pcieWidthMax) && gpu.pcieWidth < gpu.pcieWidthMax);
  // Links downshift their generation at idle to save power; only a busy GPU counts.
  const slowBusyLinks = gpus.filter(gpu => has(gpu.pcieGen) && has(gpu.pcieGenMax) && gpu.pcieGen < gpu.pcieGenMax
    && has(gpu.utilizationPct) && gpu.utilizationPct >= 50);
  const pcieWarning = [
    ...narrowLinks.map(gpu => `GPU ${gpu.index} PCIe x${gpu.pcieWidth} of x${gpu.pcieWidthMax}`),
    ...slowBusyLinks.map(gpu => `GPU ${gpu.index} PCIe Gen${gpu.pcieGen} of Gen${gpu.pcieGenMax} under load`)
  ].join('; ') || null;

  const thermal = gpus.filter(gpu => gpu.throttleReasons.some(reason => THERMAL_REASONS.has(reason))
    || (has(gpu.temperatureC) && gpu.temperatureC >= 85));
  const thermalWarning = thermal.map(gpu => `GPU ${gpu.index} thermal limit (${gpu.temperatureC ?? '?'}C)`).join('; ') || null;

  const power = gpus.filter(gpu => gpu.throttleReasons.some(reason => POWER_REASONS.has(reason))
    || (has(gpu.powerDrawW) && has(gpu.powerLimitW) && gpu.powerLimitW > 0 && gpu.powerDrawW >= gpu.powerLimitW * 0.98));
  const powerWarning = power.map(gpu => `GPU ${gpu.index} at power limit`).join('; ') || null;

  for (const warning of [pcieWarning, thermalWarning, powerWarning]) if (warning) notes.push(warning);
  if (imbalance != null && imbalance >= 30) notes.push(`GPU utilization imbalance ${round(imbalance, 0)} points`);
  return {
    gpuUtilizationPct: utilization.length ? round(utilization.reduce((a, b) => a + b, 0) / utilization.length) : null,
    gpuImbalancePct: imbalance != null ? round(imbalance) : null,
    pcieWarning,
    thermalWarning,
    powerWarning,
    notes
  };
}

/**
 * @param {object|null} hardware result of hardwareCollectorClient.readHostHardware
 * @returns {object} collector block, metric statuses and observed fields
 */
function projectCollectorEvidence(hardware) {
  const collector = collectorBlock(hardware);
  const unknown = Object.fromEntries(ADVANCED_METRICS.map(metric => [metric, { status: 'unknown', source: 'none' }]));
  if (hardware?.status !== 'observed' || !Array.isArray(hardware.gpus) || hardware.gpus.length === 0) {
    return { observed: false, collector, metrics: unknown };
  }

  const gpus = hardware.gpus.map(mapGpu);
  const any = field => gpus.some(gpu => has(gpu[field]));
  const metrics = {
    gpu_utilization: metricStatus(any('utilizationPct')),
    temperature: metricStatus(any('temperatureC')),
    power: metricStatus(any('powerDrawW')),
    clocks: metricStatus(any('smClockMHz')),
    throttle_reasons: metricStatus(gpus.some(gpu => gpu.throttleReasonsActive != null)),
    pcie_link: metricStatus(gpus.some(gpu => has(gpu.pcieGen) && has(gpu.pcieWidth))),
    // nvidia-smi --query-gpu does not describe the interconnect topology.
    topology: { status: 'unknown', source: 'none' },
    per_gpu_balance: gpus.length === 1
      ? { status: 'not_applicable', source: 'nvidia-smi' }
      : metricStatus(gpus.every(gpu => has(gpu.utilizationPct)))
  };

  const utilization = values(gpus, 'utilizationPct');
  const temperature = values(gpus, 'temperatureC');
  const power = values(gpus, 'powerDrawW');
  const memoryUsed = values(gpus, 'memoryUsedMiB');
  const memoryTotal = values(gpus, 'memoryTotalMiB');
  const minOf = field => (values(gpus, field).length ? Math.min(...values(gpus, field)) : null);
  return {
    observed: true,
    collector,
    metrics,
    fields: {
      gpuName: summarizeGpuNames(gpus),
      gpuCount: gpus.length,
      utilization: utilization.length ? round(utilization.reduce((a, b) => a + b, 0) / utilization.length) : null,
      temperature: temperature.length ? Math.max(...temperature) : null,
      powerDrawW: power.length ? round(power.reduce((a, b) => a + b, 0)) : null,
      pcieGen: minOf('pcieGen'),
      pcieGenMax: minOf('pcieGenMax'),
      pcieWidth: minOf('pcieWidth'),
      pcieWidthMax: minOf('pcieWidthMax'),
      vramUsedMiB: memoryUsed.length === gpus.length ? Math.round(memoryUsed.reduce((a, b) => a + b, 0)) : null,
      vramTotalMiB: memoryTotal.length === gpus.length ? Math.round(memoryTotal.reduce((a, b) => a + b, 0)) : null,
      gpus
    },
    diagnostics: diagnose(gpus)
  };
}

module.exports = { ADVANCED_METRICS, projectCollectorEvidence, mapGpu };
