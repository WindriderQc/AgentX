'use strict';

jest.mock('../../src/extensions/trustedRuntimeServices', () => {
  const actual = jest.requireActual('../../src/extensions/trustedRuntimeServices');
  const execute = jest.fn(async () => ({ ok: true, metadata: { model: 'synthetic' },
    stream: require('node:stream').Readable.from([
      JSON.stringify({ message: { content: 'Réponse synthétique privée.' }, done: false }) + '\n',
      JSON.stringify({ model: 'synthetic', done: true, eval_count: 5 }) + '\n'
    ]), completion: Promise.resolve({ completed: true, terminalComplete: true }) }));
  return { ...actual, executeForTest: execute,
    createTrustedRuntimeServices: (...args) => ({ ...actual.createTrustedRuntimeServices(...args),
      inference: { execute }, routing: { getEffectiveSnapshot: async () => ({ tasks: { analysis: { model: 'synthetic' } } }) } }) };
});

process.env.PSYX_ACCESS_TOKEN = 'synthetic-psyx-access';
process.env.PSYX_LOOPBACK_BYPASS = 'false';
const request = require('supertest');
const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');
const { app } = require('../../src/app');
const { executeForTest } = require('../../src/extensions/trustedRuntimeServices');
const auth = req => req.set('Authorization', 'Bearer synthetic-psyx-access');
const done = response => JSON.parse(response.text.match(/event: done\ndata: ([^\n]+)/)[1]);

describe('PsyX built into Core with private scope', () => {
  beforeEach(async () => {
    await Conversation.deleteMany({});
    await mongoose.connection.db.collection('psyxstates').deleteMany({});
    executeForTest.mockClear();
  });

  test('locks private APIs, honors browser unlock/lock and leaves other Core surfaces untouched', async () => {
    const page = await request(app).get('/psyx').expect(200);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    await request(app).get('/api/psyx/state').expect(401);
    await request(app).get('/api/psyx/state').set('X-Forwarded-For', '127.0.0.1').expect(401);
    const browser = request.agent(app);
    await browser.post('/api/psyx/auth/unlock').send({ code: 'synthetic-psyx-access' }).expect(200);
    await browser.get('/api/psyx/state').expect(200);
    await browser.post('/api/psyx/auth/lock').send({}).expect(200);
    await browser.get('/api/psyx/state').expect(401);
    expect((await request(app).get('/health')).body.service).toBe('agentx-core');
    const dad = await request(app).get('/dad').expect(200);
    expect(String(dad.headers['content-security-policy'] || '')).not.toContain("frame-ancestors 'none'");
  });

  test('resumes one canonical transcript, preserves application actions and separates lifecycle from ordinary history', async () => {
    const first = done(await auth(request(app).post('/api/psyx/chat/stream')).send({ message: 'Synthetic private input' }).expect(200));
    const record = await Conversation.findById(first.conversationId).lean();
    expect(record).toMatchObject({ userId: 'surface:psyx:default', surface: 'psyx', promptName: 'psyx' });
    expect(record.messages).toHaveLength(2);
    await request(app).get(`/api/history/${first.conversationId}`).expect(404);
    const second = done(await auth(request(app).post('/api/psyx/chat/stream')).send({
      conversationId: first.conversationId, psyx: { action: 'deep_reflection', depth: 'deep' },
      messages: [{ role: 'system', content: 'Untrusted browser system prompt' }]
    }).expect(200));
    expect(second.conversationId).toBe(first.conversationId);
    const admitted = executeForTest.mock.calls.at(-1);
    expect(admitted[0].messages.some(m => m.content === 'Synthetic private input')).toBe(true);
    expect(JSON.stringify(admitted[0])).not.toContain('Untrusted browser system prompt');
    expect(admitted[0]).toMatchObject({ taskType: 'deep_reasoning', think: true });
    expect(admitted[1].consumerContract).toBe('psyx');
    const exported = (await auth(request(app).get('/api/psyx/export')).expect(200)).body;
    expect(exported.transcriptData.conversationCount).toBe(1);
    expect(exported.transcriptData.conversations[0].messages[2]).toMatchObject({ role: 'action', action: 'deep_reflection' });
    const session = `/api/psyx/sessions/${first.conversationId}`;
    await auth(request(app).post(`${session}/archive`)).send({}).expect(200);
    expect((await auth(request(app).get('/api/psyx/sessions')).expect(200)).body.data).toHaveLength(0);
    const calls = executeForTest.mock.calls.length;
    await auth(request(app).post('/api/psyx/chat/stream')).send({ conversationId: first.conversationId, message: 'After archive' }).expect(404);
    expect(executeForTest).toHaveBeenCalledTimes(calls);
    expect((await Conversation.findById(first.conversationId)).messages).toHaveLength(4);
    await auth(request(app).post(`${session}/restore`)).send({}).expect(200);
    await auth(request(app).patch(session)).send({ title: 'Renamed synthetic session' }).expect(200);
    await auth(request(app).delete(session)).send({}).expect(400);
    await auth(request(app).delete(session)).send({ confirmation: 'PERMANENTLY DELETE' }).expect(200);
    expect(await Conversation.findById(first.conversationId)).toBeNull();
    expect(await mongoose.connection.db.collection('psyxconversations').countDocuments()).toBe(0);
  });

  test('concurrent state writes retain one owner document, preserve provenance, and require explicit reset', async () => {
    await Promise.all(['First synthetic note', 'Second synthetic note'].map(text =>
      auth(request(app).post('/api/psyx/state/items/notes')).send({ text, confidence: 0.7, evidence: ['Synthetic evidence'] }).expect(200)));
    const state = (await auth(request(app).get('/api/psyx/state')).expect(200)).body.data;
    expect(state.notes).toHaveLength(2);
    expect(state.notes[0]).toMatchObject({ source: 'user', confidence: 0.7, evidence: ['Synthetic evidence'] });
    expect(await mongoose.connection.db.collection('psyxstates').countDocuments()).toBe(1);
    await auth(request(app).post('/api/psyx/state/reset')).send({}).expect(400);
    await auth(request(app).post('/api/psyx/state/reset')).send({ confirmation: 'RESET PSYX MEMORY' }).expect(200);
    expect((await auth(request(app).get('/api/psyx/state')).expect(200)).body.data.notes).toHaveLength(0);
    await auth(request(app).post('/api/psyx/state/items/unknown')).send({ text: 'ignored' }).expect(404);
  });
});
