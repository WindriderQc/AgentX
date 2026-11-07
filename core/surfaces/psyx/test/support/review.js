'use strict';
const assert = require('node:assert/strict');
const { createHarness } = require('./state');
const { replyTarget, CRITERIA } = require('../../../../src/domains/psyx/supervision');

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await tick(); }
  assert.fail('review did not reach the expected state');
}
function syntheticReply(target) {
  return { content: JSON.stringify({ digest: { summary: 'Digest ' + target.replyId },
    supervision: { replyId: target.replyId, replyHash: target.replyHash,
      observations: Object.fromEntries(CRITERIA.map(key => [key, { status: 'uncertain', reason: 'Contexte synthétique.' }])) } }) };
}
function setup({ complete, delayMs = 0, repository = null } = {}) {
  const stored = repository || createHarness().repository;
  const messages = [], calls = [];
  let exists = true;
  function append(id, { enrolled = true, epoch = null } = {}) {
    const ordinal = messages.length + 2;
    const control = { mode: 'talk', voice: false, ...(enrolled === null ? {} : { reviewRequested: enrolled, reviewEpoch: epoch }) };
    messages.push({ role: 'user', content: 'Contexte synthétique ' + id, ordinal: ordinal - 1 },
      { role: 'assistant', id, ordinal, content: 'Réponse synthétique ' + id + '?', control });
  }
  const conversationRepository = {
    context: async (_u, _c, limit, options) => !exists ? null : options?.withCoverage
      ? { messages: messages.slice(-limit), availableMessages: messages.length } : messages.slice(-limit),
    listSessionMetadata: async user => exists && user === 'u' ? [{ id: 'c', lifecycle: { status: 'active' } }] : []
  };
  const options = { config: { review: { delayMs } }, stateRepository: stored, conversationRepository, logger: {},
    provider: { complete: async request => {
      const target = JSON.parse(request.messages[1].content.split('\n')[1]).supervisionTarget;
      calls.push({ target, request });
      return complete ? complete(target, calls.length) : syntheticReply(target);
    } }
  };
  return { options, repository: stored, messages, calls, append, remove: () => { exists = false; } };
}
async function drain(reviewer) {
  await until(() => ['done', 'failed', 'uncertain'].includes(reviewer.status('u', 'c').status));
}

module.exports = { setup, until, drain, syntheticReply };
