'use strict';

/**
 * Core reads the coverage job needs beyond the model/host API: the task
 * routing table, which names the models each host is expected to serve.
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

module.exports = { getRoutingConfig };
