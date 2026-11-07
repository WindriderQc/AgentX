'use strict';

const { normalizeGpuInventory } = require('./gpuInventory');

// A driver observation is evidence metadata until its host is explicitly
// activated. Keep every existing identity field (including manually recorded
// drivers) intact; a different physical device still changes the inventory.
function preserveInventoryDrivers(previous, incoming) {
  const identity = gpu => JSON.stringify({ ...gpu, driver: null });
  const known = new Map((normalizeGpuInventory(previous) || []).map(gpu => [identity(gpu), gpu.driver]));
  return (normalizeGpuInventory(incoming) || []).map(gpu => ({
    ...gpu, driver: known.get(identity(gpu)) || null
  }));
}

module.exports = { preserveInventoryDrivers };
