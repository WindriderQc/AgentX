// A terminal turn outcome is owned by the server-resolved identity and can
// only reach Playground conversations, whatever the request body claims.
const express = require('express');
const Conversation = require('../../models/Conversation');
const { startTestHttpHarness } = require('../helpers/testHttpServer');

let harness;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.user = { userId: 'outcome-owner' };
    next();
  });
  app.use('/api/history', require('../../routes/history'));
  harness = await startTestHttpHarness(app, {
    maxSockets: 4,
    transport: process.platform === 'win32' ? 'pipe' : 'tcp'
  });
});
afterAll(async () => { await harness?.close(); });

function outcome(overrides = {}) {
  return {
    clientTurnId: `turn-${Math.random().toString(36).slice(2)}`,
    userMessage: 'A fictional question.',
    assistantContent: 'The request failed. Retry.',
    outcome: 'failed',
    ...overrides
  };
}

test('a body userId is ignored and the server identity owns the new conversation', async () => {
  const response = await harness.request.post('/api/history/turn-outcome')
    .send(outcome({ userId: 'surface:psyx:victim' })).expect(200);
  const stored = await Conversation.findById(response.body.data.conversationId).lean();
  expect(stored.userId).toBe('outcome-owner');
  expect(await Conversation.countDocuments({ userId: 'surface:psyx:victim' })).toBe(0);
});

test.each([
  ['psyx', 'surface:psyx:victim'],
  ['household', 'surface:household:pack:child']
])('a %s surface conversation cannot be appended to, even with its userId in the body', async (surface, userId) => {
  const target = await Conversation.create({
    userId, surface, title: 'Surface session', model: 'fixture-model',
    messages: [{ role: 'user', content: 'Original surface message.' }]
  });
  const response = await harness.request.post('/api/history/turn-outcome')
    .send(outcome({ userId, conversationId: target.id })).expect(404);
  expect(response.body.code).toBe('CONVERSATION_NOT_FOUND');
  const retained = await Conversation.findById(target.id).lean();
  expect(retained.messages.map(message => message.content)).toEqual(['Original surface message.']);
});

test('a surface conversation sharing the owner userId is still unreachable', async () => {
  const target = await Conversation.create({
    userId: 'outcome-owner', surface: 'household', title: 'Collision', model: 'fixture-model',
    messages: [{ role: 'user', content: 'Original surface message.' }]
  });
  await harness.request.post('/api/history/turn-outcome')
    .send(outcome({ conversationId: target.id })).expect(404);
  expect((await Conversation.findById(target.id).lean()).messages).toHaveLength(1);
});

test('an owned Playground conversation still receives the outcome', async () => {
  const target = await Conversation.create({
    userId: 'outcome-owner', title: 'Playground', model: 'fixture-model',
    messages: [{ role: 'user', content: 'Hello' }]
  });
  const response = await harness.request.post('/api/history/turn-outcome')
    .send(outcome({ conversationId: target.id, userId: 'someone-else' })).expect(200);
  expect(response.body.data).toEqual(expect.objectContaining({
    conversationId: target.id, outcome: 'failed', idempotent: false
  }));
  expect((await Conversation.findById(target.id).lean()).messages).toHaveLength(3);
});
