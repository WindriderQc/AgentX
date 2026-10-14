'use strict';
const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const { loadStoredTurns } = require('../../src/services/chat/conversationHistory');
const { SCHEMA, normalizeMessage } = require('../../../shared/answerBlocks');
const OWNER = 'table-history-owner';
const message = (content = 'These values remain uncertain.') => ({ role: 'assistant', content,
  answerBlocks: { schema: SCHEMA, blocks: [{ kind: 'table', title: 'Fixture results', columns: ['Name', 'Outcome'], rows: [['Example', 'Unknown']] }] } });
let harness;
beforeAll(async () => {
  const app = express(); app.use(express.json({ limit: '4mb' }));
  app.use((_req, res, next) => { res.locals.user = { userId: OWNER }; next(); });
  app.use('/api/history', require('../../routes/history'));
  harness = await startTestHttpHarness(app, { maxSockets: 4, transport: 'tcp' });
});
afterAll(async () => { await harness?.close(); });
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => { await Conversation.deleteMany({}); });

test('save -> paged canonical message -> both history aliases preserves blocks, IDs and context fallback', async () => {
  const first = await harness.request.post('/api/history').send({ messages: [{ role: 'user', content: 'Read this fixture.' }, message()] }).expect(200);
  const id = first.body.data.conversationId;
  const raw = await Conversation.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  expect(raw.messages).toEqual([]); expect(raw.transcript).toBeDefined();
  let previousId;
  for (const path of [`/api/history/${id}`, `/api/history/conversations/${id}`]) {
    const response = await harness.request.get(path).expect(200);
    const reply = response.body.data.messages[1];
    expect(reply.answerBlocks).toEqual(message().answerBlocks);
    expect(reply.content).toBe(normalizeMessage(message()).content);
    expect(reply._id).toMatch(/^[a-f0-9]{24}$/);
    if (previousId) expect(reply._id).toBe(previousId); previousId = reply._id;
  }
  const context = await loadStoredTurns({ conversationId: id, userId: OWNER });
  expect(context[1].content).toBe(normalizeMessage(message()).content);
  expect(Object.keys(context[1])).toEqual(['role', 'content']);
  const stored = await Conversation.findById(id); stored.title = 'Retitled'; await stored.save();
  expect((await Conversation.findById(id)).messages[1].content).toBe(context[1].content);
});

test('oversized full-message payload retains table data through payload hydration, export and erasure', async () => {
  const input = message('A complete narrative. '.repeat(60000));
  const response = await harness.request.post('/api/history').send({ messages: [input] }).expect(200);
  const id = response.body.data.conversationId;
  expect(await mongoose.connection.collection('conversation_payload_chunks').countDocuments({ owner: id })).toBeGreaterThan(0);
  const read = await harness.request.get(`/api/history/${id}`).expect(200);
  expect(read.body.data.messages[0].answerBlocks).toEqual(input.answerBlocks);
  expect(read.body.data.messages[0].content).toBe(normalizeMessage(input).content);
  const selected = await Conversation.findOne({ _id: id, 'messages.answerBlocks.schema': SCHEMA });
  expect(selected.messages[0].answerBlocks.toObject()).toEqual(input.answerBlocks);
  await harness.request.delete(`/api/history/${id}`).expect(200);
  expect(await mongoose.connection.collection('conversation_payload_chunks').countDocuments({ owner: id })).toBe(0);
  expect(await mongoose.connection.collection('conversation_transcript_pages').countDocuments({ owner: id })).toBe(0);
});

test('legacy text import and accessible table append retain existing message identity and do not duplicate fallback', async () => {
  const legacy = await harness.request.post('/api/history').send({ messages: [{ role: 'user', content: 'Original text.' }] }).expect(200);
  const id = legacy.body.data.conversationId;
  const before = await Conversation.findById(id);
  const normalized = normalizeMessage(message());
  await harness.request.post('/api/history').send({ conversationId: id, messages: [normalized] }).expect(200);
  const after = await Conversation.findById(id);
  expect(String(after.messages[0]._id)).toBe(String(before.messages[0]._id));
  expect(after.messages[1].content).toBe(normalized.content);
  expect(after.messages[0].answerBlocks).toBeUndefined();
});

test('invalid blocks reject the entire batch before creation or append', async () => {
  const row = await Conversation.create({ userId: OWNER, messages: [{ role: 'user', content: 'Keep me.' }] });
  const bad = message(); bad.answerBlocks.blocks[0].rows = [[3, 'No coercion']];
  for (const conversationId of [undefined, row.id]) {
    await harness.request.post('/api/history').send({ conversationId, messages: [{ role: 'user', content: 'Do not append.' }, bad] }).expect(400);
  }
  expect(await Conversation.countDocuments({})).toBe(1);
  expect((await Conversation.findById(row.id)).messages).toHaveLength(1);
});

test.each([{ userId: 'other-owner' }, { lifecycle: { status: 'archived' } }, { tags: ['agentx:internal-probe'] },
  { source: 'external', clientRef: 'benchmark-canary:fixture' }, { surface: 'psyx' }, { surfaceSession: { sessionId: 'fixture', packId: 'private', modeId: 'fixture', scopeId: 'fixture' } }])(
  'new table append/read cannot cross an inaccessible target: %p', async hidden => {
    const row = await Conversation.create({ userId: OWNER, messages: [normalizeMessage(message())], ...hidden });
    const count = await Conversation.countDocuments({});
    await harness.request.post('/api/history').send({ conversationId: row.id, messages: [message()] }).expect(404);
    await harness.request.get(`/api/history/${row.id}`).expect(404);
    await harness.request.get(`/api/history/conversations/${row.id}`).expect(404);
    expect(await Conversation.countDocuments({})).toBe(count);
    expect((await Conversation.findById(row.id)).messages).toHaveLength(1);
  });

test('explicit bad target never forks; hidden-source block creation is refused and ordinary external history works', async () => {
  for (const conversationId of ['invalid', null, new mongoose.Types.ObjectId().toString()]) {
    await harness.request.post('/api/history').send({ conversationId, messages: [message()] }).expect(conversationId && conversationId !== 'invalid' ? 404 : 400);
  }
  await harness.request.post('/api/history').send({ source: 'external', clientRef: 'benchmark-canary:fixture', messages: [message()] }).expect(400);
  expect(await Conversation.countDocuments({})).toBe(0);
  await harness.request.post('/api/history').send({ source: 'external', clientRef: 'ordinary-import', messages: [message()] }).expect(200);
});

test('previews, latest, search counts and tags exclude native hidden tables before projection', async () => {
  const visible = await Conversation.create({ userId: OWNER, title: 'Visible table', tags: ['visible-table'], messages: [normalizeMessage(message())] });
  const legacy = await Conversation.create({ userId: OWNER, title: 'Legacy surface text', surface: 'psyx', messages: [{ role: 'assistant', content: 'Legacy text.' }] });
  const hidden = await Conversation.create({ userId: OWNER, title: 'Hidden native table', surface: 'psyx', tags: ['hidden-table'], messages: [normalizeMessage(message())] });
  for (const path of ['/api/history', '/api/history/conversations']) {
    const response = await harness.request.get(path).expect(200);
    expect(response.body.data.map(row => row.id).sort()).toEqual([visible.id, legacy.id].sort());
  }
  const latest = await harness.request.get('/api/history/logs').expect(200);
  expect(latest.body.data.messages[0].content).toBe('Legacy text.');
  const search = await harness.request.get('/api/history/search?sortBy=date&limit=1').expect(200);
  expect(search.body.data.results).toHaveLength(1);
  expect(search.body.data.results[0]._id).toBe(legacy.id);
  expect(search.body.data.pagination.totalResults).toBe(2);
  const tags = await harness.request.get('/api/history/tags').expect(200);
  expect(tags.body.data.tags.map(row => row.tag)).toEqual(['visible-table']);
  expect((await Conversation.findById(hidden.id)).messages[0].answerBlocks).toBeDefined();
});

test('a changed target between the scoped read and save rejects the stale append', async () => {
  const row = await Conversation.create({ userId: OWNER, messages: [{ role: 'user', content: 'Original.' }] });
  const find = Conversation.findOne.bind(Conversation);
  jest.spyOn(Conversation, 'findOne').mockImplementationOnce(async (...args) => {
    const result = await find(...args);
    await Conversation.updateOne({ _id: row._id }, { $set: { 'lifecycle.status': 'archived' } });
    return result;
  });
  await harness.request.post('/api/history').send({ conversationId: row.id, messages: [message()] }).expect(409);
  expect((await Conversation.findById(row.id)).messages).toHaveLength(1);
});

test('a changed visibility predicate without a version change still refuses the exact append', async () => {
  const row = await Conversation.create({ userId: OWNER, messages: [{ role: 'user', content: 'Original.' }] });
  const find = Conversation.findOne.bind(Conversation);
  jest.spyOn(Conversation, 'findOne').mockImplementationOnce(async (...args) => {
    const result = await find(...args);
    await Conversation.collection.updateOne({ _id: row._id }, { $set: { surface: 'psyx' } });
    return result;
  });
  const response = await harness.request.post('/api/history').send({ conversationId: row.id, messages: [message()] }).expect(404);
  expect(response.body).toEqual({ status: 'error', code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
  expect((await Conversation.findById(row.id)).messages).toHaveLength(1);
  expect(await Conversation.countDocuments({})).toBe(1);
});
