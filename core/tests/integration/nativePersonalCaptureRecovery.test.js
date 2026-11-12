'use strict';

// Only native inference is synthetic. Main dispatch, MCP HTTP, task ownership
// and persistence use the real app and suite-owned disposable Mongo database.
const config = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'synthetic-worker',
  PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'synthetic-guardian', PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-private-work-binding-token',
  OPENCLAW_GATEWAY_URL: 'http://native.invalid', OPENCLAW_GATEWAY_TOKEN: 'synthetic-gateway-token' };
const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
Object.assign(process.env, config);
const mockNativeRuns = new Map();
let mockPerformCapture;
jest.mock('../../surfaces/household/personal-continuity', () => ({ createNestorClient: () => async query => {
  if (query.operation === 'agents') return { agents: [{ id: 'main', personalNotes: true }],
    capabilities: { isolatedWork: true, nativeConversation: true, nativeReadBudget: true } };
  const evidence = mockNativeRuns.get(query.sessionKey);
  if (query.operation === 'work_attempt') return evidence ? { sessionKey: query.sessionKey, runId: evidence.run.runId } : {};
  return evidence || {};
} }));
jest.mock('../../surfaces/household/conversation-agent', () => {
  const actual = jest.requireActual('../../surfaces/household/conversation-agent');
  const agent = jest.fn(async input => {
    const sessionKey = actual.sessionKeyFor(input.session), runId = 'resp_' + require('node:crypto').randomUUID();
    await input.onStarted(sessionKey, runId);
    const result = await mockPerformCapture();
    const text = result.captureStatus === 'recorded'
      ? 'La capture est enregistrée dans Core. Son état actuel reste à relire séparément.'
      : 'Le résultat de la capture reste inconnu. Je ne crée pas une deuxième tâche.';
    const receipts = [{ tool: 'add_personal_task', status: 'unknown', runId },
      { tool: 'list_personal_tasks', status: 'verified', runId }];
    mockNativeRuns.set(sessionKey, { ok: true, authority: 'openclaw.nestor', operation: 'turn',
      run: { sessionKey, runId, agentId: 'main', status: 'completed', model: 'synthetic-native', provider: 'synthetic' },
      answer: { status: 'ready', runId, text }, receipts, progress: [],
      toolChecks: { status: 'observed', runId, completedTools: ['list_personal_tasks'], loop: null } });
    await input.onSettled?.(sessionKey, runId);
    return { text, sessionKey, runId, metadata: { model: 'synthetic-native' },
      tools: { status: 'observed', receipts, run: { runId, sessionKey, model: 'synthetic-native' } } };
  });
  return { ...actual, createAgentClient: () => agent, agentForTest: agent };
});

const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../src/app');
const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const Work = require('../../models/ConversationWorkState');
const Preferences = require('../../models/ConversationPreferences');
const { agentForTest } = require('../../surfaces/household/conversation-agent');
const mcp = (target, id, name, args) => request(target).post('/mcp')
  .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const base = '/api/voice-personas/private/sessions';

beforeAll(() => PipelineTask.createIndexes());
beforeEach(async () => {
  await Preferences.deleteMany({}); await PipelineTask.deleteMany({}); await Counter.deleteMany({});
  mockNativeRuns.clear(); agentForTest.mockClear();
});
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test.each([false, true])('complete Main reconciles a lost MCP creation ACK in read-only mode (erased=%s)', async erased => {
  const requestId = randomUUID(), calls = [];
  let received, lostAcknowledgments = 0;
  const lossy = express();
  lossy.use((req, res, next) => {
    const json = res.json;
    res.json = function (body) {
      if (body.result?.structuredContent?.id) {
        lostAcknowledgments += 1;
        res.destroy(); // Core committed; the native caller receives no task/receipt.
        return res;
      }
      return json.call(this, body);
    };
    next();
  });
  lossy.use(app);
  mockPerformCapture = async () => {
    calls.push('add_personal_task');
    await expect(mcp(lossy, 1, 'add_personal_task', { title: 'Synthetic native action', requestId, note: 'Synthetic private note' }))
      .rejects.toThrow();
    expect(lostAcknowledgments).toBe(1);
    expect(await PipelineTask.countDocuments({ personalCaptureId: requestId })).toBe(1);
    if (erased) await PipelineTask.deleteMany({}); // Explicit fixture erasure, never compensation by Main.
    const before = { tasks: await PipelineTask.find({}).lean(), counters: await Counter.find({}).lean() };
    calls.push('list_personal_tasks');
    received = (await mcp(app, 2, 'list_personal_tasks', { requestId }).expect(200)).body.result.structuredContent;
    calls.push('list_personal_tasks');
    const repeated = (await mcp(app, 3, 'list_personal_tasks', { requestId }).expect(200)).body.result.structuredContent;
    expect(repeated.captureReceipt).toEqual(received.captureReceipt);
    expect(await PipelineTask.find({}).lean()).toEqual(before.tasks);
    expect(await Counter.find({}).lean()).toEqual(before.counters);
    return received;
  };
  const session = (await request(app).post(base).send({ packId: 'personal_operator', backend: 'openclaw' }).expect(201)).body.data.session;
  const turnId = randomUUID();
  const reply = await request(app).post(`${base}/${session.sessionId}/turns/text`)
    .send({ text: 'Ajoute une tâche personnelle synthétique.', channel: 'voice', turnId }).expect(200);
  expect(agentForTest).toHaveBeenCalledTimes(1);
  const sent = agentForTest.mock.calls[0][0];
  expect(sent.session.agentId).toBe('main');
  expect(sent.instructions).toContain('leading this owner conversation');
  const work = await Work.findOne({ sessionId: session.sessionId, turnId }).lean();
  expect(work).toMatchObject({ entryPolicy: 'main-first/v1', foreground: 'primary', guardian: { state: 'not_used' } });
  expect(calls).toEqual(['add_personal_task', 'list_personal_tasks', 'list_personal_tasks']);
  expect(await PipelineTask.countDocuments({})).toBe(erased ? 0 : 1);
  expect(await Counter.findById('pipelineTask').lean()).toMatchObject({ seq: 1 });
  expect(received).toMatchObject({ requestId, captureStatus: erased ? 'unknown' : 'recorded',
    taskObservation: erased ? 'unavailable' : 'current_state' });
  if (erased) {
    expect(received.captureReceipt).toBeNull(); expect(received.tasks).toEqual([]);
    expect(reply.body.data.reply.text).toContain('inconnu');
  } else {
    expect(received.captureReceipt).toMatchObject({ requestId, taskId: received.tasks[0].id });
    expect(received.tasks[0]).not.toHaveProperty('note');
    expect(reply.body.data.reply.text).toContain('enregistrée dans Core');
  }
  // The existing REST reader reaches the same Core owner; it never starts Main.
  const rest = (await request(app).get('/api/secretary/tasks').query({ requestId }).expect(200)).body.data;
  expect(rest.captureReceipt).toEqual(received.captureReceipt);
  expect(agentForTest).toHaveBeenCalledTimes(1);
  // A browser retry points to the original result for explicit recovery,
  // including an unknown capture, without launching Main or creating again.
  const originalWork = await Work.findById(work._id).lean();
  const recovered = await request(app).post(`${base}/${session.sessionId}/turns/text`)
    .send({ text: 'Ajoute une tâche personnelle synthétique.', channel: 'voice', turnId }).expect(202);
  expect(recovered.body.data).toMatchObject({ workId: work._id, recovery: 'explicit_listen', reply: null, replayed: false });
  const feed = (await request(app).get(`${base}/${session.sessionId}/work`).expect(200)).body.data;
  expect(feed.items.find(item => item.id === work._id).result.text).toBe(reply.body.data.reply.text);
  expect(agentForTest).toHaveBeenCalledTimes(1);
  expect(calls).toEqual(['add_personal_task', 'list_personal_tasks', 'list_personal_tasks']);
  expect(await Work.countDocuments({ sessionId: session.sessionId, turnId })).toBe(1);
  expect((await Work.findById(work._id).lean()).attempt).toEqual(originalWork.attempt);
  expect(await PipelineTask.countDocuments({})).toBe(erased ? 0 : 1);
  expect(await Counter.findById('pipelineTask').lean()).toMatchObject({ seq: 1 });
});

test('real MCP/REST refuse mixed scopes and incompatible identities without granting proposal approval', async () => {
  const requestId = randomUUID();
  const catalog = (await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(200)).body.result.tools;
  const tool = catalog.find(row => row.name === 'list_personal_tasks');
  expect(tool.annotations.readOnlyHint).toBe(true);
  expect(tool.inputSchema.properties.requestId.format).toBe('uuid');
  const created = (await mcp(app, 2, 'add_personal_task', { requestId, title: 'Synthetic mail request', origin: 'email' }).expect(200)).body.result.structuredContent;
  const found = (await mcp(app, 3, 'list_personal_tasks', { requestId }).expect(200)).body.result.structuredContent;
  expect(found.tasks[0]).toMatchObject({ id: created.id, needsReview: true, personalReview: { state: 'pending' } });
  const before = await PipelineTask.find({}).lean();
  for (const args of [{ requestId, scope: 'active' }, { requestId, approved: true }, { requestId: { $ne: null } }]) {
    const denied = (await mcp(app, 4, 'list_personal_tasks', args).expect(200)).body.result;
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: 'PERSONAL_CAPTURE_INVALID' } });
  }
  const mismatch = { requestId, expectedCaptureFingerprint: 'f'.repeat(64) };
  expect((await mcp(app, 5, 'list_personal_tasks', mismatch).expect(200)).body.result)
    .toMatchObject({ isError: true, structuredContent: { error: 'PERSONAL_CAPTURE_CONFLICT' } });
  await request(app).get('/api/secretary/tasks').query(mismatch).expect(409);
  await request(app).get('/api/secretary/tasks').query({ requestId, scope: 'active' }).expect(400);
  const complete = (await mcp(app, 6, 'complete_personal_task', { ref: created.id }).expect(200)).body.result;
  expect(complete).toMatchObject({ isError: true, structuredContent: { error: 'SECRETARY_REVIEW_REQUIRED' } });
  expect(await PipelineTask.find({}).lean()).toEqual(before);
});
