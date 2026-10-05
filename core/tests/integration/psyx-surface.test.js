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
// The background review is covered by the surface tests; here it must not add
// inference calls in the middle of the exact call counts below.
process.env.PSYX_REVIEW_DELAY_MS = '600000';
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

  test('opens human LAN APIs directly and preserves explicit native bearer validation', async () => {
    const page = await request(app).get('/psyx').expect(200);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    await request(app).get('/api/psyx/state').expect(200);
    await request(app).get('/api/psyx/state').set('Authorization', 'Bearer invalid').expect(401);
    const browser = request.agent(app);
    await browser.get('/api/psyx/state').expect(200);
    await browser.get('/panel').expect(200);
    await browser.get('/api/psyx/state').expect(200);
    await browser.post('/api/psyx/auth/unlock').send({ code: 'synthetic-psyx-access' }).expect(404);
    expect((await request(app).get('/health')).body.service).toBe('agentx-core');
    const dad = await request(app).get('/dad').expect(200);
    expect(String(dad.headers['content-security-policy'] || '')).not.toContain("frame-ancestors 'none'");
  });

  test('voice assets are shared and spoken turns use PsyX admission without changing typed instructions', async () => {
    const page = await request(app).get('/psyx').expect(200);
    expect(page.text).toContain('voiceSessionDialog');
    const asset = await request(app).get('/js/voice/browser-conversation.js').expect(200);
    expect(asset.text).toContain('root.AgentXVoice = api');
    const compatible = await request(app).get('/assets/household/browser-conversation.js').expect(200);
    expect(compatible.text).toBe(asset.text);
    await request(app).get('/assets/household/voice-capture-worklet.js').expect(200);
    await auth(request(app).post('/api/psyx/chat/stream')).send({ message: 'Synthetic voice input', psyx: { source: 'voice' } }).expect(200);
    const voice = executeForTest.mock.calls.at(-1);
    expect(voice[1].consumerContract).toBe('psyx');
    expect(JSON.stringify(voice[0].messages)).toContain('This is a spoken turn');
    await auth(request(app).post('/api/psyx/chat/stream')).send({ message: 'Synthetic typed input' }).expect(200);
    expect(JSON.stringify(executeForTest.mock.calls.at(-1)[0].messages)).not.toContain('This is a spoken turn');
  });

  test('resumes one canonical transcript, preserves application actions and separates lifecycle from ordinary history', async () => {
    const first = done(await auth(request(app).post('/api/psyx/chat/stream')).send({ message: 'Synthetic private input' }).expect(200));
    const record = await Conversation.findById(first.conversationId).lean();
    expect(record).toMatchObject({ userId: 'surface:psyx:default', surface: 'psyx', promptName: 'psyx' });
    expect(record.messages).toHaveLength(2);
    expect(first.review).toEqual({ scheduled: true });
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

  test('accepted review observations remain correctable with atomic revision and original provenance', async () => {
    const { createStateRepository } = require('../../src/domains/psyx/stateRepository');
    const { readReview } = require('../../src/domains/psyx/review');
    const repository = createStateRepository({ collection: mongoose.connection.collection('psyxstates') });
    const reviewed = readReview({ proposals: [{ kind: 'hypotheses', text: 'Synthetic hypothesis', evidence: ['Synthetic user statement'] }] }, { conversationId: 'synthetic-origin' });
    await repository.recordReview('default', { conversationId: 'synthetic-origin', ...reviewed });
    let state = (await auth(request(app).get('/api/psyx/state')).expect(200)).body.data;
    await auth(request(app).post(`/api/psyx/state/proposals/${state.proposals[0].id}/accept`)).send({}).expect(200);
    state = (await auth(request(app).get('/api/psyx/state')).expect(200)).body.data;
    const item = state.hypotheses[0];
    const url = `/api/psyx/state/items/hypotheses/${item.id}`;
    await request(app).patch(url).set('Authorization', 'Bearer invalid-native-token').send({ text: 'Unauthorized', expectedRevision: state.revision }).expect(401);
    const corrected = (await auth(request(app).patch(url)).send({ text: 'User corrected hypothesis', expectedRevision: state.revision }).expect(200)).body.data.state;
    expect(corrected.hypotheses[0]).toMatchObject({ text: 'User corrected hypothesis', sourceConversationId: 'synthetic-origin', correctedBy: 'user', evidence: ['Synthetic user statement'] });
    await auth(request(app).patch(url)).send({ text: 'Stale', expectedRevision: state.revision }).expect(409);
    const prompt = (await auth(request(app).get('/api/psyx/state/prompt-context')).expect(200)).body.data;
    expect(prompt.hypotheses[0].text).toBe('User corrected hypothesis');
    await auth(request(app).post('/api/psyx/state/reset')).send({ confirmation: 'RESET PSYX MEMORY' }).expect(200);
    await auth(request(app).patch(url)).send({ text: 'Resurrected', expectedRevision: corrected.revision }).expect(404);
  });

});
