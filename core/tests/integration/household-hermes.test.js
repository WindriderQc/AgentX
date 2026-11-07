'use strict';

process.env.HOUSEHOLD_HERMES_URL = 'http://hermes.fixture';
process.env.HOUSEHOLD_HERMES_TOKEN = 'synthetic-private-server-token';
process.env.HOUSEHOLD_PERSONAL_CONVERSATION_BACKEND = 'hermes';
const nativeCalls = [];
const originalFetch = global.fetch;
global.fetch = jest.fn(async (url, options = {}) => {
  const path = new URL(url).pathname;
  if (!String(url).startsWith('http://hermes.fixture/')) throw new Error('Unexpected external request in isolated Hermes test');
  nativeCalls.push({ path, ...options });
  if (path === '/v1/runs') return Response.json({ run_id: 'run_fixture' });
  if (path.endsWith('/events')) return new Response('data: {"event":"message.delta","run_id":"run_fixture","delta":"Bonjour, réponse synthétique."}\n\n');
  return Response.json({ run_id: 'run_fixture', status: 'completed', completed: true, partial: false,
    output: 'Bonjour, réponse synthétique.', runtime: { provider: 'openai-codex', model: 'synthetic-served-model' }, usage: { input_tokens: 10 } });
});
const request = require('supertest');
const { app } = require('../../src/app');
const Conversation = require('../../models/Conversation');
const base = '/api/voice-personas/private/sessions';

afterAll(() => { global.fetch = originalFetch; });

test('the personal surface persists Hermes, streams through its existing reply path and records native receipts', async () => {
  const catalog = (await request(app).get('/api/voice-personas/catalog').expect(200)).body.data;
  expect(catalog.runtime).toMatchObject({ hermesConfigured: true, defaultBackend: 'hermes' });
  expect(JSON.stringify(catalog)).not.toContain('synthetic-private-server-token');
  const session = (await request(app).post(base).send({ packId: 'personal_operator', backend: 'hermes' }).expect(201)).body.data.session;
  expect(session.backend).toBe('hermes');
  const turnId = require('node:crypto').randomUUID();
  const response = await request(app).post(`${base}/${session.sessionId}/turns/text`)
    .send({ text: 'Explique pourquoi les roues tournent.', turnId, stream: true }).expect(200);
  const events = response.text.trim().split('\n').map(line => JSON.parse(line));
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  expect(events.filter(event => event.type === 'delta').map(event => event.delta).join('')).toContain('réponse synthétique');
  const done = events.find(event => event.type === 'done').data;
  expect(done.routing).toMatchObject({ backend: 'hermes', source: 'hermes/nestor' });
  expect(done.model.model).toBe('synthetic-served-model');
  const saved = await Conversation.findOne({ 'surfaceSession.sessionId': session.sessionId }).lean();
  expect(saved.surfaceSession.hermesRuntime).toMatchObject({ runId: 'run_fixture', state: 'completed', receipt: { usage: { input_tokens: 10 } } });
  expect(saved.surfaceSession.agentSessionKey).toBe('agentx:personal:' + session.sessionId);
  const body = JSON.parse(nativeCalls.find(call => call.path === '/v1/runs').body);
  expect(body.instructions).toContain('Hermes owns its native agent loop');
  expect(body.instructions).not.toContain('This Household conversation uses the selected OpenClaw agent');
});

test('family and open-model sessions cannot select Hermes', async () => {
  const before = nativeCalls.length;
  await request(app).post('/api/voice-personas/sessions').send({ packId: 'kidx_nestor', backend: 'hermes' }).expect(403);
  await request(app).post(base).send({ packId: 'personal_operator', modeId: 'open', backend: 'hermes' }).expect(400);
  expect(nativeCalls.length).toBe(before);
});

test('Nestor capture tool, consent receipt and ordinary attachment reach Hermes as an image', async () => {
  const { randomUUID } = require('node:crypto');
  await require('../../models/ConversationAttachment').createIndexes();
  const session = (await request(app).post(base).send({ packId: 'personal_operator', backend: 'hermes' }).expect(201)).body.data.session;
  const requestId = randomUUID(), path = `${base}/${session.sessionId}`;
  const tool = await require('../../src/services/mcpOwnerTools').handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'screen_capture', arguments: { action: 'request', requestId, sessionId: session.sessionId, purpose: 'Read this synthetic screen.' } } });
  expect(tool.result.structuredContent.request.status).toBe('awaiting_consent');
  expect((await request(app).get(path + '/screen-capture').expect(200)).body.data.request.requestId).toBe(requestId);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
  const imageUrl = 'data:image/png;base64,' + png;
  const attachment = (await request(app).post(path + '/attachments').send({ name: 'screen-capture.png', dataUrl: imageUrl }).expect(201)).body.data.attachment;
  await request(app).post(path + '/screen-capture').send({ requestId, status: 'attached', attachmentId: attachment.id }).expect(200);
  const before = nativeCalls.length;
  const reply = await request(app).post(path + '/turns/text').send({ text: 'Explique cette capture synthétique.', turnId: randomUUID(),
    stream: true, attachmentIds: [attachment.id] }).expect(200);
  const events = reply.text.trim().split('\n').map(line => JSON.parse(line));
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  const body = JSON.parse(nativeCalls.slice(before).find(call => call.path === '/v1/runs').body);
  expect(body.instructions).toContain('screen_capture'); expect(body.instructions).toContain(session.sessionId);
  expect(body.input.at(-1).content).toContainEqual({ type: 'image_url', image_url: { url: imageUrl } });
  const saved = await Conversation.findOne({ 'surfaceSession.sessionId': session.sessionId }).lean();
  expect(saved.messages.find(message => message.role === 'user').attachments[0].id).toBe(attachment.id);
  expect(saved.surfaceSession.screenCaptures[0].status).toBe('attached');
});
