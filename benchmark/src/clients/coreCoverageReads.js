'use strict';

/**
 * Core reads the coverage job needs beyond the model/host API: the task
 * routing table, which names the models each host is expected to serve, and
 * the two signals of a quiet moment.
 */

const { coreRequest } = require('./coreHttp');
const { CORE_OPERATIONS } = require('./coreOperations');

/** { taskModels: { task: { model, host } }, hosts: { key: { url, ... } } } */
async function getRoutingConfig() {
  const body = await coreRequest('/api/nerve-center/inference/routing-config', {
    operationId: CORE_OPERATIONS.ROUTING_CONFIG,
  });
  const data = body?.data || body || {};
  return { taskModels: data.taskModels || {}, hosts: data.hosts || {} };
}

/** { maintenance, workloads, inferences, drain }: what currently owns the runtime. */
async function getRuntimeActive() {
  const body = await coreRequest('/api/nerve-center/runtime-coordination/active', {
    operationId: CORE_OPERATIONS.RUNTIME_ACTIVE,
  });
  return body?.data || {};
}

/** { activeTurns, lastTurnEndedAt, idleMs }: how long the household has been quiet. */
async function getHouseholdIdle() {
  const body = await coreRequest('/api/nerve-center/interactive-priority/status', {
    operationId: CORE_OPERATIONS.HOUSEHOLD_IDLE,
  });
  return body?.data || { activeTurns: 0, idleMs: 0 };
}

module.exports = { getRoutingConfig, getRuntimeActive, getHouseholdIdle };
