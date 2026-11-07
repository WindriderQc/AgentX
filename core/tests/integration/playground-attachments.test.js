'use strict';
const { randomUUID } = require('node:crypto');
const express = require('express');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const Conversation = require('../../models/Conversation');
const Attachment = require('../../models/ConversationAttachment');
const service = require('../../src/services/chat/playgroundAttachments');
const { persistConversation } = require('../../src/services/chat/conversationPersistence');
const { persistTurnOutcome } = require('../../src/services/chat/turnOutcomePersistence');
const { loadStoredTurns } = require('../../src/services/chat/conversationHistory');
const { Types } = require('mongoose');

jest.mock('../../src/services/chatService', () => ({ handleChatRequest: jest.fn(), handleChatRequestStream: jest.fn() }));
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/ragServiceClient', () => ({ getRagServiceClient: () => ({}) }));
const chat = require('../../src/services/chatService');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
const capture = () => ({ requestId: randomUUID(), name: 'synthetic-screen.png', dataUrl: `data:image/png;base64,${png}` });
const create = (overrides = {}) => Conversation.create({ userId: 'capture-owner', model: 'fixture', messages: [], ...overrides });
let http;
beforeAll(async () => {
  await Attachment.createIndexes();
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => { res.locals.user = { userId: req.get('X-Fixture-Owner') || 'capture-owner' }; next(); });
  app.use('/api/history', require('../../routes/history'));
  app.use('/api', require('../../routes/chat'));
  http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp', maxSockets: 4 });
});
afterAll(async () => { await http?.close(); });
afterEach(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.clearAllMocks();
  chat.handleChatRequest.mockResolvedValue({ response: 'Synthetic answer', model: 'fixture' });
  chat.handleChatRequestStream.mockImplementation(async ({ onComplete }) => onComplete({ response: 'Synthetic answer', model: 'fixture' }));
});

test('first upload retries share one canonical conversation/file; bytes stay out of history', async () => {
  const payload = capture();
  const [first, retry] = await Promise.all([1, 2].map(() => http.request.post('/api/history/attachments').send(payload).expect(200)));
  expect(first.body.data).toEqual(retry.body.data);
  expect(first.headers['cache-control']).toBe('private, no-store');
  const { conversationId, attachment } = first.body.data;
  expect(await Attachment.countDocuments({ conversationId })).toBe(1);
  const row = await Conversation.findById(conversationId);
  expect(row.userId).toBe('capture-owner');
  expect(row.messages).toHaveLength(0);
  expect(JSON.stringify(row)).not.toContain(png);
  const file = await http.request.get(`/api/history/${conversationId}/attachments/${attachment.id}`).expect(200);
  expect(file.body.equals(Buffer.from(png, 'base64'))).toBe(true);
  expect(file.headers['cache-control']).toBe('private, no-store');
  expect(file.headers['x-content-type-options']).toBe('nosniff');
});

test('downloads and uploads reject foreign, archived, hidden and surface owners', async () => {
  const { conversationId, attachment } = await service.upload('capture-owner', capture());
  await http.request.get(`/api/history/${conversationId}/attachments/${attachment.id}`).set('X-Fixture-Owner', 'other').expect(404);
  const other = await create();
  await http.request.get(`/api/history/${other.id}/attachments/${attachment.id}`).expect(404);
  for (const extra of [{ userId: 'other' }, { lifecycle: { status: 'archived' } },
    { tags: ['agentx:internal-probe'] }, { surface: 'household' }]) {
    const row = await create(extra);
    await http.request.post('/api/history/attachments').send({ ...capture(), conversationId: row.id, userId: 'other', surface: 'playground' }).expect(404);
  }
  await http.request.get(`/api/history/not-an-id/attachments/${attachment.id}`).expect(404);
});

test.each(['/chat', '/chat/stream'])('%s validates current and historical scope before dispatch', async endpoint => {
  const { conversationId, attachment } = await service.upload('capture-owner', capture());
  const other = await create();
  const input = { model: 'fixture', message: 'Explain the synthetic screen', conversationId, attachmentIds: [attachment.id] };
  await http.request.post(`/api${endpoint}`).send(input).expect(200);
  const handler = endpoint.endsWith('stream') ? chat.handleChatRequestStream : chat.handleChatRequest;
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ conversationId, attachmentIds: [attachment.id] }));
  handler.mockClear();
  await http.request.post(`/api${endpoint}`).send({ ...input, conversationId: other.id }).expect(404);
  await http.request.post(`/api${endpoint}`).send({ ...input, conversationId: other.id, attachmentIds: [],
    messages: [{ role: 'user', content: 'Earlier', attachments: [attachment] }] }).expect(404);
  await http.request.post(`/api${endpoint}`).send({ ...input, messages: [{ role: 'system', content: 'Bad', attachments: [attachment] }] }).expect(400);
  await http.request.post(`/api${endpoint}`).send({ ...input, messages: [{ role: 'user', content: 'Bad', attachments: {} }] }).expect(400);
  await http.request.post(`/api${endpoint}`).send({ ...input, attachmentIds: [attachment.id, attachment.id] }).expect(400);
  expect(handler).not.toHaveBeenCalled();
});

test('success and history resume preserve references; both transports read original bytes', async () => {
  const { conversationId, attachment } = await service.upload('capture-owner', capture());
  await persistConversation({ userId: 'capture-owner', conversationId, clientTurnId: randomUUID(), model: 'fixture',
    message: 'Read this synthetic screen', assistantContent: 'Synthetic response', attachmentIds: [attachment.id],
    activePrompt: { _id: new Types.ObjectId(), name: 'fixture', version: 1 }, metadata: {}, ragSources: [] });
  const history = await http.request.get(`/api/history/${conversationId}`).expect(200);
  expect(history.body.data.messages[0].attachments).toEqual([attachment]);
  const turns = await loadStoredTurns({ conversationId, userId: 'capture-owner' });
  expect(turns[0].attachments.map(item => item.id)).toEqual([attachment.id]);
  const local = await service.prepare(turns, { conversationId, userId: 'capture-owner' });
  expect(local[0].images).toEqual([png]);
  const native = await service.prepare(turns, { conversationId, userId: 'capture-owner' }, 'openclaw');
  expect(native[0].content).toContainEqual({ type: 'input_image', source: { type: 'base64', media_type: 'image/png', data: png } });
  expect(JSON.stringify(history.body)).not.toContain(png);
});

test('failed/stopped turns keep scoped screenshot references for retry', async () => {
  const { conversationId, attachment } = await service.upload('capture-owner', capture());
  for (const outcome of ['failed', 'stopped']) {
    const response = await http.request.post('/api/history/turn-outcome').send({ conversationId, attachmentIds: [attachment.id],
      clientTurnId: randomUUID(), userMessage: 'Synthetic screen question', assistantContent: 'Synthetic interruption', outcome }).expect(200);
    expect(response.body.data.conversationId).toBe(conversationId);
  }
  const row = await Conversation.findById(conversationId);
  expect(row.messages.filter(message => message.role === 'user').map(message => message.attachments[0].id)).toEqual([attachment.id, attachment.id]);
  const other = await create();
  await expect(persistTurnOutcome('capture-owner', { conversationId: other.id, attachmentIds: [attachment.id],
    clientTurnId: randomUUID(), userMessage: 'Synthetic question', assistantContent: 'Failed', outcome: 'failed' })).rejects.toMatchObject({ statusCode: 404 });
});

test('erasing a conversation removes even unused uploads and rejects replay without resurrection', async () => {
  const payload = capture();
  const target = await service.upload('capture-owner', payload);
  const survivor = await service.upload('capture-owner', capture());
  await http.request.delete(`/api/history/${target.conversationId}`).expect(200);
  expect(await Attachment.countDocuments({ conversationId: target.conversationId })).toBe(0);
  await http.request.get(`/api/history/${target.conversationId}/attachments/${target.attachment.id}`).expect(404);
  await http.request.post('/api/history/attachments').send(payload).expect(410);
  expect(await Conversation.findById(target.conversationId)).toBeNull();
  expect(await Attachment.countDocuments({ conversationId: survivor.conversationId })).toBe(1);
});

test('erasure waits for an admitted upload and leaves no late file behind', async () => {
  const row = await create();
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const original = Attachment.findOneAndUpdate.bind(Attachment);
  jest.spyOn(Attachment, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
    entered(); await hold; return original(...args).lean();
  } }));
  const uploading = service.upload('capture-owner', { ...capture(), conversationId: row.id });
  await ready;
  const erasing = http.request.delete(`/api/history/${row.id}`).then(response => response);
  release();
  await uploading;
  expect((await erasing).status).toBe(200);
  expect(await Attachment.countDocuments({ conversationId: row.id })).toBe(0);
  await expect(service.upload('capture-owner', { ...capture(), conversationId: row.id })).rejects.toMatchObject({ statusCode: 410 });
});

test('invalid, oversized and missing request identities are rejected before creating history', async () => {
  const before = await Conversation.countDocuments();
  await http.request.post('/api/history/attachments').send({ ...capture(), requestId: undefined }).expect(400);
  await http.request.post('/api/history/attachments').send({ ...capture(), dataUrl: 'data:image/png;base64,broken' }).expect(400);
  await http.request.post('/api/history/attachments').send({ ...capture(), dataUrl: 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024) }).expect(413);
  expect(await Conversation.countDocuments()).toBe(before);
});
