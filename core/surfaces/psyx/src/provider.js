'use strict';
const { readAdmittedInferenceStream } = require('../../../src/services/readAdmittedInferenceStream');

// PsyX answers on Core's local routes, or on the frontier lane when the user's
// setting asks for it. The frontier lane is an OpenClaw agent used as transport
// to a cloud model; when it is unavailable the same request is answered locally
// and the routing says so, so the interface can show where the reply came from.
function createCoreProvider(runtimeServices, { frontier = null, config = {}, logger = console } = {}) {
  const frontierConfig = config.frontier || {};
  const frontierReady = () => Boolean(frontier?.available(frontierConfig.agent));
  const routing = async () => {
    const snapshot = await runtimeServices.routing.getEffectiveSnapshot({ includeCatalog: false });
    return { ...snapshot, provider: 'agentx', taskConfigState: Object.fromEntries(
      Object.entries(snapshot.tasks || {}).map(([key, route]) => [key, { effective: { model: route.model, host: route.hostKey } }])) };
  };
  const frontierRouting = () => ({ location: 'frontier', routedModel: frontierConfig.model, routedHost: `openclaw/${frontierConfig.agent}` });
  // Says why the local route answered; never logs content.
  const fallbackReason = (error, work) => {
    const reason = typeof error.code === 'string' ? error.code : error.name || 'FRONTIER_FAILED';
    logger.warn?.('PsyX frontier unavailable, answering locally', { work, reason, message: error.message });
    return reason;
  };

  async function localStream(request, handlers, extra = {}) {
    const result = await runtimeServices.inference.execute({
      mode: 'chat', stream: true, taskType: request.taskType, think: request.think, timeoutMs: request.timeoutMs,
      messages: [{ role: 'system', content: request.system }, ...request.messages, { role: 'user', content: request.message }],
      options: request.options, callerDetail: 'psyx'
    }, { signal: request.signal, consumerContract: 'psyx' });
    const metadata = { ...result.metadata, location: 'local', ...extra };
    handlers.onRoute(metadata);
    return { ...await readAdmittedInferenceStream(result, {
      signal: request.signal, onToken: handlers.onToken, onThinking: handlers.onThinking
    }), routing: metadata };
  }

  async function localComplete(request, extra = {}) {
    const result = await runtimeServices.inference.execute({
      mode: 'chat', stream: false, taskType: request.taskType, think: false, format: 'json', timeoutMs: request.timeoutMs,
      messages: request.messages, options: { temperature: 0.2 }, callerDetail: 'psyx/review'
    }, { consumerContract: 'psyx' });
    if (!result?.ok) throw Object.assign(new Error(result?.body?.message || 'PsyX review inference failed'), { code: 'PSYX_REVIEW_INFERENCE_FAILED' });
    const body = result.body || {};
    return { content: body.message?.content || body.response || body.choices?.[0]?.message?.content || '',
      model: body.model || result.metadata?.model || null, location: 'local', ...extra };
  }

  return {
    id: 'agentx', routing, probe: routing, frontierReady,
    async stream(request, handlers) {
      if (request.location !== 'frontier' || !frontierReady()) {
        return localStream(request, handlers, request.location === 'frontier' ? { fallbackFrom: 'frontier', fallbackReason: 'FRONTIER_NOT_CONFIGURED' } : {});
      }
      let started = false;
      try {
        handlers.onRoute(frontierRouting());
        const result = await frontier.run({
          agentId: frontierConfig.agent, instructions: request.system, signal: request.signal, timeoutMs: request.timeoutMs,
          messages: [...request.messages, { role: 'user', content: request.message }],
          onToken: delta => { started = true; handlers.onToken(delta); }
        });
        if (!result.streamed) handlers.onToken(result.content);
        return { content: result.content, model: frontierConfig.model, routing: frontierRouting(), stats: result.usage, thinkingObserved: false };
      } catch (error) {
        // Once text reached the user the turn cannot be replayed elsewhere; before that, answer locally and say so.
        if (started || request.signal?.aborted) throw error;
        return localStream(request, handlers, { fallbackFrom: 'frontier', fallbackReason: fallbackReason(error, 'turn') });
      }
    },
    // Background work (the review): one JSON answer, no stream, no thinking, no
    // cancellation once admitted.
    async complete(request) {
      if (request.location !== 'frontier' || !frontierReady()) return localComplete(request);
      try {
        const [system, ...rest] = request.messages;
        const result = await frontier.run({ agentId: frontierConfig.agent, instructions: system.content, messages: rest, timeoutMs: request.timeoutMs });
        return { content: result.content, model: frontierConfig.model, location: 'frontier' };
      } catch (error) {
        return localComplete(request, { fallbackFrom: 'frontier', fallbackReason: fallbackReason(error, 'review') });
      }
    }
  };
}
module.exports = { createCoreProvider };
