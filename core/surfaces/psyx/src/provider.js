'use strict';
const { readAdmittedInferenceStream } = require('../../../src/services/readAdmittedInferenceStream');

function createCoreProvider(runtimeServices) {
  const routing = async () => {
    const snapshot = await runtimeServices.routing.getEffectiveSnapshot({ includeCatalog: false });
    return { ...snapshot, provider: 'agentx', taskConfigState: Object.fromEntries(
      Object.entries(snapshot.tasks || {}).map(([key, route]) => [key, { effective: { model: route.model, host: route.hostKey } }])) };
  };
  return {
    id: 'agentx', routing, probe: routing,
    async stream(request, handlers) {
      const result = await runtimeServices.inference.execute({
        mode: 'chat', stream: true, taskType: request.taskType, think: request.think, timeoutMs: request.timeoutMs,
        messages: [{ role: 'system', content: request.system }, ...request.messages, { role: 'user', content: request.message }],
        options: request.options, callerDetail: 'psyx'
      }, { signal: request.signal, consumerContract: 'psyx' });
      handlers.onRoute(result.metadata);
      return { ...await readAdmittedInferenceStream(result, {
        signal: request.signal, onToken: handlers.onToken, onThinking: handlers.onThinking
      }), routing: result.metadata };
    },
    // Background work (the review): one JSON answer, no stream, no thinking, no
    // cancellation once admitted.
    async complete(request) {
      const result = await runtimeServices.inference.execute({
        mode: 'chat', stream: false, taskType: request.taskType, think: false, format: 'json', timeoutMs: request.timeoutMs,
        messages: request.messages, options: { temperature: 0.2 }, callerDetail: 'psyx/review'
      }, { consumerContract: 'psyx' });
      if (!result?.ok) throw Object.assign(new Error(result?.body?.message || 'PsyX review inference failed'), { code: 'PSYX_REVIEW_INFERENCE_FAILED' });
      const body = result.body || {};
      return { content: body.message?.content || body.response || body.choices?.[0]?.message?.content || '', model: body.model || result.metadata?.model || null };
    }
  };
}
module.exports = { createCoreProvider };
