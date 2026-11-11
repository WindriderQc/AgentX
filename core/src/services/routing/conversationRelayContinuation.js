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
  observeFamilyOccupation = readOccupation, occupation, signal, notice, requireOccupation = true }) {
  let calls = 0;
  async function assertOccupied() {
    signal?.throwIfAborted();
    // An unavailable Family principal refused this new turn before dispatch.
    // Completing its read-only guardian reply needs no claim that Main is busy.
    // Each model call still takes native admission on the same guardian host.
    if (!requireOccupation && !occupation) return;
    const current = occupation ? await options.observeOccupation() : await boundedRead(() => observeFamilyOccupation(target), 1500, signal);
    const valid = occupation ? current?.state === 'running' && current.authority === 'hermes'
      && current.runId === occupation.runId && current.sessionKey === occupation.sessionKey : current === true;
    if (!valid) throw Object.assign(new Error('The original principal occupation is no longer verified; no additional relay call was sent.'), { code: 'RELAY_OCCUPATION_CHANGED' });
    signal?.throwIfAborted();
  }
  return { messages: reduced.messages, assertOccupied,
    async execute(messages, tools, { announce = false } = {}) {
      await assertOccupied();
      if (announce && !tools?.length && messages[0]?.role === 'system') messages = [
        { ...messages[0], content: messages[0].content + '\nThe selected runtime refused tools. No tools are available for this answer. Use supplied context only; do not claim a source read.' },
        ...messages.slice(1) ];
      if (++calls > 2 || !Array.isArray(messages) || messages.length > 24
          || JSON.stringify({ messages, tools }).length > maxInputChars) {
        throw Object.assign(new Error('The relay context or model-call budget is exhausted.'), { code: 'RELAY_CONTEXT_EXCEEDED' });
      }
      const result = await execute({ ...reduced, messages, ...(tools?.length ? { tools } : { tools: undefined }) }, {
        signal, consumerContract: options.consumerContract, hostUrl,
        degraded: routing, conversationContinuity: { ...continuity,
          lane: { role: 'conversation', mode: 'continuity', group: null, laneContext: reduced.options.num_ctx } },
        retry: { enabled: false }
      });
      return announce ? require('./conversationContinuityContext').decorate(result, {
        notice: (notice || 'Nestor assure temporairement le relais.').replace('avec quelques outils de consultation', 'sans outils'), continuity }) : result;
    }
  };
}
module.exports = { createRelayContinuation, readOccupation, safeOccupation };
