'use strict';

// Core owns selectable targets. Host aliases bind an existing effective chat
// route to its pinned host/context; clients never guess a host from a model name.
const { isEmbeddingModelName } = require('../../../../shared/embeddingModels');
const { uniqueEffectiveModels } = require('../common');
const { PRINCIPAL_MODEL_ALIAS, resolvePrincipalAlias } = require('../principal-model');

const HOST_PREFIX = 'agentx-host/';

function chatTask(task) {
  return task?.model && task.taskType !== 'embeddings' && !isEmbeddingModelName(task.model);
}

function hostTargets(snapshot) {
  const hosts = new Map();
  for (const task of [...Object.values(snapshot.tasks || {}), snapshot.principalTopology]) {
    if (!chatTask(task) || !/^[a-z0-9_.-]+$/i.test(task.hostKey || '') || !task.hostUrl
      || task.pinAligned !== true || !(task.contextSize > 0)) continue;
    if (!hosts.has(task.hostKey)) hosts.set(task.hostKey, []);
    hosts.get(task.hostKey).push(task);
  }
  return new Map([...hosts].flatMap(([key, tasks]) => {
    // A host alias is safe only when all its effective chat routes agree.
    const identities = new Set(tasks.map(task => JSON.stringify([task.model, task.hostUrl, task.contextSize])));
    return identities.size === 1 ? [[HOST_PREFIX + key, tasks[0]]] : [];
  }));
}

function approvedModels(snapshot) {
  const models = new Set(uniqueEffectiveModels(snapshot).map(task => task.model));
  if (snapshot.tasks?.daily_operator?.model || snapshot.principalTopology?.model) models.add(PRINCIPAL_MODEL_ALIAS);
  const authority = String(process.env.HERMES_AUTHORITY_MODEL || '').trim();
  if (authority) models.add(authority);
  for (const id of hostTargets(snapshot).keys()) models.add(id);
  return [...models];
}

function resolveGatewayTarget(snapshot, id) {
  if (id === PRINCIPAL_MODEL_ALIAS) return resolvePrincipalAlias(snapshot, id);
  if (!String(id || '').startsWith(HOST_PREFIX)) return null;
  const target = hostTargets(snapshot).get(id);
  if (!target) throw Object.assign(new Error('The selected host has no unambiguous effective pinned chat route'), {
    statusCode: 409, code: 'HOST_MODEL_UNAVAILABLE'
  });
  return { ...target, numCtx: target.contextSize, exclusiveHost: false };
}

function metadata(target, selection, selectable) {
  return {
    selection,
    selectable,
    resolved_model: target?.model || null,
    host: target ? { key: target.hostKey || null, name: target.hostPreference?.displayName || target.hostKey || null } : null,
    context_window: target?.contextSize > 0 ? target.contextSize : null,
    capabilities: {
      tools: target?.inferenceContract?.capabilities?.tools?.supported ?? null,
      reasoning: target?.inferenceContract?.capabilities?.tools?.qualifiedExecution?.think
        ?? target?.inferenceContract?.capabilities?.thinking?.supported ?? null,
      ...(target?.inferenceContract?.capabilities?.tools?.qualifiedExecution && {
        tool_execution: target.inferenceContract.capabilities.tools.qualifiedExecution
      })
    }
  };
}

function modelCatalog(snapshot) {
  let principal = null;
  try { principal = resolvePrincipalAlias(snapshot, PRINCIPAL_MODEL_ALIAS); } catch { /* advertise unavailable, never invent a target */ }
  const hosts = hostTargets(snapshot);
  const created = Math.floor(new Date(snapshot.generatedAt).getTime() / 1000);
  return approvedModels(snapshot).map(id => {
    const target = id === PRINCIPAL_MODEL_ALIAS ? principal : hosts.get(id);
    const selection = id === PRINCIPAL_MODEL_ALIAS ? 'principal' : target ? 'host' : 'explicit';
    // The principal already represents its exact host/model in the selector.
    const duplicate = selection === 'host' && principal?.model === target.model && principal.hostUrl === target.hostUrl;
    return {
      id, object: 'model', created,
      owned_by: id.startsWith('openrouter/') ? 'agentx-cloud-router' : 'agentx-local-router',
      agentx: metadata(target, selection, Boolean(target) && !duplicate)
    };
  });
}

module.exports = { approvedModels, hostTargets, modelCatalog, resolveGatewayTarget };
