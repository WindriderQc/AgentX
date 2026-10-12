'use strict';
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { forSurface } = require('../../src/services/surfaceConversationService');
const capability = require('../../src/services/conversationWorks/capability');
const { registerWorkRuntime } = require('../../surfaces/household/conversation-work-runtime');
const { createConversationExecutor } = require('../../surfaces/household/conversation-executor');
const { createWorkDelivery } = require('../../src/services/conversationWorks/delivery');
const { OWNER, EXCHANGE_SCOPE, hash, NO_WORK } = require('../../src/services/conversationWorks/contract');
const Model = require('../../models/ConversationWorkState');
const conversations = forSurface('household');
const env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'nestor-worker',
  PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-native-conversation-binding-token' };
let works, current, execute, continuity, router;
const input = (text, turnId = randomUUID()) => ({ session: current, turnId, text });
const proof = (attempt, text = 'The completed native answer.', tools = []) => ({
  ok: true, authority: 'openclaw.nestor', operation: 'turn', runId: attempt.runId, sessionKey: attempt.sessionKey,
  run: { runId: attempt.runId, sessionKey: attempt.sessionKey, status: 'completed' },
  answer: { status: 'ready', runId: attempt.runId, text }, progress: [], receipts: [],
  toolChecks: { status: 'observed', runId: attempt.runId, completedTools: tools, loop: null }
});
const context = row => ({ agentId: row.attempt.agentId, sessionKey: row.attempt.sessionKey, runId: row.attempt.runId });
async function admitted(text = 'Help me compare these two options.') {
  const accepted = await works.intake(input(text));
  await works.prepare(accepted.row._id, 'Selected owner context.');
  const attempt = { id: randomUUID(), sessionId: randomUUID(), agentId: 'main', runId: 'resp_' + randomUUID() };
  attempt.sessionKey = `agent:main:household:direct:${attempt.sessionId}`;
  return works.repo.mutate(accepted.row._id, () => ({ fields: { state: 'running', attempt }, event: 'fixture_native_started' }));
}
beforeAll(async () => { await Model.createCollection(); await Model.createIndexes(); });
beforeEach(async () => {
  await Model.collection.deleteMany({});
  await mongoose.connection.collection('conversation_exchange_receipts').deleteMany({ scope: EXCHANGE_SCOPE });
  await mongoose.connection.collection('conversation_work_dispatch').deleteMany({});
  current = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
    modeId: 'standard', status: 'active', agentId: 'main', backend: 'openclaw', turnCount: 0 });
  router = express.Router();
  continuity = jest.fn(async () => ({ capabilities: { isolatedWork: true, nativeReadBudget: true, nativeConversation: true } }));
  execute = jest.fn(async body => { await body.onStarted(`agent:${body.session.agentId}:household:direct:${body.session.sessionId}`, 'resp_' + randomUUID()); });
  works = registerWorkRuntime({ router, conversations, tasks: { list: () => { throw new Error('Main uses its native tools'); } },
    agentClient: execute, continuity, env, capability });
});
afterEach(() => works.observer.stop());

test.each(['Regarde mes tâches.', 'Ajoute une tâche personnelle pour demain.', 'Résume mes courriels récents.',
  'Demande à la secrétaire de rédiger un courriel.', 'Does the team play tonight?',
  'Compare the two options from our discussion.', 'Une demande inconnue de tous les anciens sélecteurs.'])
('every accepted work request reaches complete native Main: %s', async text => {
  const accepted = await works.intake(input(text));
  expect(accepted.row).toMatchObject({ mode: 'native', classification: 'native_work', state: 'received' });
  await works.prepare(accepted.row._id, 'Shared owner context.');
  expect(await works.nativeAcceptance(accepted.row._id)).toMatchObject({ mode: 'native', state: 'queued' });
  await works.observer.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  const sent = execute.mock.calls[0][0];
  expect(sent.session.agentId).toBe('main'); expect(sent.session.sessionId).not.toBe(current.sessionId);
  expect(sent.text).toBe(text); expect(sent.model).toBeUndefined(); expect(sent.channel).toBe('work');
  expect(sent.instructions).toContain('complete native Nestor Main');
  expect(sent.instructions).toContain('existing permissions and approval contracts');
  expect(sent.instructions).not.toContain('Never send, draft, modify');
  expect(sent.instructions).toContain('Address the adult owner directly');
  expect((await works.repo.get(accepted.row._id)).attempt.agentId).toBe('main');
});

test('a greeting keeps the live guardian and is then reviewed by complete Main without duplicate speech', async () => {
  const accepted = await works.intake(input('Bonjour.'));
  expect(accepted.row.classification).toBe('native_review');
  await works.prepare(accepted.row._id, 'Shared context.');
  expect(await works.nativeAcceptance(accepted.row._id)).toBeNull();
  await works.observer.tick(); expect(execute).not.toHaveBeenCalled();
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: accepted.row.turnId, replyText: 'Bonjour !' });
  await works.guardianSettled(accepted.row._id, 'completed');
  await works.observer.tick();
  const row = await works.repo.get(accepted.row._id);
  expect(row.attempt.agentId).toBe('main');
  expect(execute.mock.calls[0][0].instructions).toContain(NO_WORK);
  expect((await works.contextForNative(context(row))).guardianReply).toBe('Bonjour !');
  await works.publishNative(row._id, proof(row.attempt, NO_WORK));
  const snapshot = await createWorkDelivery(works).snapshot(current.sessionId);
  expect(snapshot.items[0]).toMatchObject({ resultDisposition: 'no_work', result: null, pending: false });
});

test('shared native context refresh sees new turns and pending work, without foreign selectors or worker privileges', async () => {
  const row = await admitted();
  const before = await works.contextForNative(context(row));
  expect(before.request).toBe('Help me compare these two options.');
  const later = await works.intake(input('Here is another detail to consider.'));
  await works.prepare(later.row._id, 'New detail.');
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: later.row.turnId, replyText: 'Detail received.' });
  const after = await works.contextForNative(context(row));
  expect(after.recentTurns).toEqual(expect.arrayContaining([expect.objectContaining({ inputText: 'Here is another detail to consider.', replyText: 'Detail received.' })]));
  expect(after.workContext).toContain(later.row._id);
  expect(after.nativeOwner).toBe('main'); expect(after).not.toHaveProperty('capabilities');
  for (const patch of [{ runId: 'resp_' + randomUUID() }, { agentId: 'family' }, { sessionKey: 'foreign' }, { workId: later.row._id }]) {
    await expect(works.contextForNative({ ...context(row), ...patch })).rejects.toMatchObject({ statusCode: 404 });
  }
  await expect(works.contextForWorker(context(row))).rejects.toMatchObject({ statusCode: 404 });
  await expect(works.readTasks(context(row), {}, 'forged-read')).rejects.toMatchObject({ statusCode: 404 });
  await expect(works.publish(context(row), { kind: 'answer', text: 'Invented', receiptIds: [] })).rejects.toMatchObject({ statusCode: 404 });
});

test('native context is a private host-bound route and is revoked on erasure', async () => {
  const row = await admitted(), app = express(); app.use(express.json()); app.use(router);
  const body = { operation: 'native_context', context: context(row) };
  expect((await request(app).post('/native/work').send(body)).status).toBe(404);
  const read = await request(app).post('/native/work').set('Authorization', 'Bearer ' + env.PERSONAL_CONVERSATION_WORK_TOKEN).send(body);
  expect(read.status).toBe(200); expect(read.body.data.request).toBe('Help me compare these two options.');
  const owner = await request(app).post('/native/work').set('Authorization', 'Bearer ' + env.PERSONAL_CONVERSATION_WORK_TOKEN)
    .send({ operation: 'native_owner', context: context(row) });
  expect(owner.status).toBe(200); expect(owner.body.data.sessionId).toBe(current.sessionId);
  for (const patch of [{ agentId: 'nestor-worker' }, { runId: 'resp_' + randomUUID() }, { sessionId: current.sessionId }]) {
    await expect(works.nativeOwner({ ...context(row), ...patch })).rejects.toMatchObject({ statusCode: 404 });
  }
  await conversations.deleteSession(works.query(current.sessionId));
  await expect(works.contextForNative(context(row))).rejects.toMatchObject({ statusCode: 404 });
  await expect(works.nativeOwner(context(row))).rejects.toMatchObject({ statusCode: 404 });
  await expect(works.publishNative(row._id, proof(row.attempt))).rejects.toMatchObject({ statusCode: 404 });
});

test('a verified native reasoning answer can settle without tools; stale or unavailable evidence cannot', async () => {
  const row = await admitted();
  const runtime = require('../../surfaces/household/native-work-runtime').nativeWorkRuntime({ works, conversations });
  for (const change of [{ authority: 'browser' }, { answer: { status: 'ready', runId: 'resp_' + randomUUID(), text: 'Foreign' } },
    { toolChecks: { status: 'unavailable', runId: row.attempt.runId, completedTools: [] } }]) {
    expect(await runtime.receive({ row, evidence: { ...proof(row.attempt), ...change } })).toBeNull();
  }
  expect(await runtime.receive({ row, evidence: proof(row.attempt) })).toEqual({ published: true });
  const stored = await works.repo.get(row._id);
  expect((await works.repo.read(stored, stored.result.payloadRef)).text).toBe('The completed native answer.');
});

test('Main personal task reads still require actual same-run native task evidence', async () => {
  const row = await admitted('Regarde mes tâches.');
  const runtime = require('../../surfaces/household/native-work-runtime').nativeWorkRuntime({ works, conversations });
  expect(await runtime.receive({ row, evidence: proof(row.attempt, 'Invented list.', ['tool_search']) })).toBeNull();
  expect(await runtime.receive({ row, evidence: proof(row.attempt, 'Actual native list.', ['list_personal_tasks']) })).toEqual({ published: true });
});

test('native generic tool budgets fence repeats and allow other work after the web-only limit', async () => {
  const row = await admitted(), ctx = context(row);
  for (let i = 0; i < 4; i++) expect((await works.admitNativeTool(ctx, { tool: 'web_fetch' }, 'web-' + i)).admitted).toBe(true);
  expect((await works.admitNativeTool(ctx, { tool: 'web_fetch' }, 'web-4')).admitted).toBe(false);
  expect((await works.admitNativeTool(ctx, { tool: 'list_personal_tasks' }, 'tasks')).admitted).toBe(true);
  for (let i = 0; i < 11; i++) expect((await works.admitNativeTool(ctx, { tool: 'tool_search' }, 'other-' + i)).admitted).toBe(true);
  expect((await works.admitNativeTool(ctx, { tool: 'tool_search' }, 'overflow')).admitted).toBe(false);
  expect((await works.admitNativeTool(ctx, { tool: 'list_personal_tasks' }, 'tasks')).admitted).toBe(true);
  expect((await works.repo.get(row._id)).nativeAdmissions).toHaveLength(16);
});

test('interrupting acknowledgment leaves the original native work accepted; disabling intake preserves its mode and identity', async () => {
  const original = input('An arbitrary request.'), accepted = await works.intake(original);
  await works.prepare(accepted.row._id, 'Context.');
  await works.guardianSettled(accepted.row._id, 'cancelled');
  expect(await works.repo.get(accepted.row._id)).toMatchObject({ state: 'queued', classification: 'native_work' });
  const disabled = capability.create({ conversations, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' } });
  expect(await disabled.intake(original)).toMatchObject({ duplicate: true, row: { _id: accepted.row._id, mode: 'native' } });
  expect(await disabled.intake(input('New request.'))).toBeNull();
});

test.each([
  [{ packId: 'kidx_nestor', scopeId: 'family' }, 'voice'], [{ agentId: 'secretary' }, 'voice'],
  [{ modeId: 'open' }, 'voice'], [{ inference: { open: true } }, 'voice'], [{ llmx: {} }, 'voice'], [{}, 'text']
])('native mode preserves the existing boundary %j / %s', async (patch, channel) => {
  expect(await works.intake({ ...input('A request.'), session: { ...current, ...patch }, channel })).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

test('native intake lost before row insertion recovers its saved mode even after rollout is disabled', async () => {
  const original = input('Compare two options.'), exchanges = require('../../src/services/conversations/exchangeReceipts');
  await exchanges.accept(EXCHANGE_SCOPE, { body: { text: original.text, attachments: [], sessionId: current.sessionId,
    clientTurnId: original.turnId, channel: 'voice', mode: 'native' } }, original.turnId, current.conversationId);
  const disabled = capability.create({ conversations, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' } });
  await disabled.recover();
  const row = await disabled.repo.get(hash(current.sessionId + '\n' + original.turnId));
  expect(row).toMatchObject({ mode: 'native', classification: 'native_work', guardian: { state: 'uncertain' } });
  expect(row.attempt).toBeUndefined(); expect(execute).not.toHaveBeenCalled();
});

test('an already accepted legacy task read keeps its original worker after native mode is enabled', async () => {
  const legacy = capability.create({ conversations, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'read' }, classify: () => true });
  const accepted = await legacy.intake(input('Regarde mes tâches.'));
  await legacy.prepare(accepted.row._id, 'Legacy selected context.');
  await works.observer.tick();
  expect(execute.mock.calls[0][0].session.agentId).toBe('nestor-worker');
  expect((await works.repo.get(accepted.row._id)).mode).toBe('read');
});

test('a lost native response is reconciled by the original Main identity, never another dispatch', async () => {
  const accepted = await works.intake(input('Compare our two options.'));
  await works.prepare(accepted.row._id, 'Shared context.');
  const runId = 'resp_' + randomUUID();
  execute.mockImplementation(async () => { throw new Error('Lost dispatch response'); });
  continuity.mockImplementation(async req => req.operation === 'agents'
    ? { capabilities: { isolatedWork: true, nativeReadBudget: true, nativeConversation: true } }
    : req.operation === 'work_attempt' ? { sessionKey: req.sessionKey, runId }
      : proof({ sessionKey: req.sessionKey, runId }));
  await works.observer.tick(); await works.observer.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await works.repo.get(accepted.row._id)).toMatchObject({ state: 'completed', attempt: { agentId: 'main', runId, terminal: 'completed' } });
  expect((await mongoose.connection.collection('conversation_work_dispatch').findOne({ _id: OWNER })).workId).toBeNull();
});

test('real voice HTTP acknowledges a clear work request immediately and keeps the guardian free while complete Main works', async () => {
  const text = 'Regarde mes tâches.', turnId = randomUUID();
  const foreground = jest.fn(async body => ({ text: 'Bonjour ! Je suis disponible.', metadata: { model: 'guardian-model' },
    sessionKey: `agent:main:household:direct:${current.sessionId}`, tools: { status: 'observed', receipts: [] } }));
  const executor = createConversationExecutor({ env, inference: {}, agentClient: foreground });
  const app = await personalHttp(executor);
  const first = await request(app).post(`/sessions/${current.sessionId}/turns/text`)
    .send({ text, turnId, channel: 'voice', stream: true }).timeout(3000);
  expect(first.status).toBe(200); expect(first.text).toContain('Je m’en occupe');
  expect(foreground).not.toHaveBeenCalled();
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), dispatched = new Promise(resolve => { started = resolve; });
  execute.mockImplementation(async body => {
    await body.onStarted(`agent:${body.session.agentId}:household:direct:${body.session.sessionId}`, 'resp_' + randomUUID()); started(); await held;
  });
  continuity.mockImplementation(async req => req.operation === 'agents'
    ? { capabilities: { isolatedWork: true, nativeReadBudget: true, nativeConversation: true } }
    : req.operation === 'work_attempt' ? { runId: req.runId, sessionKey: req.sessionKey }
      : proof({ runId: req.runId, sessionKey: req.sessionKey }, 'The completed native answer.', ['list_personal_tasks']));
  const running = works.observer.tick();
  try {
    await Promise.race([dispatched, running.then(() => { throw new Error('Native attempt ended before its dispatch fixture'); })]);
    const followup = await request(app).post(`/sessions/${current.sessionId}/turns/text`)
      .send({ text: 'Bonjour.', turnId: randomUUID(), channel: 'voice', stream: true }).timeout(3000);
    expect(followup.status).toBe(200); expect(foreground).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
    const row = await works.repo.get(hash(current.sessionId + '\n' + turnId));
    expect(row).toMatchObject({ state: 'running', classification: 'native_work', attempt: { agentId: 'main' } });
    expect(row.result).toBeUndefined();
    expect((await works.contextForNative(context(row))).recentTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({ inputText: 'Bonjour.', replyText: 'Bonjour ! Je suis disponible.' })]));
  } finally { release(); await running; }
  const row = await works.repo.get(hash(current.sessionId + '\n' + turnId));
  expect(row).toMatchObject({ state: 'completed', result: { version: 1 } });
  const disabled = capability.create({ conversations, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' } });
  expect((await createWorkDelivery(disabled).snapshot(current.sessionId)).items.find(item => item.id === row._id).result.text)
    .toBe('The completed native answer.');
});

test('ordinary conversation gets a real guardian response while Main is busy, and still reaches Main with shared context', async () => {
  const accepted = await works.intake(input('Compare these options.'));
  await works.prepare(accepted.row._id, 'Context.');
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), dispatched = new Promise(resolve => { started = resolve; });
  execute.mockImplementation(async body => {
    await body.onStarted(`agent:main:household:direct:${body.session.sessionId}`, 'resp_' + randomUUID()); started(); await held;
  });
  const running = works.observer.tick();
  try {
    await Promise.race([dispatched, running.then(() => { throw new Error('Native attempt ended before fixture'); })]);
    const guardian = jest.fn(async body => {
      expect((await body.readAcceptedNativeWork()).foreground).toBe('guardian');
      expect(body.turnDirective).toContain('No tools or second dispatch from the guardian');
      const runId = 'resp_' + randomUUID(), key = `agent:main:household:direct:${current.sessionId}`;
      await body.onStarted(key, runId);
      return { text: 'On reprend tranquillement. Je suis là.', sessionKey: key, runId,
        metadata: { model: 'guardian-model' }, tools: { status: 'observed', receipts: [] } };
    });
    const warmup = { noteTurn() {}, settled: jest.fn(async () => {}) };
    const app = await personalHttp(createConversationExecutor({ env, inference: {}, agentClient: guardian }), warmup);
    const turnId = randomUUID(), text = 'Je me suis perdu dans mes réflexions.';
    const response = await request(app).post(`/sessions/${current.sessionId}/turns/text`).send({ text, turnId, channel: 'voice', stream: true }).timeout(3000);
    expect(response.status).toBe(200); expect(response.text).toContain('On reprend tranquillement');
    expect(guardian).toHaveBeenCalledTimes(1); expect(warmup.settled).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const followup = await works.repo.get(hash(current.sessionId + '\n' + turnId));
    expect(followup).toMatchObject({ classification: 'native_work', mode: 'native', state: 'queued' });
    const bound = { agentId: 'main', sessionKey: followup.guardian.sessionKey, runId: followup.guardian.runId };
    expect(await works.guardianTool(bound)).toMatchObject({ delegated: true, execution: 'pending' });
    const first = await works.repo.get(accepted.row._id);
    await expect(works.guardianTool(context(first))).rejects.toMatchObject({ statusCode: 404 });
    expect((await works.contextForNative(context(first))).recentTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({ inputText: text, replyText: 'On reprend tranquillement. Je suis là.' })]));
  } finally { release(); await running; }
});

test('Main can disposition an adequate conversational guardian answer without duplicating it', async () => {
  const row = await admitted();
  const runtime = require('../../surfaces/household/native-work-runtime').nativeWorkRuntime({ works, conversations });
  expect(await runtime.receive({ row, evidence: proof(row.attempt, NO_WORK) })).toBeNull();
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: row.turnId, replyText: 'An adequate answer from the guardian.' });
  expect(await runtime.receive({ row, evidence: proof(row.attempt, NO_WORK) })).toEqual({ published: true });
  expect((await createWorkDelivery(works).snapshot(current.sessionId)).items[0])
    .toMatchObject({ resultDisposition: 'no_work', result: null, pending: false });
});

async function personalHttp(executeConversation, warmup = null) {
  const packs = require('../../surfaces/household/packs'), prompt = require('../../surfaces/household/persona-prompt');
  const records = require('../../surfaces/household/persona-records'), pack = packs.packById('personal_operator');
  current = await conversations.updateSession({ sessionId: current.sessionId }, { $set: { modeId: pack.defaultMode,
    persona: { id: 'nestor', version: 1, name: 'Nestor', identity: 'Synthetic personality.', voice: {} }, voice: { language: 'auto' } } });
  const handler = require('../../surfaces/household/persona-turn').createPersonaTurnHandler({
    runtimeServices: { attachments: { ids: () => [] } }, conversations, conversationEnv: env, conversationWorks: works, warmup,
    executeConversation, requireNativeAgent: async () => {}, familyTasks: { listProfiles: async () => ({ profiles: [] }), listProfileDetails: async () => ({ profiles: [] }) },
    ownerMemory: {}, familyMemory: {}, notesFor: () => ({ search: async () => ({ notes: [] }), record: async () => ({}) }),
    personalAttachments: () => ({ prepare: async messages => messages.map(({ attachments, ...message }) => message) }),
    knowledgeState: { config: null, status: { status: 'disabled', corpusFingerprint: null } },
    openHold: {}, openingPayload: () => ({}), sounds: { select: () => null, get: () => null }, visuals: { sources: () => [] },
    brain: { cancel() {}, schedule() { throw new Error('Legacy review must not duplicate this accepted work'); }, contextFor: () => '' },
    activePersonaTurns: new Map(), validClientTurnId: id => /^[a-zA-Z0-9-]{16,80}$/.test(id),
    envelope: (res, data, status = 200) => res.status(status).json({ ok: true, data }),
    fail: (res, status, message, code) => res.status(status).json({ message, code }),
    cleanText: (value, max = 4000) => String(value || '').trim().slice(0, max),
    assessSafety: prompt.assessSafety, childBoundaryReply: prompt.childBoundaryReply, escalationReply: prompt.escalationReply,
    detectMemoryRequest: prompt.detectMemoryRequest, packById: packs.packById, packSummary: packs.packSummary, modeSummary: packs.modeSummary,
    publicSession: records.publicSession, systemPromptFor: prompt.systemPromptFor, spokenReplyLanguage: prompt.spokenReplyLanguage,
    sessionHistoryMessages: records.sessionHistoryMessages, loadSessionAuditRows: records.loadSessionAuditRows,
    MEMORY_RECALL_LIMIT: prompt.MEMORY_RECALL_LIMIT, PERSONAL_OPERATOR_SURFACE_CONTRACT: packs.PERSONAL_OPERATOR_SURFACE_CONTRACT,
    VOIX_FAMILY_PACK_ID: 'kidx_nestor' });
  const app = express(); app.use(express.json()); app.post('/sessions/:sessionId/turns/text', (req, res) => handler(req, res, 'private'));
  return app;
}
