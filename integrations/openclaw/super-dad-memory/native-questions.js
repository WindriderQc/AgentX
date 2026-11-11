import { createConversationWorkClient } from './conversation-work.js';
import { createQuestionTransport } from './question-transport.js';
const invalid = () => Object.assign(new Error('A retained Core question decision is required.'), { statusCode: 400 });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const workId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const uuid = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const ordinary = q => Array.isArray(q?.questions) && q.questions.length > 0
  && q.questions.every(input => !input.isSecret && !input.secretStore && !input.secretStoreExisting);

// HTTP callers can trigger only a Core-owned reference. They cannot nominate
// answers, a native session, a device or an unaccepted resolution intent.
export function createNativeQuestions({ config, fetchImpl = fetch, loadSdk }) {
  const transport = createQuestionTransport({ config, loadSdk });
  const core = createConversationWorkClient({ baseUrl: config.agentxUrl, token: config.conversationWorkToken, fetchImpl });
  const enabled = () => transport.configured() && typeof config.conversationWorkToken === 'string'
    && config.conversationWorkToken.length >= 32 && Boolean(config.agentxUrl);
  return async (request, { signal } = {}) => {
    const effect = request.operation === 'question_effect';
    if (!exact(request, effect ? ['operation', 'workId', 'intentId', 'lookupOnly'] : ['operation', 'workId'])
        || !['questions', 'question_effect'].includes(request.operation) || !workId(request.workId)
        || effect && (!uuid(request.intentId) || typeof request.lookupOnly !== 'boolean')) throw invalid();
    if (!enabled()) return { contract: 0 };
    return transport.withClient(async rpc => {
      if (!effect) {
        const proof = await core('question_context', {}, { workId: request.workId }, undefined, signal);
        if (proof.workId !== request.workId || proof.action !== 'observe' || proof.attempt?.agentId !== 'main') throw invalid();
        const result = await rpc('question.list', { includeIncarnation: true });
        const matching = (result.questions || []).filter(q => q.agentId === proof.attempt.agentId
          && q.sessionKey === proof.attempt.sessionKey && q.runId === proof.attempt.runId);
        return { contract: 1, questions: matching.filter(ordinary), blocked: matching.some(q => !ordinary(q)) };
      }
      const packet = await core('question_effect', {}, { workId: request.workId, intentId: request.intentId, lookupOnly: request.lookupOnly }, undefined, signal);
      if (packet.workId !== request.workId || packet.intentId !== request.intentId || !uuid(packet.resolutionId)
          || !['resolve', 'lookup'].includes(packet.action) || request.lookupOnly && packet.action !== 'lookup'
          || !ordinary(packet.question) || packet.question.agentId !== 'main'
          || typeof packet.question.incarnation !== 'string' || !packet.question.incarnation) throw invalid();
      const { id, incarnation } = packet.question;
      try {
        const result = packet.action === 'resolve'
          ? await rpc('question.resolve', { id, expectedIncarnation: incarnation, resolutionId: packet.resolutionId, answers: packet.answers })
          : await rpc('question.waitAnswer', { id, expectedIncarnation: incarnation, timeoutMs: 1, includeResolutionId: true });
        return { contract: 1, ...result };
      } catch (error) {
        if (error?.details?.reason === 'QUESTION_INCARNATION_MISMATCH') return { contract: 1, status: 'mismatch' };
        // Missing/expired retention is not proof of a non-effect. No retry.
        throw error;
      }
    }, { signal });
  };
}
