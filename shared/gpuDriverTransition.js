'use strict';

const crypto = require('crypto');
const validRequestId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(id);
function operationWorkloadId(hostId, requestId, action = 'activation') {
  return `gpu-driver-${action}:${crypto.createHash('sha256').update(JSON.stringify([hostId, requestId])).digest('hex')}`;
}

function confirmedCacheReceipt(receipt, intent) {
  return receipt?.contract === 'agentx.gpu-driver-cache-invalidation/v1' && receipt.cleared === true
    && ['requestId', 'preparationId', 'targetFingerprint', 'workloadId'].every(key => receipt[key] === intent[key])
    && ['routing', 'readiness', 'context', 'models'].every(key => Number.isSafeInteger(receipt.generations?.[key]) && receipt.generations[key] > 0)
    && Number.isFinite(Date.parse(receipt.clearedAt));
}

module.exports = { validRequestId, operationWorkloadId, confirmedCacheReceipt };
