'use strict';

const { inferenceConflict } = require('../runtimeInferenceConflict');
const { hostUrlKey } = require('../../../../shared/ollamaHostConfig');
const { boundedRead } = require('./conversationContinuityStatus');
const safeOccupation = failure => failure?.safeToRetry === true
  && ['inference_active', 'inference_residency_active', 'workload_reserved', 'maintenance_active'].includes(failure.cause)
  && Boolean(failure.holder);

async function readOccupation(target) {
  const state = await require('../../../models/RuntimeCoordination').findById('runtime').maxTimeMS(1000).lean();
  return safeOccupation(inferenceConflict(state, { host: hostUrlKey(target.hostUrl), mode: 'exclusive', resourceIds: [] }, new Date()));
}

// This in-process continuation never becomes a browser capability. It retains
// the selected host/context, caller admission and original occupation. Every
// additional model call has ordinary native admission and disables retries.
function createRelayContinuation({ reduced, target, execute, options, hostUrl, routing, continuity, maxInputChars,
  observeFamilyOccupation = readOccupation, occupation, signal }) {
  let calls = 0;
  async function assertOccupied() {
    signal?.throwIfAborted();
    const current = occupation ? await options.observeOccupation() : await boundedRead(() => observeFamilyOccupation(target), 1500, signal);
    const valid = occupation ? current?.state === 'running' && current.authority === 'hermes'
      && current.runId === occupation.runId && current.sessionKey === occupation.sessionKey : current === true;
    if (!valid) throw Object.assign(new Error('The original principal occupation is no longer verified; no additional relay call was sent.'), { code: 'RELAY_OCCUPATION_CHANGED' });
    signal?.throwIfAborted();
  }
  return { messages: reduced.messages, assertOccupied,
    async execute(messages, tools) {
      await assertOccupied();
      if (++calls > 2 || !Array.isArray(messages) || messages.length > 24
          || JSON.stringify({ messages, tools }).length > maxInputChars) {
        throw Object.assign(new Error('The relay context or model-call budget is exhausted.'), { code: 'RELAY_CONTEXT_EXCEEDED' });
      }
      return execute({ ...reduced, messages, ...(tools?.length ? { tools } : { tools: undefined }) }, {
        signal, consumerContract: options.consumerContract, hostUrl,
        degraded: routing, conversationContinuity: { ...continuity,
          lane: { role: 'conversation', mode: 'continuity', group: null, laneContext: reduced.options.num_ctx } },
        retry: { enabled: false }
      });
    }
  };
}
module.exports = { createRelayContinuation, readOccupation };
