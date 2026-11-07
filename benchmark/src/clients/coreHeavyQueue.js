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

async function placeHeavyWork(id, { expectedRevision, when }) {
  const body = await coreRequest(`/api/cluster/schedule/work-queue/${encodeURIComponent(id)}/place`, {
    method: 'POST',
    operationId: CORE_OPERATIONS.HEAVY_QUEUE_PLACE,
    body: JSON.stringify({ expectedRevision, when }),
  });
  return body?.data || null;
}

async function getHeavyWork(id) {
  const body = await coreRequest(`/api/cluster/schedule/work-queue/${encodeURIComponent(id)}`, {
    operationId: CORE_OPERATIONS.HEAVY_QUEUE_GET,
  });
  return body?.data || null;
}

async function transition(id, action, expectedRevision, operationId) {
  const body = await coreRequest(`/api/cluster/schedule/work-queue/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', operationId, body: JSON.stringify({ expectedRevision }),
  });
  return body?.data || null;
}
const runHeavyWork = (id, revision) => transition(id, 'run', revision, CORE_OPERATIONS.HEAVY_QUEUE_RUN);
const cancelHeavyWork = (id, revision) => transition(id, 'cancel', revision, CORE_OPERATIONS.HEAVY_QUEUE_CANCEL);

/** The principal lane's endpoint from Core's runtime export; its model is not read. */
async function readPrincipalEndpoint() {
  const body = await coreRequest('/api/nerve-center/agent-runtime-config/export?includeCandidates=false', {
    method: 'GET',
    operationId: CORE_OPERATIONS.RUNTIME_CONFIG_EXPORT,
  });
  return body?.data?.lanes?.daily?.hostUrl || null;
}

module.exports = { submitHeavyWork, reserveHeavyWork, listHeavyWork, placeHeavyWork, readPrincipalEndpoint,
  getHeavyWork, runHeavyWork, cancelHeavyWork };
