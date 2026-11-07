'use strict';

const { GPU_DRIVER_IDENTITY_VERSION } = require('./artifactIdentity');
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

function inventoryForIdentity(previous, incoming, version) {
  if (version != null && version !== GPU_DRIVER_IDENTITY_VERSION) {
    throw Object.assign(new Error('Unsupported GPU driver identity version'), { code: 'GPU_DRIVER_IDENTITY_VERSION_UNSUPPORTED' });
  }
  const observed = normalizeGpuInventory(incoming) || [];
  const retained = preserveInventoryDrivers(previous, observed);
  return version ? observed.map((gpu, index) => ({ ...gpu, driver: gpu.driver || retained[index].driver })) : retained;
}

module.exports = { preserveInventoryDrivers, inventoryForIdentity };
