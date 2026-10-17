'use strict';

/** Benchmark's only write to Core's heavy-work queue: record a request. */

const { coreRequest } = require('./coreHttp');
const { CORE_OPERATIONS } = require('./coreOperations');

async function submitHeavyWork(request) {
  const body = await coreRequest('/api/cluster/schedule/work-queue', {
    method: 'POST',
    operationId: CORE_OPERATIONS.HEAVY_QUEUE_SUBMIT,
    body: JSON.stringify(request),
  });
  return body?.data || null;
}

module.exports = { submitHeavyWork };
