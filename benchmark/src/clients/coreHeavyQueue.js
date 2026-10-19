'use strict';

/**
 * Benchmark's writes to Core's heavy-work queue: record a lane measurement
 * request and plan its slot. Core owns the queue, its overlap checks and the
 * launch; Benchmark never begins or records a dispatch.
 */

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

async function reserveHeavyWork(id, { expectedRevision, start, priority = 5, autoStart = false }) {
  const body = await coreRequest(`/api/cluster/schedule/work-queue/${encodeURIComponent(id)}/reserve`, {
    method: 'POST',
    operationId: CORE_OPERATIONS.HEAVY_QUEUE_RESERVE,
    body: JSON.stringify({ expectedRevision, start, priority, autoStart }),
  });
  return body?.data || null;
}

async function listHeavyWork() {
  const body = await coreRequest('/api/cluster/schedule/work-queue', {
    method: 'GET',
    operationId: CORE_OPERATIONS.HEAVY_QUEUE_LIST,
  });
  return body?.data || null;
}

module.exports = { submitHeavyWork, reserveHeavyWork, listHeavyWork };
