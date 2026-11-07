'use strict';

const { coreRequest } = require('./coreHttp');
const { CORE_OPERATIONS } = require('./coreOperations');
const { getWorkloadRecoveryIdentity } = require('./coreWorkloadRecoveries');
const { confirmedCacheReceipt } = require('../../../shared/gpuDriverTransition');

async function invalidateDriverCaches(input, options = {}) {
  const authority = getWorkloadRecoveryIdentity(input.workloadId);
  if (!authority) throw new Error('The exact native activation recovery proof is required');
  const response = await coreRequest('/api/inference/contract/gpu-driver-cache-invalidation', {
    method: 'POST', operationId: CORE_OPERATIONS.GPU_DRIVER_CACHE_INVALIDATION, signal: options.signal,
    body: JSON.stringify({ ...input, authority })
  });
  const receipt = response?.data;
  if (!confirmedCacheReceipt(receipt, input)) throw new Error('Core did not confirm the exact driver cache invalidation');
  return receipt;
}

module.exports = { invalidateDriverCaches };
