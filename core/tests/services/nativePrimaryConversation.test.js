'use strict';

const express = require('express'), request = require('supertest'), mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const capability = require('../../src/services/conversationWorks/capability');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { registerWorkRuntime } = require('../../surfaces/household/conversation-work-runtime');
const { createAgentClient } = require('../../surfaces/household/conversation-agent');
const { createConversationExecutor } = require('../../surfaces/household/conversation-executor');
const { createWorkDelivery } = require('../../src/services/conversationWorks/delivery');
const { createPrimaryForeground } = require('../../src/services/conversationWorks/primary-foreground');
const { OWNER, EXCHANGE_SCOPE, hash } = require('../../src/services/conversationWorks/contract');
const Model = require('../../models/ConversationWorkState');
const conversations = forSurface('household');
const env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'nestor-worker',
  PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'nestor-relay', PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-primary-work-binding-token',
  OPENCLAW_GATEWAY_URL: 'http://synthetic.invalid', OPENCLAW_GATEWAY_TOKEN: 'synthetic-native-transport' };
const signal = () => new AbortController();
const wire = value => Buffer.from('data: ' + JSON.stringify(value) + '\n\n');
const contextOf = row => ({ agentId: 'main', runId: row.attempt.runId, sessionKey: row.attempt.sessionKey });
let works, session, app, nativeApi, fetchImpl, runs, sent, hold, started, release, lost, tasks;
const input = (text = 'Bonjour.', turnId = randomUUID()) => ({ session, text, turnId });
const evidence = run => ({ ok: true, authority: 'openclaw.nestor', operation: 'turn', sessionKey: run.key, runId: run.id,
  run: { sessionKey: run.key, runId: run.id, agentId: run.agent, status: run.done ? 'completed' : 'running',
    model: 'synthetic-complete-model', provider: 'synthetic', usage: { input: 12, output: 4 } },
  answer: run.done ? { status: 'ready', runId: run.id, text: run.text } : { status: 'pending', runId: run.id },
  receipts: run.initialContext?.receipt ? [{ tool: 'conversation_work', status: 'verified', runId: run.id,
    workRead: { id: run.initialContext.receipt.id, tool: 'tasks.personal.list' } }] : [],
  progress: [], toolChecks: { status: 'observed', runId: run.id, completedTools: ['conversation_work'], loop: null } });
async function nativeContext(run, callId) {
  const response = await request(nativeApi).post('/native/work').set('Authorization', 'Bearer ' + env.PERSONAL_CONVERSATION_WORK_TOKEN)
    .send({ operation: 'native_context', callId, context: { agentId: run.agent, sessionKey: run.key, runId: run.id } });
  return response.status === 200 ? response.body.data : { unavailable: response.body.code };
}

async function http() {
  const packs = require('../../surfaces/household/packs'), prompt = require('../../surfaces/household/persona-prompt');
  const records = require('../../surfaces/household/persona-records'), pack = packs.packById('personal_operator');
  session = await conversations.updateSession({ sessionId: session.sessionId }, { $set: { modeId: pack.defaultMode,
    persona: { id: 'nestor', version: 1, name: 'Nestor', identity: 'Complete synthetic identity.', voice: {} }, voice: { language: 'fr' } } });
  const client = createAgentClient({ env, fetchImpl, continuity, settleMs: 0 });
  const activePersonaTurns = new Map();
  const handler = require('../../surfaces/household/persona-turn').createPersonaTurnHandler({
    runtimeServices: { attachments: { ids: () => [] } }, conversations, conversationEnv: env, conversationWorks: works,
    executeConversation: createConversationExecutor({ env, inference: {}, agentClient: client }),
    requireNativeAgent: async () => {}, familyTasks: { listProfiles: async () => ({ profiles: [] }), listProfileDetails: async () => ({ profiles: [] }) },
    ownerMemory: {}, familyMemory: {}, notesFor: () => ({ search: async () => ({ notes: [] }), record: async () => ({}) }),
    personalAttachments: () => ({ prepare: async messages => messages }), knowledgeState: { config: null, status: { status: 'disabled' } },
    openHold: {}, openingPayload: () => ({}), sounds: { select: () => null, get: () => null }, visuals: { sources: () => [] },
    brain: { cancel() {}, schedule() { throw Error('No second review'); }, contextFor: () => '' }, activePersonaTurns,
    validClientTurnId: id => /^[a-zA-Z0-9-]{16,80}$/.test(id), envelope: (res, data, code = 200) => res.status(code).json({ ok: true, data }),
    fail: (res, code, message, error) => res.status(code).json({ message, code: error }), cleanText: value => String(value || '').trim(),
    assessSafety: prompt.assessSafety, childBoundaryReply: prompt.childBoundaryReply, escalationReply: prompt.escalationReply,
    detectMemoryRequest: prompt.detectMemoryRequest, packById: packs.packById, packSummary: packs.packSummary, modeSummary: packs.modeSummary,
    publicSession: records.publicSession, systemPromptFor: prompt.systemPromptFor, spokenReplyLanguage: prompt.spokenReplyLanguage,
    sessionHistoryMessages: records.sessionHistoryMessages, loadSessionAuditRows: records.loadSessionAuditRows,
    MEMORY_RECALL_LIMIT: prompt.MEMORY_RECALL_LIMIT, PERSONAL_OPERATOR_SURFACE_CONTRACT: packs.PERSONAL_OPERATOR_SURFACE_CONTRACT,
    VOIX_FAMILY_PACK_ID: 'kidx_nestor' });
  const value = express(); value.use(express.json());
  value.post('/sessions/:sessionId/turns/text', (req, res) => handler(req, res, 'private'));
  require('../../surfaces/household/browser-session-controls').createBrowserSessionControls({ personas: value, conversations, activePersonaTurns,
    envelope: (res, data, code = 200) => res.status(code).json({ data }), cleanText: value => String(value || ''),
    fail: (res, code, message, error) => res.status(code).json({ message, code: error }),
    validClientTurnId: id => /^[a-zA-Z0-9-]{16,80}$/.test(id), nestorClient: continuity })('', 'personal_operator', 'personal');
  return value;
}
async function continuity(req) {
  if (req.operation === 'agents') return { capabilities: { isolatedWork: true, nativeConversation: true, nativeReadBudget: true } };
  const run = [...runs.values()].find(item => item.key === req.sessionKey && (!req.runId || item.id === req.runId));
  if (!run) return {};
  if (req.operation === 'work_attempt') return { runId: run.id, sessionKey: run.key };
  return evidence(run);
}
beforeAll(async () => { await Model.createCollection(); await Model.createIndexes(); });
beforeEach(async () => {
  await Model.collection.deleteMany({});
  await mongoose.connection.collection('conversation_exchange_receipts').deleteMany({ scope: EXCHANGE_SCOPE });
  await mongoose.connection.collection('conversation_work_dispatch').deleteMany({});
  session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
    modeId: 'standard', status: 'active', backend: 'openclaw', agentId: 'main', turnCount: 0 });
  runs = new Map(); sent = []; hold = false; lost = false; release = undefined; started = undefined;
  tasks = { list: jest.fn(async () => ({ tasks: [], totalCount: 0 })) };
  fetchImpl = jest.fn(async (_url, options) => {
    const body = JSON.parse(options.body), agent = body.model.split('/')[1], key = options.headers['x-openclaw-session-key'];
    sent.push({ body, headers: options.headers, signal: options.signal });
    if (lost) throw Error('Synthetic lost dispatch acknowledgment');
    const run = { id: 'resp_' + randomUUID(), agent, key, done: false, text: agent === 'main' ? 'Réponse exacte de Main.' : 'Je garde le relais pendant ce travail.' };
    if (agent === 'main') {
      const [owner] = await works.repo.find({ 'attempt.sessionKey': key }, 1);
      run.workId = owner._id; run.attemptId = owner.attempt.id;
      run.beforeStarted = works.observer.isExecuting(owner._id, owner.attempt.id, run.id, key);
    }
    runs.set(run.id, run);
    return { ok: true, body: (async function* () {
      yield wire({ type: 'response.created', response: { id: run.id } });
      if (agent === 'main') {
        run.afterStarted = works.observer.isExecuting(run.workId, run.attemptId, run.id, key);
        run.initialContext = await nativeContext(run, 'call_initial');
        started?.();
        if (hold) await new Promise(resolve => { release = resolve; });
        run.returnContext = await nativeContext(run, 'call_return');
      }
      run.done = true;
      yield wire({ type: 'response.output_text.delta', delta: run.text });
      yield wire({ type: 'response.completed', response: { id: run.id } });
    })() };
  });
  const router = express.Router(); nativeApi = express(); nativeApi.use(express.json()); nativeApi.use(router);
  works = registerWorkRuntime({ router, conversations, tasks, env, capability, continuity,
    agentClient: createAgentClient({ env, fetchImpl, continuity, settleMs: 0 }) });
  app = await http();
});
afterEach(async () => {
  release?.(); const gate = await works.repo.dispatchOwner();
  if (gate?.workId) await works.observer.settled(gate.workId);
  works.observer.stop();
});
const send = original => request(app).post(`/sessions/${session.sessionId}/turns/text`)
  .send({ text: original.text, turnId: original.turnId, channel: 'voice', stream: true }).timeout(8000);
const done = response => response.text.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.type === 'done')?.data;

test('idle HTTP starts complete Main first with the exact native payload and one ordinary answer', async () => {
  const original = input(), response = await send(original);
  expect(response.status).toBe(200); expect(response.text).toContain('"type":"done"'); expect(done(response).reply.text).toBe('Réponse exacte de Main.');
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ model: 'openclaw/main', stream: true });
  expect(sent[0].body.tools).toBeUndefined(); expect(sent[0].body.max_output_tokens).toBeUndefined();
  expect(sent[0].body.instructions).toContain('leading this owner conversation');
  expect(sent[0].body.instructions).toContain('Keep your installed tools, personal memory and specialist delegation');
  expect(sent[0].body.instructions).not.toContain('The guardian has finished');
  expect(sent[0].body.input.at(-1).content.at(-1)).toEqual({ type: 'input_text', text: original.text });
  expect(sent[0].body.instructions).toContain('Complete synthetic identity.');
  const run = [...runs.values()][0];
  expect(run.beforeStarted).toBe(false); expect(run.afterStarted).toBe(true);
  expect(works.observer.isExecuting(run.workId, run.attemptId, run.id, run.key)).toBe(false);
  const saved = await works.repo.get(hash(session.sessionId + '\n' + original.turnId));
  expect(saved).toMatchObject({ entryPolicy: 'main-first/v1', foreground: 'primary', guardian: { state: 'not_used' },
    attempt: { agentId: 'main' }, primary: { delivery: 'foreground' } });
  const turn = await conversations.getTurn({ ...works.query(session.sessionId), traceId: original.turnId });
  expect(turn.toolEvidence).toMatchObject({ authority: 'openclaw/main', runId: saved.attempt.runId });
  expect(turn.phaseEvidence).toMatchObject({ responseKind: 'conversation_reply', execution: { source: 'openclaw/main',
    identity: { provider: 'synthetic', model: 'synthetic-complete-model', runId: saved.attempt.runId } } });
  expect(turn.serverTimings?.agent?.firstDelta).toBeUndefined();
  const projected = await works.conversationContext(session.sessionId);
  expect(projected.turns[0]).toMatchObject({ replyText: 'Réponse exacte de Main.', replyAttribution: { role: 'leading' },
    workResults: [{ sameAsReply: true, attribution: { role: 'leading' } }] });
  expect(projected.turns[0].workResults[0].text).toBeUndefined();
  expect((await createWorkDelivery(works).snapshot(session.sessionId)).items[0].result.automaticSpeech).toBe(false);
});

test('the new leading path retains native task/context callbacks and their exact read receipts', async () => {
  const original = input('Regarde mes tâches.');
  const response = await send(original);
  expect(response.status).toBe(200); expect(done(response).reply.text).toBe('Réponse exacte de Main.');
  expect(sent.map(item => item.body.model)).toEqual(['openclaw/main']);
  const run = [...runs.values()][0];
  expect(run.initialContext).toMatchObject({ request: original.text, receipt: { status: 'verified', tool: 'tasks.personal.list' }, data: { totalCount: 0 } });
  expect(tasks.list).toHaveBeenCalledWith({ limit: 25, includeDone: false, scope: 'active' });
  const row = await works.repo.get(hash(session.sessionId + '\n' + original.turnId));
  const taskReceipt = row.tools.find(tool => tool.tool === 'tasks.personal.list');
  expect(taskReceipt.runId).toBe(row.attempt.runId);
  const callback = await request(nativeApi).post('/native/work').set('Authorization', 'Bearer ' + env.PERSONAL_CONVERSATION_WORK_TOKEN)
    .send({ operation: 'publish', context: contextOf(row), input: { kind: 'answer', text: 'No new worker grant', receiptIds: [] } });
  expect(callback.status).toBe(404);
});

test.each(['changed', 'missing', 'other-version'])('an %s canonical reply never hides the received Main result', async kind => {
  const original = input(); await send(original);
  const changes = kind === 'changed' ? { replyText: 'Changed canonical text' } : kind === 'missing' ? { replyText: '' }
    : { 'toolEvidence.primaryResult.version': 99 };
  await conversations.updateTurn({ ...works.query(session.sessionId), traceId: original.turnId }, { $set: changes });
  const turn = (await works.conversationContext(session.sessionId)).turns[0];
  expect(turn.workResults[0]).toMatchObject({ text: 'Réponse exacte de Main.' });
  expect(turn.workResults[0].sameAsReply).toBeUndefined();
});

test('a final HTTP reply lost at the caller is recovered by its original result for explicit Listen only', async () => {
  const original = input(); await send(original);
  const again = await send(original);
  expect(again.status).toBe(202); expect(again.body.data).toMatchObject({ recovery: 'explicit_listen', reply: null, replayed: false });
  expect(sent).toHaveLength(1);
  const restarted = capability.create({ conversations, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' } });
  const snapshot = await createWorkDelivery(restarted).snapshot(session.sessionId);
  expect(snapshot.items[0].result).toMatchObject({ text: 'Réponse exacte de Main.', automaticSpeech: false, presentation: 'available' });
});

test('only another exact occupied Main admits the temporary guardian, then Main refresh sees its marked reply', async () => {
  hold = true; const initial = input();
  const admitted = new Promise(resolve => { started = resolve; });
  const leading = send(initial).then(value => value);
  await admitted;
  const interrupted = await request(app).post(`/sessions/${session.sessionId}/interrupt`).send({ turnId: initial.turnId });
  expect(interrupted.status).toBe(200); expect(interrupted.body.data.detached).toBe(true);
  const second = input('Bonjour encore.'), relayed = await send(second);
  expect(relayed.status).toBe(200); expect(done(relayed).reply.text).toContain('relais');
  expect(sent.map(item => item.body.model)).toEqual(['openclaw/main', 'openclaw/nestor-relay']);
  const row = await works.repo.get(hash(session.sessionId + '\n' + second.turnId));
  const original = await works.repo.get(hash(session.sessionId + '\n' + initial.turnId));
  expect(row.primary.relayFor).toEqual({ workId: original._id, attemptId: original.attempt.id, runId: original.attempt.runId });
  expect(row.guardian).toMatchObject({ state: 'completed', disposition: 'answered' });
  release(); await leading;
  while (!(await works.repo.get(original._id)).result) await new Promise(resolve => setTimeout(resolve, 10));
  const run = [...runs.values()].find(value => value.agent === 'main');
  expect(run.returnContext.conversation.turns.find(value => value.turnId === second.turnId))
    .toMatchObject({ replyAttribution: { role: 'relay', runId: row.guardian.runId }, replyText: 'Je garde le relais pendant ce travail.' });
});

test('lost native admission stays uncertain without another Main or guardian effect', async () => {
  lost = true; const original = input();
  const response = await send(original);
  expect(response.status).toBe(200); expect(done(response).reply.text).toContain('reçu');
  const saved = await works.repo.get(hash(session.sessionId + '\n' + original.turnId));
  expect(saved).toMatchObject({ state: 'uncertain', attempt: { agentId: 'main' }, guardian: { state: 'not_used' } });
  await works.observer.tick(); await works.observer.tick();
  expect(sent).toHaveLength(1); expect((await works.repo.get(saved._id)).attempt.id).toBe(saved.attempt.id);
});

test('detachment and result publication arbitrate atomically without foreground/feed double delivery', async () => {
  const accepted = await works.intake(input()); await works.prepare(accepted.row._id, 'Canonical selected memory.');
  const running = new Promise(resolve => { started = resolve; }); hold = true;
  const controller = signal(), reader = works.primaryReply(accepted.row._id, { signal: controller.signal });
  await running; controller.abort(new Error('Synthetic barge-in'));
  await expect(reader).rejects.toThrow('Synthetic barge-in'); release();
  while (!(await works.repo.get(accepted.row._id)).result) await new Promise(resolve => setTimeout(resolve, 10));
  expect((await createWorkDelivery(works).snapshot(session.sessionId)).items[0].result.automaticSpeech).toBe(true);
  expect(sent[0].signal.aborted).toBe(false);
  expect(sent).toHaveLength(1);
});

test('publication winning before detach retains the foreground result without automatic replay', async () => {
  const original = input(); await send(original);
  const id = hash(session.sessionId + '\n' + original.turnId);
  await createPrimaryForeground(works, works.observer).background(id);
  expect((await works.repo.get(id)).primary.delivery).toBe('foreground');
  expect((await createWorkDelivery(works).snapshot(session.sessionId)).items[0].result.automaticSpeech).toBe(false);
});

test('explicit voice Stop releases only the foreground; the original native run keeps its identity', async () => {
  hold = true; const original = input(), admitted = new Promise(resolve => { started = resolve; });
  const response = send(original).then(value => value); await admitted;
  const before = await works.repo.get(hash(session.sessionId + '\n' + original.turnId));
  const stopped = await request(app).post(`/sessions/${session.sessionId}/interrupt`).send({ turnId: original.turnId, stop: true });
  expect(stopped.status).toBe(200); expect(stopped.body.data.interrupted).toBe(true);
  expect(sent[0].signal.aborted).toBe(false);
  expect(await works.repo.get(before._id)).toMatchObject({ state: 'running', attempt: { id: before.attempt.id } });
  release(); await response; await works.observer.settled(before._id);
  expect((await createWorkDelivery(works).snapshot(session.sessionId)).items[0].result.automaticSpeech).toBe(true);
});

test('two simultaneous session intakes share one admitted Main; queued or relay status cannot start a second owner', async () => {
  const other = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
    modeId: session.modeId, status: 'active', backend: 'openclaw', agentId: 'main', turnCount: 0, persona: session.persona });
  hold = true; const admitted = new Promise(resolve => { started = resolve; });
  const initial = input();
  const first = send(initial).then(value => value);
  const second = request(app).post(`/sessions/${other.sessionId}/turns/text`)
    .send({ text: 'Bonjour.', turnId: randomUUID(), channel: 'voice', stream: true }).timeout(8000).then(value => value);
  const replies = Promise.all([first, second]);
  try {
    await Promise.race([admitted, replies]);
    expect(sent.filter(item => item.body.model === 'openclaw/main')).toHaveLength(1);
    const gate = await works.repo.dispatchOwner();
    // Either HTTP request can win admission. Keep that Main occupied until
    // the other intake has actually returned its queued/relay response.
    await (gate.workId === hash(session.sessionId + '\n' + initial.turnId) ? second : first);
    const rows = await works.repo.find({});
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.attempt)).toHaveLength(1);
    expect(rows.find(row => row.attempt).attempt.id).toBe(gate.attempt.id);
  } finally {
    release?.();
    await replies;
  }
  expect(sent.filter(item => item.body.model === 'openclaw/main')).toHaveLength(1);
});

test('pre-dispatch cancel is still versioned, preserves the original request and launches nothing', async () => {
  const original = input(), accepted = await works.intake(original); await works.prepare(accepted.row._id, 'Selected memory.');
  const current = await works.repo.get(accepted.row._id);
  const control = await request(nativeApi).post(`/private/sessions/${session.sessionId}/work/${current._id}/control`)
    .send({ version: 2, requestId: randomUUID(), workId: current._id, requestSha256: current.requestSha256, revision: current.revision, action: 'cancel' });
  expect(control.status).toBe(200);
  expect(await works.primaryReply(current._id)).toEqual({ statusOnly: true });
  expect(sent).toHaveLength(0);
  expect(await works.requestTextForDisplay(await works.repo.get(current._id))).toBe(original.text);
  expect((await works.repo.get(current._id)).attempt).toBeUndefined();
});

test('restart reconciles an uncertain original native session without a replacement dispatch', async () => {
  lost = true; const original = input(); await send(original);
  const id = hash(session.sessionId + '\n' + original.turnId), before = await works.repo.get(id);
  const recovered = { id: 'resp_' + randomUUID(), key: before.attempt.sessionKey, agent: 'main', done: true, text: 'Original answer recovered.' };
  runs.set(recovered.id, recovered);
  const restarted = capability.create({ conversations, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' } });
  const native = require('../../surfaces/household/native-work-runtime').nativeWorkRuntime({ works: restarted, conversations, continuity });
  const execute = jest.fn();
  const observer = capability.observe({ works: restarted, env, execute, observe: native.observe, receive: native.receive });
  try { await observer.tick(); await observer.tick(); } finally { observer.stop(); }
  expect(execute).not.toHaveBeenCalled(); expect(sent).toHaveLength(1);
  expect(await restarted.repo.get(id)).toMatchObject({ entryPolicy: 'main-first/v1', state: 'completed', attempt: { id: before.attempt.id, runId: recovered.id } });
  expect((await createWorkDelivery(restarted).snapshot(session.sessionId)).items[0].result.text).toBe(recovered.text);
});

test('erasure revokes callbacks and retains the original native owner until exact terminal evidence', async () => {
  hold = true; const original = input(), admitted = new Promise(resolve => { started = resolve; });
  const response = send(original).then(value => value); await admitted;
  await request(app).post(`/sessions/${session.sessionId}/interrupt`).send({ turnId: original.turnId });
  const id = hash(session.sessionId + '\n' + original.turnId), before = await works.repo.get(id);
  await conversations.deleteSession({ ...works.query(session.sessionId) });
  expect((await works.repo.dispatchOwner()).workId).toBe(id);
  const callback = await request(nativeApi).post('/native/work').set('Authorization', 'Bearer ' + env.PERSONAL_CONVERSATION_WORK_TOKEN)
    .send({ operation: 'native_context', context: contextOf(before), callId: 'call_after_erasure' });
  expect(callback.status).toBe(404);
  const erased = await works.repo.getIncludingErased(id);
  expect(erased).toMatchObject({ erased: true, attempt: { id: before.attempt.id } });
  expect(erased.entryPolicy).toBeUndefined(); expect(erased.primary).toBeUndefined();
  release(); await response; await works.observer.settled(id);
  expect((await works.repo.dispatchOwner()).workId).toBeNull();
  expect(sent).toHaveLength(1); expect(await works.repo.get(id)).toBeNull();
});

test('available Main does not require an installed dedicated guardian', async () => {
  works.observer.stop();
  const router = express.Router(); nativeApi = express(); nativeApi.use(express.json()); nativeApi.use(router);
  works = registerWorkRuntime({ router, conversations, tasks, env: { ...env, PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: undefined },
    capability, continuity, agentClient: createAgentClient({ env, fetchImpl, continuity, settleMs: 0 }) });
  app = await http();
  const original = input(), response = await send(original);
  expect(done(response).reply.text).toBe('Réponse exacte de Main.');
  expect(sent.map(item => item.body.model)).toEqual(['openclaw/main']);
  expect(await works.repo.get(hash(session.sessionId + '\n' + original.turnId)))
    .toMatchObject({ foreground: 'primary', guardian: { agentId: 'main', state: 'not_used' } });
});

test('an uncertain foreign gate gives only Core status even with a configured guardian model', async () => {
  const occupied = (await works.intake(input('Older request'))).row;
  const attempt = { id: randomUUID(), agentId: 'main', sessionKey: `agent:main:household:direct:${randomUUID()}` };
  await works.repo.mutate(occupied._id, () => ({ fields: { state: 'uncertain', attempt }, event: 'synthetic_unknown_original' }));
  await mongoose.connection.collection('conversation_work_dispatch').insertOne({ _id: OWNER, workId: occupied._id, phase: 'dispatching', attempt });
  const original = input(), accepted = await works.intake(original); await works.prepare(accepted.row._id, 'Full memory.');
  const nativeCall = jest.fn();
  const executor = createConversationExecutor({ env, inference: {}, agentClient: nativeCall });
  const result = await executor({ backend: 'openclaw', session, channel: 'voice', text: original.text, model: 'synthetic/relay',
    readPrimaryWork: () => works.primaryReply(accepted.row._id), readAcceptedNativeWork: () => works.nativeAcceptance(accepted.row._id) });
  expect(result.tools).toMatchObject({ authority: 'core.conversation-works', status: 'deferred' });
  expect(result.text).toContain('bloquée'); expect(nativeCall).not.toHaveBeenCalled(); expect(sent).toHaveLength(0);
  expect(await works.repo.get(accepted.row._id)).toMatchObject({ foreground: 'primary', guardian: { state: 'not_used' } });
});

test('a retained running label without an active native transport never admits the guardian', async () => {
  const occupied = (await works.intake(input('Earlier native request'))).row;
  const attempt = { id: randomUUID(), agentId: 'main', sessionKey: `agent:main:household:direct:${randomUUID()}`, runId: 'resp_' + randomUUID() };
  await works.repo.mutate(occupied._id, () => ({ fields: { state: 'running', attempt }, event: 'synthetic_retained_running' }));
  await mongoose.connection.collection('conversation_work_dispatch').insertOne({ _id: OWNER, workId: occupied._id, phase: 'dispatching', attempt });
  // Model the native owner's pending result observation after the transport
  // has returned. This label is not fresh evidence of an occupied Main.
  const original = input(), accepted = await works.intake(original); await works.prepare(accepted.row._id, 'Selected context.');
  const foreground = createPrimaryForeground(works, { tick: async () => {}, isExecuting: () => false });
  expect(await foreground.reply(accepted.row._id)).toEqual({ statusOnly: true });
  expect(await works.repo.get(accepted.row._id)).toMatchObject({ foreground: 'primary', guardian: { state: 'not_used' } });
  expect(sent).toHaveLength(0);
});

test('a lost intake row recovers the frozen primary policy after restart with new intake disabled', async () => {
  const original = input(), accepted = await works.intake(original);
  await Model.collection.deleteOne({ _id: accepted.row._id });
  const disabled = capability.create({ conversations, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' } });
  await disabled.recover();
  expect(await disabled.repo.get(accepted.row._id)).toMatchObject({ entryPolicy: 'main-first/v1', foreground: 'primary',
    classification: 'native_work', primary: { delivery: 'background' }, guardian: { state: 'not_used' } });
  expect(await disabled.intake(input('A new request.'))).toBeNull(); expect(sent).toHaveLength(0);
});

test('retained native records keep their old entry contract while new intake stays personal voice only', async () => {
  const legacy = capability.create({ conversations, env });
  const original = input(), accepted = await legacy.intake(original);
  expect((await works.intake(original)).row).toMatchObject({ _id: accepted.row._id, classification: 'native_review', foreground: 'guardian' });
  expect((await works.repo.get(accepted.row._id)).entryPolicy).toBeUndefined();
  for (const patch of [{ backend: 'hermes' }, { packId: 'kidx_nestor', scopeId: 'family' }, { modeId: 'open' }, { inference: { open: true } }]) {
    expect(await works.intake({ ...input(), session: { ...session, ...patch } })).toBeNull();
  }
  expect(await works.intake({ ...input(), channel: 'text' })).toBeNull();
  expect(sent).toHaveLength(0);
});
