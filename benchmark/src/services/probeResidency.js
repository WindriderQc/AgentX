'use strict';

/**
 * GPU residency observed during a context-probe sample.
 *
 * One /api/ps read gives both the profiled model's GPU share and the other
 * residents loaded beside it. Recording those co-residents turns a probe step
 * into evidence of what fits together, which a pin context proposal needs:
 * a context that fits alone may still spill a co-resident embedding pin.
 */

const { listRunning } = require('../clients/ollamaClient');
const { isSameOllamaModel } = require('../helpers/ollamaModelIdentity');

function finiteOrNull(value, { min = 0 } = {}) {
  return Number.isFinite(value) && value >= min ? value : null;
}

function projectCoResident(model) {
  return {
    model: model.name || model.model || null,
    size: finiteOrNull(model.size, { min: 1 }),
    sizeVram: finiteOrNull(model.size_vram),
    contextLength: finiteOrNull(Number(model.context_length), { min: 1 })
  };
}

async function snapshotGpuOffload(hostUrl, modelName, signal = null) {
  try {
    const data = await listRunning(hostUrl, { signal });
    const models = data.models || [];
    const matches = item => isSameOllamaModel(item.name, modelName) || isSameOllamaModel(item.model, modelName);
    const model = models.find(matches);
    const coResidents = models.filter(item => !matches(item)).map(projectCoResident);
    const residency = require('./probePlacement').residencyOf(hostUrl);
    if (!model) {
      return { gpuPercent: null, sizeTotal: null, sizeVram: null, contextLength: null, coResidents, residency };
    }

    const sizeTotal = finiteOrNull(model.size, { min: 1 });
    const sizeVram = finiteOrNull(model.size_vram);
    const gpuPercent = sizeTotal !== null && sizeVram !== null
      ? Number(((sizeVram / sizeTotal) * 100).toFixed(1)) : null;

    return {
      gpuPercent,
      sizeTotal,
      sizeVram,
      contextLength: model.context_length || null,
      coResidents,
      residency
    };
  } catch (error) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
    // Unknown inventory: no co-resident evidence rather than "none loaded".
    return { gpuPercent: null, sizeTotal: null, sizeVram: null, contextLength: null, coResidents: null };
  }
}

/** Persisted profile shape of one probe candidate, samples included. */
function projectProbeStep(step) {
  return {
    numCtx: step.numCtx,
    tokPerSec: step.tokensPerSec,
    vramMiB: step.vramMiB,
    degradationPct: step.degradationPct,
    passed: step.passed,
    failureKind: step.failureKind ?? null,
    repetitionCount: step.repetitionCount,
    throughputStatistics: step.throughputStatistics || null,
    samples: Array.isArray(step.samples) ? step.samples : []
  };
}

module.exports = { snapshotGpuOffload, projectProbeStep, projectCoResident };
