'use strict';

// Playground turn guarantees observed through the real chat routes and the
// real persistence layer on Mongo. Only inference is stubbed: the stub hands
// the request to persistConversation exactly as chatService/chatServiceStream
// do after a successful generation.
const express = require('express');
const mongoose = require('mongoose');
const { startTestHttpHarness } = require('../helpers/testHttpServer');

jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/ragServiceClient', () => ({ getRagServiceClient: () => ({}) }));
const mockInference = { calls: 0 };
jest.mock('../../src/services/chatService', () => {
  const { persistConversation } = jest.requireActual('../../src/services/chat/conversationPersistence');
  const persistTurn = (input) => {
    mockInference.calls += 1;
    return persistConversation({
      userId: input.userId,
      conversationId: input.conversationId,
      clientTurnId: input.clientTurnId,
      model: 'fixture-model',
      effectiveSystemPrompt: 'Fixture system prompt',
      message: input.message,
      assistantContent: 'Fixture reply',
      activePrompt: { name: 'default_chat', version: 1 },
      metadata: {}
    });
  };
  const receipt = ({ conversation, assistantMessageId }) => ({
    response: 'Fixture reply', model: 'fixture-model',
    conversationId: conversation?._id || null, messageId: assistantMessageId
  });
  return {
    handleChatRequest: async (input) => receipt(await persistTurn(input)),
    handleChatRequestStream: async (input) => {
      try {
        input.onToken('Fixture reply');
        input.onComplete(receipt(await persistTurn(input)));
      } catch (err) {
        input.onError(err);
      }
    }
  };
});

const Conversation = require('../../models/Conversation');

let harness;
beforeAll(async () => {
  await Conversation.createCollection();
  await Conversation.createIndexes();
  const app = express();
  app.use(express.json());
  app.use('/api', require('../../routes/chat'));
  app.use('/api/history', require('../../routes/history'));
  harness = await startTestHttpHarness(app, {
    maxSockets: 8,
    transport: process.platform === 'win32' ? 'pipe' : 'tcp'
  });
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  await Conversation.deleteMany({});
});

function sseEvents(text) {
  return String(text || '').split('\n\n').filter(Boolean).map((frame) => {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    return event ? { event, data: data ? JSON.parse(data) : null } : null;
  }).filter(Boolean);
}

async function send(endpoint, body) {
  const response = await harness.request.post(`/api${endpoint}`)
    .send({ model: 'fixture-model', message: 'A fictional question.', ...body });
  if (!endpoint.endsWith('stream')) return { status: response.status, body: response.body };
  const events = sseEvents(response.text);
  const terminal = events.find(({ event }) => event === 'done' || event === 'error');
  return { status: response.status, terminal, body: response.body };
}

async function playground(overrides = {}) {
  return Conversation.create({
    userId: 'default', title: 'Fixture', model: 'fixture-model',
    messages: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Earlier reply' }],
    ...overrides
  });
}

describe.each(['/chat', '/chat/stream'])('%s honest save state', (endpoint) => {
  const isStream = endpoint.endsWith('stream');

  test('a failed save reaches the client as an error, not a receipt', async () => {
    jest.spyOn(Conversation.prototype, 'save').mockRejectedValueOnce(new Error('fixture write failure'));
    const result = await send(endpoint, {});
    if (isStream) {
      expect(result.terminal).toEqual({ event: 'error', data: expect.objectContaining({
        code: 'CONVERSATION_PERSIST_FAILED', statusCode: 503
      }) });
    } else {
      expect(result.status).toBe(503);
      expect(result.body).toEqual(expect.objectContaining({ status: 'error', code: 'CONVERSATION_PERSIST_FAILED' }));
    }
    expect(await Conversation.countDocuments({})).toBe(0);
  });

  test.each([
    ['unknown', async () => new mongoose.Types.ObjectId().toHexString()],
    ['archived', async () => (await playground({ lifecycle: { status: 'archived', archivedAt: new Date() } })).id],
    ['invalid', async () => 'not-an-object-id']
  ])('an %s conversationId is refused with 404 before inference', async (_label, makeId) => {
    const conversationId = await makeId();
    const before = await Conversation.find({}).lean();
    mockInference.calls = 0;
    const result = await send(endpoint, { conversationId });
    // Refused before inference, so the stream route answers before opening SSE.
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('CONVERSATION_NOT_FOUND');
    expect(mockInference.calls).toBe(0);
    expect(await Conversation.find({}).lean()).toEqual(before);
  });

  test('an existing active conversation still receives the turn', async () => {
    const target = await playground();
    const result = await send(endpoint, { conversationId: target.id });
    const conversationId = isStream ? result.terminal.data.conversationId : result.body.data.conversationId;
    expect(String(conversationId)).toBe(target.id);
    expect((await Conversation.findById(target.id).lean()).messages).toHaveLength(4);
  });
});

test('archiving during inference is not overwritten by the reply save', async () => {
  const target = await playground();
  const { persistConversation } = require('../../src/services/chat/conversationPersistence');
  const realFindOne = Conversation.findOne.bind(Conversation);
  jest.spyOn(Conversation, 'findOne').mockImplementationOnce(async (...args) => {
    const loaded = await realFindOne(...args);
    await Conversation.updateOne({ _id: target._id }, { $set: { 'lifecycle.status': 'archived' } });
    return loaded;
  });
  await expect(persistConversation({
    userId: 'default', conversationId: target.id, model: 'fixture-model', message: 'Late question',
    assistantContent: 'Late reply', activePrompt: { name: 'default_chat', version: 1 }, metadata: {}
  })).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND', statusCode: 404 });
  expect((await Conversation.findById(target.id).lean()).messages).toHaveLength(2);
});

test('GET /api/history/:id does not reopen an archived conversation', async () => {
  const archived = await playground({ lifecycle: { status: 'archived', archivedAt: new Date() } });
  const active = await playground();
  const refused = await harness.request.get(`/api/history/${archived.id}`).expect(404);
  expect(refused.body.code).toBe('CONVERSATION_NOT_FOUND');
  await harness.request.get(`/api/history/${active.id}`).expect(200);
});

describe('idempotent turns', () => {
  const outcome = (overrides = {}) => ({
    clientTurnId: 'terminal:u-1:fixture-turn',
    userMessage: 'A fictional question.',
    assistantContent: 'The request failed. Retry.',
    outcome: 'failed',
    ...overrides
  });
  const postOutcome = (body) => harness.request.post('/api/history/turn-outcome').send(body);
  const turnCount = (messages, clientTurnId) => messages
    .filter(message => message.metadata?.clientTurnId === clientTurnId).length;

  test('five concurrent outcomes for a first turn create one conversation and one pair', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => postOutcome(outcome())));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
    const rows = await Conversation.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].messages).toHaveLength(2);
    expect(new Set(responses.map(response => response.body.data.conversationId))).toEqual(new Set([String(rows[0]._id)]));
    expect(responses.filter(response => response.body.data.idempotent === false)).toHaveLength(1);
  });

  test('five concurrent outcomes for an existing conversation append one pair', async () => {
    const target = await playground();
    const responses = await Promise.all(Array.from({ length: 5 }, () => postOutcome(outcome({ conversationId: target.id }))));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
    const stored = await Conversation.findById(target.id).lean();
    expect(stored.messages).toHaveLength(4);
    expect(new Set(responses.map(response => response.body.data.assistantMessageId)).size).toBe(1);
    expect(await Conversation.countDocuments({})).toBe(1);
  });

  describe.each(['/chat', '/chat/stream'])('%s with a clientTurnId', (endpoint) => {
    const receiptOf = (result) => (endpoint.endsWith('stream') ? result.terminal.data : result.body.data);

    test('a repeated first turn creates one conversation, sequentially or concurrently', async () => {
      const first = await send(endpoint, { clientTurnId: 'turn-new-1' });
      const again = await send(endpoint, { clientTurnId: 'turn-new-1' });
      expect(String(receiptOf(again).conversationId)).toBe(String(receiptOf(first).conversationId));
      expect(String(receiptOf(again).messageId)).toBe(String(receiptOf(first).messageId));
      const burst = await Promise.all(Array.from({ length: 5 }, () => send(endpoint, { clientTurnId: 'turn-new-2' })));
      expect(new Set(burst.map(result => String(receiptOf(result).conversationId))).size).toBe(1);
      const rows = await Conversation.find({}).lean();
      expect(rows).toHaveLength(2);
      rows.forEach(row => expect(row.messages).toHaveLength(2));
    });

    test('a repeated turn on an existing conversation is stored once', async () => {
      const target = await playground();
      const burst = await Promise.all(Array.from({ length: 5 }, () => send(endpoint, {
        conversationId: target.id, clientTurnId: 'turn-existing-1'
      })));
      burst.forEach(result => expect(String(receiptOf(result).conversationId)).toBe(target.id));
      await send(endpoint, { conversationId: target.id, clientTurnId: 'turn-existing-1' });
      const stored = await Conversation.findById(target.id).lean();
      expect(stored.messages).toHaveLength(4);
      expect(turnCount(stored.messages, 'turn-existing-1')).toBe(2);
      await send(endpoint, { conversationId: target.id, clientTurnId: 'turn-existing-2' });
      expect((await Conversation.findById(target.id).lean()).messages).toHaveLength(6);
    });

    test('an outcome posted for a turn that was in fact stored returns that turn', async () => {
      const completed = receiptOf(await send(endpoint, { clientTurnId: 'turn-lost-done' }));
      const response = await postOutcome(outcome({
        clientTurnId: 'turn-lost-done', conversationId: String(completed.conversationId)
      })).expect(200);
      expect(response.body.data).toEqual(expect.objectContaining({
        conversationId: String(completed.conversationId),
        assistantMessageId: String(completed.messageId),
        outcome: 'completed',
        idempotent: true
      }));
      expect((await Conversation.findById(completed.conversationId).lean()).messages).toHaveLength(2);
    });

    test('a malformed clientTurnId is rejected before dispatch', async () => {
      const response = await harness.request.post(`/api${endpoint}`)
        .send({ model: 'fixture-model', message: 'Hello', clientTurnId: 'has spaces' });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('CHAT_REQUEST_INVALID');
    });
  });
});
