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
    }
  };
}
module.exports = { createCoreProvider };
