'use strict';

// Inference is a CPU fixture. Session/transcript/attachment/recap persistence
// and scope enforcement use the real services and a disposable Mongo database.
jest.mock('../../src/extensions/trustedRuntimeServices', () => {
  const actual = jest.requireActual('../../src/extensions/trustedRuntimeServices');
  const execute = jest.fn(async () => ({ ok: true, body: { response: 'SYNTHETIC_REPLY' }, metadata: { model: 'synthetic' } }));
  const noteReads = jest.fn(), noteWrites = jest.fn(), ragReads = jest.fn();
  return { ...actual, executeForTest: execute, noteReads, noteWrites, ragReads,
    createTrustedRuntimeServices: (...args) => {
      const services = actual.createTrustedRuntimeServices(...args);
      return { ...services, inference: { execute }, memory: { ...services.memory,
        forAudience: (...args) => {
          const memory = services.memory.forAudience(...args);
          return { ...memory, search: (...args) => { ragReads(...args); return memory.search(...args); } };
        },
        notes: { ...services.memory.notes, forSpace: (...args) => {
          const notes = services.memory.notes.forSpace(...args);
          return { ...notes, search: (...args) => { noteReads(...args); return notes.search(...args); },
            record: (...args) => { noteWrites(...args); return notes.record(...args); } };
        } }
      } };
    } };
});
const knowledge = require('../../surfaces/household/nestor-knowledge');
const retrieval = jest.spyOn(knowledge, 'retrieve');
const recap = require('../../src/services/conversationRecapService');
const originalCreateRecaps = recap.createConversationRecapService;
const recapReads = jest.fn();
jest.spyOn(recap, 'createConversationRecapService').mockImplementation((...args) => {
  const actual = originalCreateRecaps(...args);
  return { ...actual, forSession(...args) {
    const service = actual.forSession(...args);
    return { ...service, read(...args) { recapReads(...args); return service.read(...args); },
      latest(...args) { recapReads(...args); return service.latest(...args); } };
  } };
});
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { app } = require('../../src/app');
const Conversation = require('../../models/Conversation');
const Attachment = require('../../models/ConversationAttachment');
const MemoryNote = require('../../models/MemoryNote');
const logger = require('../../config/logger');
const { executeForTest, noteReads, noteWrites, ragReads } = require('../../src/extensions/trustedRuntimeServices');
const base = '/api/voice-personas/private/sessions';
const create = async (body = {}) => (await request(app).post(base).send({ backend: 'agentx', ...body }).expect(201)).body.data.session;
const send = (session, text, extra = {}) => request(app).post(`${base}/${session.sessionId}/turns/text`)
  .send({ text, channel: 'text', ephemeral: session.ephemeral, turnId: randomUUID(), ...extra });
const change = async (session, ephemeral, extra = {}) => (await request(app).post(`${base}/${session.sessionId}/privacy`)
  .send({ ephemeral, ...extra }).expect(200)).body.data.session;
const contents = async () => {
  const collections = await mongoose.connection.db.listCollections().toArray();
  return JSON.stringify(await Promise.all(collections.map(row => mongoose.connection.db.collection(row.name).find({}).toArray())));
};
beforeEach(() => { jest.clearAllMocks(); });

test('an ephemeral conversation keeps active context and decoded attachments without durable history, memory or recap reads', async () => {
  const session = await create({ ephemeral: true });
  const upload = (await request(app).post(`${base}/${session.sessionId}/attachments`).send({ name: 'fixture.txt',
    dataUrl: 'data:text/plain;base64,' + Buffer.from('EPHEMERAL_ATTACHMENT_MARKER').toString('base64') }).expect(201)).body.data.attachment;
  await send(session, 'EPHEMERAL_FIRST_MARKER', { attachmentIds: [upload.id] }).expect(200);
  await send(session, 'EPHEMERAL_SECOND_MARKER').expect(200);
  const [body, options] = executeForTest.mock.calls.at(-1);
  expect(JSON.stringify(body.messages)).toContain('EPHEMERAL_FIRST_MARKER');
  expect(JSON.stringify(body.messages)).toContain('EPHEMERAL_ATTACHMENT_MARKER');
  expect(options.contentRetention).toBe('ephemeral');
  expect(noteReads).not.toHaveBeenCalled(); expect(noteWrites).not.toHaveBeenCalled();
  expect(retrieval).not.toHaveBeenCalled(); expect(ragReads).not.toHaveBeenCalled(); expect(recapReads).not.toHaveBeenCalled();
  expect(await Conversation.exists({ 'surfaceSession.sessionId': session.sessionId })).toBeNull();
  expect(await Attachment.findById(upload.id)).toBeNull();
  const persisted = await contents();
  for (const marker of ['EPHEMERAL_FIRST_MARKER', 'EPHEMERAL_SECOND_MARKER', 'EPHEMERAL_ATTACHMENT_MARKER']) expect(persisted).not.toContain(marker);
  await request(app).get(`${base}/${session.sessionId}/history`).expect(404);
  await request(app).get(`${base}/${session.sessionId}/export`).expect(404);
  await request(app).get(`${base}/${session.sessionId}/recap`).expect(404);
  await request(app).put(`${base}/${session.sessionId}/recap`).send({ summary: 'EPHEMERAL_RECAP_MARKER', revision: 0, sourceHash: '0'.repeat(64) }).expect(404);
  expect((await request(app).get(`${base}/recent?limit=5`).expect(200)).body.data.sessions.map(row => row.sessionId)).not.toContain(session.sessionId);
});

test('retained → ephemeral → retained preserves the old history, starts clean and never ingests/replays the transient segment', async () => {
  const retained = await create();
  await send(retained, 'RETAINED_BEFORE_MARKER').expect(200);
  expect(noteReads).toHaveBeenCalled(); expect(retrieval).toHaveBeenCalled();
  const original = await Conversation.findOne({ 'surfaceSession.sessionId': retained.sessionId }).lean();
  const transient = await change(retained, true);
  await send(transient, 'TRANSIENT_ONLY_MARKER').expect(200);
  expect(JSON.stringify(executeForTest.mock.calls.at(-1)[0].messages)).toContain('RETAINED_BEFORE_MARKER');
  const next = await change(transient, false);
  expect(next).toMatchObject({ ephemeral: false, ephemeralExplicit: true });
  expect(next.sessionId).not.toBe(retained.sessionId);
  await send(next, 'RETAINED_AFTER_MARKER').expect(200);
  const prompt = JSON.stringify(executeForTest.mock.calls.at(-1)[0]);
  expect(prompt).not.toContain('TRANSIENT_ONLY_MARKER'); expect(prompt).not.toContain('RETAINED_BEFORE_MARKER');
  expect(await Conversation.findOne({ 'surfaceSession.sessionId': retained.sessionId }).lean()).toEqual(original);
  const saved = await Conversation.findOne({ 'surfaceSession.sessionId': next.sessionId }).lean();
  expect(saved.surfaceSession.turnCount).toBe(1);
  expect(await contents()).not.toContain('TRANSIENT_ONLY_MARKER');
  expect(await MemoryNote.countDocuments({ text: /TRANSIENT_ONLY_MARKER/ })).toBe(0);
  await send(transient, 'LATE_TRANSIENT_CALLBACK_MARKER').expect(200);
  expect(await contents()).not.toContain('LATE_TRANSIENT_CALLBACK_MARKER');
  expect((await Conversation.findById(saved._id).lean()).surfaceSession.turnCount).toBe(1);
});

test('both real Open selectors default to ephemeral; explicit OFF works and native engines require an explicit direct choice', async () => {
  for (const body of [{ modeId: 'open' }, { inference: { open: true } }]) {
    expect((await create(body)).ephemeral).toBe(true);
    const retained = await create({ ...body, ephemeral: false });
    expect(retained).toMatchObject({ ephemeral: false, ephemeralExplicit: true });
  }
  const before = executeForTest.mock.calls.length;
  const refused = await request(app).post(base).send({ backend: 'openclaw', ephemeral: true }).expect(409);
  expect(refused.body.code).toBe('CONVERSATION_EPHEMERAL_UNSUPPORTED');
  const native = await create({ backend: 'openclaw' });
  const transient = await change(native, true, { backend: 'agentx' });
  expect(transient.backend).toBe('agentx');
  expect(executeForTest.mock.calls.length).toBe(before);
  await request(app).post(`${base}/${transient.sessionId}/privacy`).send({ ephemeral: false, ephemeralExplicit: false }).expect(400);
});

test('a streaming submission freezes its policy and blocks a concurrent transition; errors and retries stay transient', async () => {
  const session = await create({ ephemeral: true });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), completion = new Promise(resolve => { release = resolve; });
  executeForTest.mockImplementationOnce(async () => { entered(); return completion; });
  const pending = send(session, 'EPHEMERAL_IN_FLIGHT_MARKER', { stream: true }).then(response => response);
  await started;
  await request(app).post(`${base}/${session.sessionId}/privacy`).send({ ephemeral: false }).expect(409);
  release({ ok: true, body: { response: 'EPHEMERAL_STREAM_REPLY_MARKER' }, metadata: { model: 'synthetic' } });
  const response = await pending;
  expect(response.status).toBe(200); expect(response.text).toContain('EPHEMERAL_STREAM_REPLY_MARKER');
  expect(await contents()).not.toContain('EPHEMERAL_IN_FLIGHT_MARKER');
  const errors = jest.spyOn(logger, 'error').mockImplementation(() => {});
  try {
    executeForTest.mockRejectedValueOnce(new Error('EPHEMERAL_PROVIDER_ERROR_MARKER'));
    await send(session, 'EPHEMERAL_FAILURE_MARKER').expect(502);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('EPHEMERAL_PROVIDER_ERROR_MARKER');
    await send(session, 'EPHEMERAL_RETRY_MARKER').expect(200);
    expect(await contents()).not.toMatch(/EPHEMERAL_(FAILURE|RETRY|PROVIDER_ERROR)_MARKER/);
  } finally { errors.mockRestore(); }
});

test('contexts and attachments remain isolated across personal conversations and the family boundary', async () => {
  const first = await create({ ephemeral: true }), second = await create({ ephemeral: true });
  await send(first, 'ISOLATED_FIRST_CONTEXT').expect(200);
  await send(second, 'ISOLATED_SECOND_CONTEXT').expect(200);
  expect(JSON.stringify(executeForTest.mock.calls.at(-1)[0])).not.toContain('ISOLATED_FIRST_CONTEXT');
  await request(app).post(`/api/voice-personas/family/sessions/${first.sessionId}/turns/text`).send({ text: 'wrong scope' }).expect(403);
  await request(app).post(`/api/voice-personas/family/sessions/${first.sessionId}/turns/text`).send({ text: 'wrong scope and policy', ephemeral: false }).expect(403);
  await send(first, 'wrong policy', { ephemeral: false }).expect(409);
  const turnId = randomUUID();
  await send(second, 'EPHEMERAL_ONCE_ONLY', { turnId }).expect(200);
  const count = executeForTest.mock.calls.length;
  await send(second, 'EPHEMERAL_ONCE_ONLY', { turnId }).expect(409);
  expect(executeForTest.mock.calls.length).toBe(count);
});
