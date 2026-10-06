'use strict';

const { createOpenClawExecutionClient, connection } = require('../../../../shared/openclawExecutionClient');
const { executionModelId } = require('../../../../shared/executionSource');

async function readOpenClawSource({ client = createOpenClawExecutionClient(), env = process.env } = {}) {
  try { connection(env); } catch { return { id: 'openclaw', name: 'OpenClaw', configured: false, available: false, models: [], agents: [] }; }
  try {
    const catalogue = await client.catalog();
    return { id: 'openclaw', name: 'OpenClaw', configured: true, available: true, ...catalogue };
  } catch (error) {
    return { id: 'openclaw', name: 'OpenClaw', configured: true, available: false, code: error.code, models: [], agents: [] };
  }
}

async function openClawModels({ client = createOpenClawExecutionClient() } = {}) {
  const catalogue = await client.catalog();
  const project = (selection, name, descriptor) => ({ id: executionModelId(selection), name: executionModelId(selection), displayName: name,
    provider: 'openclaw', execution: selection, source: { type: 'openclaw', url: null },
    capabilities: { supportsStreaming: true, supportsThinking: descriptor.reasoning === true, maxContext: descriptor.contextWindow || null },
    deployment: { status: 'available' }, readiness: { stage: 'available', evidenceState: 'runtime-source', isReady: true, benchmarkQualified: false },
    parameterSupport: descriptor.parameterSupport || {},
    chatAllowed: selection.mode === 'agent' || (descriptor.isolation?.singleCallQualified === true && descriptor.billing?.kind !== 'unknown' && (descriptor.billing?.kind !== 'paid' || catalogue.policy?.maxRequestCostNanodollars > 0)), billing: descriptor.billing || { kind: 'unknown' }, origin: descriptor.origin || null,
    executionFingerprint: descriptor.fingerprint, observedAt: catalogue.observedAt, expiresAt: catalogue.expiresAt });
  return [...catalogue.models.map(model => project({ source: 'openclaw', mode: 'model', model: model.model }, `${model.name} · modèle`, model)),
    ...catalogue.agents.map(agent => project({ source: 'openclaw', mode: 'agent', agentId: agent.agentId }, `${agent.name} · agent`, agent))];
}

module.exports = { readOpenClawSource, openClawModels };
