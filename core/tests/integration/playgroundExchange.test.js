'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/ragServiceClient', () => ({ getRagServiceClient: () => ({}) }));
const mockGeneration = { calls: 0, entered: null, gate: null };
jest.mock('../../src/services/chatService', () => {
  const { persistConversation } = jest.requireActual('../../src/services/chat/conversationPersistence');
  async function generate(input) {
    mockGeneration.calls++;
    mockGeneration.entered?.();
    if (mockGeneration.gate) await mockGeneration.gate;
    const saved = await persistConversation({ ...input, model: 'synthetic-model', effectiveSystemPrompt: 'Synthetic instructions',
      assistantContent: 'Synthetic réponse complète', activePrompt: { name: 'default_chat', version: 1 }, metadata: {} });
    return { response: 'Synthetic réponse complète', model: 'synthetic-model', conversationId: saved.conversation.id,
      messageId: saved.assistantMessageId };
  }
  return { handleChatRequest: generate,
    handleChatRequestStream: async input => {
      input.onToken('Synthetic réponse complète');
      input.onComplete(await generate(input));
    } };
});
const Conversation = require('../../models/Conversation');
const exchanges = require('../../src/services/conversations/exchangeReceipts');
const collection = name => mongoose.connection.collection(name);
let harness;
beforeAll(async () => {
  await Conversation.createCollection();
  await Conversation.createIndexes();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.user = { userId: 'synthetic-owner' }; next(); });
  app.use('/api', require('../../routes/chat'));
  app.use('/api/history', require('../../routes/history'));
  harness = await startTestHttpHarness(app, { maxSockets: 8 });
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => {
  mockGeneration.calls = 0; mockGeneration.entered = null; mockGeneration.gate = null;
  await Conversation.deleteMany({});
  for (const name of ['conversation_exchange_receipts', 'conversation_exchange_packets', 'conversation_payload_chunks', 'conversation_write_fences']) {
    await collection(name).deleteMany({});
  }
});

test('a refused request remains recoverable through the owner route before any inference', async () => {
  const input = { model: 'synthetic-model', message: '   ', clientTurnId: 'refused-turn' };
  const response = await harness.request.post('/api/chat').send(input).expect(400);
  const id = response.headers['x-agentx-receipt-id'];
  const recovered = await harness.request.get(`/api/history/receipts/${id}`).expect(200);
  expect(recovered.headers['cache-control']).toContain('no-store');
  expect(recovered.body.data.request.body).toEqual(input);
  expect(recovered.body.data.response.body).toBe(response.text);
  expect(mockGeneration.calls).toBe(0);
  const listed = await harness.request.get('/api/history/receipts').expect(200);
  expect(listed.body.data).toEqual([expect.objectContaining({ id, statusCode: 400 })]);
  expect(JSON.stringify(listed.body.data)).not.toContain('message');
  await harness.request.delete(`/api/history/receipts/${id}`).expect(200);
  await harness.request.get(`/api/history/receipts/${id}`).expect(404);
  await harness.request.post('/api/chat').set('Idempotency-Key', 'replacement-key').send(input).expect(410);
  expect(mockGeneration.calls).toBe(0);
});

test('deleting a historical conversation also rejects late outcomes and a new exchange key for its turn', async () => {
  const input = { clientTurnId: 'historical-turn', userMessage: 'Older synthetic request',
    assistantContent: 'Interrupted synthetic response', outcome: 'stopped' };
  const saved = await harness.request.post('/api/history/turn-outcome').send(input).expect(200);
  await harness.request.delete(`/api/history/${saved.body.data.conversationId}`).expect(200);
  await harness.request.post('/api/history/turn-outcome').send(input).expect(410);
  await harness.request.post('/api/chat').set('Idempotency-Key', 'different-new-key')
    .send({ clientTurnId: input.clientTurnId, model: 'synthetic-model', message: input.userMessage }).expect(410);
  expect(mockGeneration.calls).toBe(0);
  expect(await Conversation.countDocuments({})).toBe(0);
});

test('completed SSE bytes replay exactly and deleting the conversation purges its recovery content', async () => {
  const input = { model: 'synthetic-model', message: 'Original synthetic request', clientTurnId: 'stream-turn' };
  const first = await harness.request.post('/api/chat/stream').send(input).expect(200);
  const id = first.headers['x-agentx-receipt-id'];
  const copy = await harness.request.post('/api/chat/stream').send(input).expect(200);
  expect(copy.text).toBe(first.text);
  expect(copy.headers['x-agentx-receipt-replayed']).toBe('true');
  expect(mockGeneration.calls).toBe(1);
  const recovered = await harness.request.get(`/api/history/receipts/${id}`).expect(200);
  expect(recovered.body.data.response.body).toBe(first.text);
  const row = await Conversation.findOne({ userId: 'synthetic-owner' });
  await harness.request.delete(`/api/history/${row.id}`).expect(200);
  await harness.request.get(`/api/history/receipts/${id}`).expect(404);
  expect(await collection('conversation_exchange_packets').countDocuments({ receiptId: id })).toBe(0);
  expect(await collection('conversation_payload_chunks').countDocuments({ owner: `exchange:${id}` })).toBe(0);
  await harness.request.post('/api/history/turn-outcome').send({ clientTurnId: 'stream-turn',
    model: 'synthetic-model', userMessage: input.message, assistantContent: 'Late stopped attempt', outcome: 'stopped' }).expect(410);
  expect(await Conversation.countDocuments({})).toBe(0);
});

test('erasing an accepted first turn during inference prevents its late canonical publication', async () => {
  let release;
  mockGeneration.gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { mockGeneration.entered = resolve; });
  const input = { model: 'synthetic-model', message: 'Erase while generating', clientTurnId: 'erased-active-turn' };
  const pending = harness.request.post('/api/chat').send(input).then(response => response, error => error);
  await entered;
  const receipt = await collection('conversation_exchange_receipts').findOne({ clientTurnId: input.clientTurnId });
  try { await harness.request.delete(`/api/history/receipts/${receipt._id}`).expect(200); }
  finally { release(); }
  const ended = await pending;
  expect(ended.status === 200).toBe(false);
  expect(await Conversation.countDocuments({})).toBe(0);
  expect(await exchanges.read(receipt.scope, receipt._id)).toBeNull();
  await harness.request.post('/api/history/turn-outcome').send({ clientTurnId: input.clientTurnId,
    userMessage: input.message, assistantContent: 'Late browser error', outcome: 'failed' }).expect(410);
  expect(await Conversation.countDocuments({})).toBe(0);
});

test('a public receipt field cannot select another owner or widen recovery/erasure', async () => {
  const { receipt: foreign } = await exchanges.accept('playground:another-owner', { body: { message: 'Foreign synthetic content' } });
  const response = await harness.request.post('/api/chat').send({ model: 'synthetic-model', message: 'Own synthetic request',
    exchangeReceiptId: foreign._id, userId: 'another-owner' }).expect(200);
  expect(response.headers['x-agentx-receipt-id']).not.toBe(foreign._id);
  await harness.request.get(`/api/history/receipts/${foreign._id}`).expect(404);
  await harness.request.delete(`/api/history/receipts/${foreign._id}`).expect(404);
  expect(await exchanges.read(foreign.scope, foreign._id)).toMatchObject({ state: 'accepted' });
});

test('older recovery copies remain reachable with an owner-scoped cursor and no content previews', async () => {
  await collection('conversation_exchange_receipts').insertMany(Array.from({ length: 53 }, (_, index) => ({
    _id: String(index).padStart(64, '0'), scope: 'playground:synthetic-owner', state: 'accepted',
    createdAt: new Date(1000 + index), fingerprint: 'synthetic-identity'
  })));
  const first = await harness.request.get('/api/history/receipts').expect(200);
  expect(first.body.data).toHaveLength(50);
  expect(first.body.nextCursor).toEqual(expect.any(String));
  const next = await harness.request.get('/api/history/receipts').query({ cursor: first.body.nextCursor }).expect(200);
  expect(next.body.data).toHaveLength(3);
  expect(next.body.nextCursor).toBeNull();
  expect(new Set([...first.body.data, ...next.body.data].map(row => row.id)).size).toBe(53);
  await harness.request.get('/api/history/receipts').query({ cursor: 'invalid' }).expect(400);
});
