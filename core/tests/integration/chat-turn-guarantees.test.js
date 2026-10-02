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
jest.mock('../../src/services/chatService', () => {
  const { persistConversation } = jest.requireActual('../../src/services/chat/conversationPersistence');
  const persistTurn = (input) => persistConversation({
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
  return { status: response.status, terminal };
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
  ])('an %s conversationId is refused with 404 and nothing is forked', async (_label, makeId) => {
    const conversationId = await makeId();
    const before = await Conversation.find({}).lean();
    const result = await send(endpoint, { conversationId });
    if (isStream) {
      expect(result.terminal).toEqual({ event: 'error', data: expect.objectContaining({
        code: 'CONVERSATION_NOT_FOUND', statusCode: 404
      }) });
    } else {
      expect(result.status).toBe(404);
      expect(result.body.code).toBe('CONVERSATION_NOT_FOUND');
    }
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
