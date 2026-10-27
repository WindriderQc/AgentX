'use strict';

process.env.HOUSEHOLD_HERMES_URL = 'http://hermes.fixture';
process.env.HOUSEHOLD_HERMES_TOKEN = 'synthetic-companion-server-token';
process.env.HOUSEHOLD_PERSONAL_CONVERSATION_BACKEND = 'hermes';
const mockCompanionInference = jest.fn();
const mockCompanionSearch = jest.fn();
jest.mock('../../src/extensions/trustedRuntimeServices', () => {
  const actual = jest.requireActual('../../src/extensions/trustedRuntimeServices');
  return { ...actual, createTrustedRuntimeServices: (...args) => {
    const services = actual.createTrustedRuntimeServices(...args);
    return { ...services, memory: { ...services.memory, forAudience: () => ({ search: (...args) => mockCompanionSearch(...args) }) }, inference: { ...services.inference, execute: (...input) => mockCompanionInference(...input) } };
  } };
});
const executeInference = mockCompanionInference;
const originalFetch = global.fetch;
global.fetch = jest.fn(async url => {
  if (!String(url).startsWith('http://hermes.fixture/')) throw new Error('Unexpected external request in companion fixture');
  const path = new URL(url).pathname;
  if (path === '/v1/runs') return Response.json({ run_id: 'run_companion_fixture' });
  if (path.endsWith('/events')) return new Response('data: {"event":"message.delta","run_id":"run_companion_fixture","delta":"Voici les éléments de la liste."}\n\n');
  return Response.json({ run_id: 'run_companion_fixture', status: 'completed', completed: true, partial: false,
    output: 'Voici les éléments de la liste.', runtime: { provider: 'synthetic', model: 'synthetic-conversation' } });
});
const request = require('supertest');
const { app } = require('../../src/app');
const base = '/api/voice-personas/private/sessions';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const makeSession = async () => (await request(app).post(base).send({ packId: 'personal_operator', backend: 'hermes' }).expect(201)).body.data.session;
afterAll(() => { global.fetch = originalFetch; });
beforeEach(() => { executeInference.mockReset(); mockCompanionSearch.mockReset().mockResolvedValue([{ text: 'A sourced architecture excerpt.', score: .9, metadata: { documentId: 'doc-fixture', title: 'Architecture', source: 'fixture' } }]); });

test('real Hermes turn settles while local accompaniment is pending, then exposes the validated result separately', async () => {
  let settle;
  executeInference.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  const session = await makeSession(), turnId = require('node:crypto').randomUUID();
  const response = await request(app).post(`${base}/${session.sessionId}/turns/text`).send({
    text: 'Prépare une liste avec les éléments alpha et bêta.', turnId, channel: 'text', stream: true, presentationCompanion: true }).expect(200);
  const events = response.text.trim().split('\n').map(line => JSON.parse(line));
  expect(events.find(row => row.type === 'done').data.routing.backend).toBe('hermes');
  expect(events.filter(row => row.type === 'error')).toEqual([]);
  await wait(950);
  expect(executeInference).toHaveBeenCalledTimes(1);
  const [body, options] = executeInference.mock.calls[0];
  expect(body).toMatchObject({ executionSource: 'local', taskType: 'voice_persona_chat', stream: false });
  expect(body.model).toBeUndefined();
  expect(body.format.oneOf).toBeDefined();
  const frame = JSON.parse(body.messages[1].content);
  expect(frame.context).toContain('doc-fixture');
  expect(frame.context).not.toContain('Current presentation (browser');
  expect(options.consumerContract).toBe('household-runtime-v1');
  expect((await request(app).get(`${base}/${session.sessionId}/companion/${turnId}`).expect(200)).body.data.state).toBe('running');
  settle({ ok: true, body: { message: { content: JSON.stringify({ decision: 'present', reason: 'La liste demandée reste visible.',
    evidence: { source: 'request', quote: 'éléments alpha et bêta' },
    block: { kind: 'list', title: 'Éléments', body: '- alpha\n- bêta' } }) } } });
  await wait(25);
  const result = (await request(app).get(`${base}/${session.sessionId}/companion/${turnId}`).expect(200)).body.data;
  expect(result).toMatchObject({ state: 'ready', suggestion: { block: { kind: 'list', from: 'companion' } } });
  expect(result.collaboration.research.sources[0]).toMatchObject({ documentId: 'doc-fixture', excerpt: 'A sourced architecture excerpt.' });
  const ownerTool = require('../../src/services/mcpOwnerTools');
  const read = await ownerTool.handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'collaboration_context', arguments: { sessionId: session.sessionId, turnId } } });
  expect(read.result.structuredContent.research.sources[0].documentId).toBe('doc-fixture');
  const screen = [{ contract: 'agentx.presentation/v1', id: 'selected', revision: 'r1', kind: 'text', title: 'Selected content', status: 'visible', text: 'A human selected this content.' }];
  await request(app).post(`${base}/${session.sessionId}/companion/stop`).send({ turnId }).expect(200);
  expect((await request(app).post(`${base}/${session.sessionId}/companion/observations`).send({ turnId, sequence: 1, screen }).expect(200)).body.data.accepted).toBe(true);
  const live = (await request(app).get(`${base}/${session.sessionId}/companion/${turnId}`).expect(200)).body.data;
  expect(live.state).toBe('paused');
  expect(live.collaboration.selection.text).toBe('A human selected this content.');
  expect((await request(app).post(`${base}/${session.sessionId}/companion/observations`).send({ turnId, sequence: 1, screen: [] }).expect(200)).body.data.accepted).toBe(false);
  expect(executeInference).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('synthetic-companion-server-token');
  await request(app).delete(`${base}/${session.sessionId}`).send({ confirmation: 'DELETE CONVERSATION' }).expect(200);
  await request(app).get(`${base}/${session.sessionId}/companion/${turnId}`).expect(404);
});

test('ordinary Hermes turns do not start companion inference; stop requires a bound turn', async () => {
  const session = await makeSession(), turnId = require('node:crypto').randomUUID();
  await request(app).post(`${base}/${session.sessionId}/turns/text`).send({ text: 'Bonjour.', turnId, channel: 'text', stream: true }).expect(200);
  await wait(850);
  expect(executeInference).not.toHaveBeenCalled();
  await request(app).post(`${base}/${session.sessionId}/companion/stop`).send({}).expect(400);
  await request(app).post(`${base}/${session.sessionId}/companion/stop`).send({ turnId }).expect(200);
});

test('family sessions cannot read personal companion state', async () => {
  const session = (await request(app).post('/api/voice-personas/sessions').send({ packId: 'kidx_nestor', backend: 'agentx' }).expect(201)).body.data.session;
  await request(app).get(`${base}/${session.sessionId}/companion/synthetic`).expect(404);
  expect(executeInference).not.toHaveBeenCalled();
});
