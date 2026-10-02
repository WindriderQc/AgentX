'use strict';

/**
 * Hardware snapshots recorded around each profile phase. The live probe merges
 * Ollama residency with collector evidence read from Data
 * (agentx.profiler-hardware-collector/v1); a snapshot keeps a compact copy.
 */

const liveProbeService = require('./liveProbeService');
const logger = require('../../../config/logger');

function _compactHardwareSnapshot(status, phase) {
  const telemetry = status?.telemetry;
  if (!telemetry) return null;
  return {
    phase,
    capturedAt: new Date(),
    ok: !!telemetry.ok,
    source: telemetry.source || 'none',
    capability: telemetry.capability || {
      contract: 'agentx.profiler-hardware-capability/v1',
      status: 'unavailable',
      qualificationAuthority: 'none',
      collector: {
        requiredContract: 'agentx.profiler-hardware-collector/v1',
        status: 'not_configured',
        ownershipBoundary: 'deployment_extension'
      }
    },
    gpuName: telemetry.gpuName || '',
    gpuCount: telemetry.gpuCount || (telemetry.gpus?.length || null),
    utilization: telemetry.utilization ?? null,
    temperature: telemetry.temperature ?? null,
    powerDrawW: telemetry.powerDrawW ?? null,
    pcieGen: telemetry.pcieGen ?? null,
    pcieGenMax: telemetry.pcieGenMax ?? null,
    pcieWidth: telemetry.pcieWidth ?? null,
    pcieWidthMax: telemetry.pcieWidthMax ?? null,
    vramUsedMiB: telemetry.vramUsedMiB ?? null,
    vramTotalMiB: telemetry.vramTotalMiB ?? null,
    topology: typeof telemetry.topology === 'string' ? telemetry.topology.slice(0, 4000) : null,
    gpus: (telemetry.gpus || []).map(gpu => ({
      index: gpu.index ?? null,
      name: gpu.name || '',
      busId: gpu.busId || '',
      utilizationPct: gpu.utilizationPct ?? null,
      memoryUsedMiB: gpu.memoryUsedMiB ?? null,
      memoryTotalMiB: gpu.memoryTotalMiB ?? null,
      powerDrawW: gpu.powerDrawW ?? null,
      powerLimitW: gpu.powerLimitW ?? null,
      temperatureC: gpu.temperatureC ?? null,
      pcieGen: gpu.pcieGen ?? null,
      pcieGenMax: gpu.pcieGenMax ?? null,
      pcieWidth: gpu.pcieWidth ?? null,
      pcieWidthMax: gpu.pcieWidthMax ?? null,
      smClockMHz: gpu.smClockMHz ?? null,
      smClockMaxMHz: gpu.smClockMaxMHz ?? null,
      throttleReasons: Array.isArray(gpu.throttleReasons) ? gpu.throttleReasons.slice(0, 16) : [],
      source: gpu.source || telemetry.source || 'unknown'
    })),
    runningModels: (telemetry.runningModels || []).map(model => ({
      name: model.name,
      sizeVramMiB: model.sizeVramMiB ?? null,
      sizeTotalMiB: model.sizeTotalMiB ?? null
    })),
    diagnostics: telemetry.diagnostics || null,
    error: telemetry.error || null
  };
}

async function _captureHardwareSnapshot(hostId, phase, settings) {
  if (settings.collectHardwareTelemetry === false) return null;
  try {
    const status = await liveProbeService.getLiveProbeStatus(hostId);
    return _compactHardwareSnapshot(status, phase);
  } catch (err) {
    logger.debug(`Hardware telemetry snapshot failed for ${hostId}/${phase}: ${err.message}`);
    return {
      phase,
      capturedAt: new Date(),
      ok: false,
      source: 'none',
      error: err.message,
      runningModels: [],
      gpus: []
    };
  }
}

function _buildHardwareTelemetry(snapshots) {
  const kept = (snapshots || []).filter(Boolean);
  if (!kept.length) return null;
  const latest = [...kept].reverse().find(s => s.ok) || kept[kept.length - 1];
  return {
    enabled: true,
    source: latest.source || 'none',
    capability: latest.capability || null,
    capturedAt: latest.capturedAt || new Date(),
    latest,
    diagnostics: latest.diagnostics || null,
    snapshots: kept
  };
}

module.exports = { _compactHardwareSnapshot, _captureHardwareSnapshot, _buildHardwareTelemetry };
