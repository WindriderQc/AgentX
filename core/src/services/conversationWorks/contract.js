'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const OWNER = 'household:personal_operator:personal';
const SCOPED = Object.freeze({ packId: 'personal_operator', scopeId: 'personal' });
const EXCHANGE_SCOPE = 'work:' + OWNER;
const ACTIVE = ['received', 'queued', 'paused', 'dispatching', 'running', 'result_ready', 'uncertain'];
const LIMITS = Object.freeze({ request: 4000, result: 16000, context: 96000, tools: 16, events: 64, open: 64 });
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const notFound = () => fail('CONVERSATION_WORK_NOT_FOUND', 'Conversation work not found.', 404);
const sessionScope = session => session?.packId === SCOPED.packId && session?.scopeId === SCOPED.scopeId;
const eligible = (session, channel, env) => sessionScope(session) && channel === 'voice'
  && (!session.agentId || session.agentId === 'main') && session.backend === 'openclaw'
  && session.modeId !== 'open' && !session.inference?.open && !session.llmx
  && ['observe', 'read'].includes(env.PERSONAL_CONVERSATION_WORK_MODE)
  && /^[a-z][a-z0-9_-]{0,63}$/.test(env.PERSONAL_CONVERSATION_WORK_AGENT_ID || '')
  && !['main', 'family'].includes(env.PERSONAL_CONVERSATION_WORK_AGENT_ID)
  && String(env.PERSONAL_CONVERSATION_WORK_TOKEN || '').length >= 32;
const tokenMatches = (left, right) => Boolean(left && right) && Buffer.byteLength(left) === Buffer.byteLength(right)
  && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const simple = text => /^(?:bonjour|salut|hello|hi|merci|thank you|thanks|au revoir|bonne nuit|ok|okay)[.!\s]*$/i.test(text);
function validateResult(input) {
  if (!input || Object.keys(input).some(key => !['kind', 'text', 'receiptIds', 'targetTurnId'].includes(key))
    || !['answer', 'correction', 'clarification', 'no_work'].includes(input.kind)
    || typeof input.text !== 'string' || input.text.length > LIMITS.result
    || (input.kind !== 'no_work' && !input.text.trim())
    || !Array.isArray(input.receiptIds) || input.receiptIds.length > LIMITS.tools
    || input.receiptIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
    || (input.targetTurnId !== undefined && !/^[a-zA-Z0-9-]{16,80}$/.test(input.targetTurnId))) {
    throw fail('CONVERSATION_WORK_RESULT_INVALID', 'A bounded structured result and exact receipt references are required.');
  }
  return { ...input, text: input.text.trim() };
}
module.exports = { OWNER, SCOPED, EXCHANGE_SCOPE, ACTIVE, LIMITS, hash, fail, notFound,
  sessionScope, eligible, tokenMatches, simple, validateResult };
