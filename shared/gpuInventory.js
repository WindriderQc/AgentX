'use strict';

// Hardware identity only: load, temperature and observation time do not change
// a runtime fingerprint. The inventory is what the collector sees on the
// machine; Ollama's observed visibleDevices selects its endpoint's devices.
function normalizeGpuInventory(gpus) {
  if (!Array.isArray(gpus) || !gpus.length) return null;
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  return gpus.map(gpu => ({
    index: Number.isSafeInteger(gpu?.index) && gpu.index >= 0 ? gpu.index : null,
    uuid: text(gpu?.uuid),
    busId: text(gpu?.busId),
    model: text(gpu?.model || gpu?.name),
    vramTotalMiB: positive(gpu?.vramTotalMiB ?? gpu?.memoryTotalMiB),
    computeCapability: text(gpu?.computeCapability),
    driver: text(gpu?.driver)
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}

module.exports = { normalizeGpuInventory };
