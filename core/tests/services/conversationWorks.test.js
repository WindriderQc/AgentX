'use strict';
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createConversationWorks } = require('../../src/services/conversationWorks/service');
const { createWorkObserver } = require('../../src/services/conversationWorks/observer');
const { createWorkDelivery } = require('../../src/services/conversationWorks/delivery');
const { registerConversationWorkRoutes } = require('../../src/services/conversationWorks/routes');
const { OWNER, EXCHANGE_SCOPE, hash } = require('../../src/services/conversationWorks/contract');
const exchanges = require('../../src/services/conversations/exchangeReceipts');
const Model = require('../../models/ConversationWorkState');
const conversations = forSurface('household');
const env = { PERSONAL_CONVERSATION_WORK_MODE: 'read', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'nestor-worker',
  PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-private-work-binding-token' };
const native = () => 'resp_' + randomUUID();
let tasks, works, current;
const input = (text = 'Regarde mes tâches.', extra = {}) => ({ session: current, turnId: randomUUID(), text, ...extra });
async function startWork(text) {
  const accepted = await works.intake(input(text));
  await works.prepare(accepted.row._id, 'Selected personal context');
  const attempt = { id: randomUUID(), sessionId: randomUUID(), agentId: env.PERSONAL_CONVERSATION_WORK_AGENT_ID, runId: native() };
  attempt.sessionKey = `agent:${attempt.agentId}:household:direct:${attempt.sessionId}`;
  const row = await works.repo.mutate(accepted.row._id, () => ({ fields: { state: 'running', attempt }, event: 'fixture_native_started' }));
  return { row, context: { agentId: attempt.agentId, sessionKey: attempt.sessionKey, runId: attempt.runId } };
}
async function result() {
  const job = await startWork();
  const read = await works.readTasks(job.context, { limit: 5 }, 'native-call-1');
  await works.publish(job.context, { kind: 'answer', text: 'Deux tâches sont enregistrées.', receiptIds: [read.receipt.id] });
  return { ...job, row: await works.repo.get(job.row._id), read };
}
beforeAll(async () => { await Model.createCollection(); await Model.createIndexes(); });
beforeEach(async () => {
  await Model.collection.deleteMany({});
  await mongoose.connection.collection('conversation_exchange_receipts').deleteMany({ scope: EXCHANGE_SCOPE });
  tasks = { list: jest.fn(async () => ({ tasks: [{ id: 'synthetic-a', title: 'Synthetic task' }], totalCount: 1 })) };
  works = createConversationWorks({ conversations, tasks, env, classify: text => /tâches/.test(text) });
  current = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
    modeId: 'standard', status: 'active', agentId: 'main', backend: 'openclaw', turnCount: 0 });
  await mongoose.connection.collection('conversation_work_dispatch').deleteMany({});
});

test('accepts complete human input before any model and settles the same slot exactly once', async () => {
  const original = input('Regarde mes tâches : café, été et école.');
  const accepted = await works.intake(original);
  expect(await conversations.getTurn({ sessionId: current.sessionId, traceId: original.turnId })).toMatchObject({
    inputText: original.text, replyText: '', outcome: 'pending' });
  expect((await exchanges.read(EXCHANGE_SCOPE, accepted.row.exchangeId)).request.body.text).toBe(original.text);
  expect(tasks.list).not.toHaveBeenCalled();
  expect((await works.intake(original)).duplicate).toBe(true);
  await expect(works.intake({ ...original, text: 'Other request' })).rejects.toMatchObject({ statusCode: 409 });
  await conversations.settleTurn({ sessionId: current.sessionId, packId: 'personal_operator', scopeId: 'personal',
    traceId: original.turnId, inputText: 'cannot replace original', replyText: 'Je m’en occupe.' });
  await conversations.settleTurn({ sessionId: current.sessionId, packId: 'personal_operator', scopeId: 'personal',
    traceId: original.turnId, replyText: 'Must not overwrite the settled answer' });
  expect(await conversations.getTurn({ sessionId: current.sessionId, traceId: original.turnId })).toMatchObject({
    inputText: original.text, replyText: 'Je m’en occupe.', outcome: 'completed' });
  expect((await conversations.getSession({ sessionId: current.sessionId })).turnCount).toBe(1);
});

test.each([
  ['flag off', { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' }, {}, 'voice'],
  ['family', env, { packId: 'kidx_nestor', scopeId: 'family' }, 'voice'],
  ['specialist', env, { agentId: 'secretary' }, 'voice'],
  ['open mode', env, { inference: { open: true } }, 'voice'],
  ['LLMx', env, { llmx: {} }, 'voice'],
  ['text contract', env, {}, 'text'],
])('%s preserves its existing native path', async (_label, settings, patch, channel) => {
  const service = createConversationWorks({ conversations, tasks, env: settings });
  expect(await service.intake(input('Read tasks', { session: { ...current, ...patch }, channel }))).toBeNull();
});

test('complete input exceeds its budget by refusal, never by silent truncation', async () => {
  await expect(works.intake(input('a'.repeat(4001)))).rejects.toMatchObject({ code: 'CONVERSATION_WORK_INTAKE_INVALID' });
  expect(await conversations.countTurns({ sessionId: current.sessionId })).toBe(0);
});

test('native role/session/run binding ignores invented work identities and denies foreign scopes', async () => {
  const job = await startWork();
  await expect(works.readTasks({ ...job.context, agentId: 'family' }, {}, 'call')).rejects.toMatchObject({ statusCode: 404 });
  await expect(works.contextForWorker({ ...job.context, runId: native() })).rejects.toMatchObject({ statusCode: 404 });
  await expect(works.contextForWorker({ ...job.context, workId: job.row._id })).rejects.toMatchObject({ statusCode: 404 });
  expect((await works.contextForWorker(job.context)).request).toBe('Regarde mes tâches.');
});

test('a lost tool response is recovered from the same Core receipt without another read', async () => {
  const job = await startWork();
  const first = await works.readTasks(job.context, { limit: 5 }, 'stable-native-call');
  expect(await works.readTasks(job.context, { limit: 5 }, 'stable-native-call')).toEqual(first);
  expect(tasks.list).toHaveBeenCalledTimes(1);
  await expect(works.readTasks(job.context, { limit: 6 }, 'stable-native-call')).rejects.toMatchObject({ statusCode: 409 });
  await expect(works.readTasks(job.context, { owner: 'family' }, 'other-call')).rejects.toMatchObject({ code: 'CONVERSATION_WORK_READ_INVALID' });
});

test('publishes only owned receipts, retains result across a new service instance and rejects replacement', async () => {
  const job = await startWork();
  await expect(works.publish(job.context, { kind: 'answer', text: 'Invented', receiptIds: [] })).rejects.toMatchObject({ code: 'CONVERSATION_WORK_RECEIPT_REQUIRED' });
  await expect(works.publish(job.context, { kind: 'answer', text: 'Invented', receiptIds: [hash('foreign')] })).rejects.toMatchObject({ code: 'CONVERSATION_WORK_RECEIPT_INVALID' });
  const read = await works.readTasks(job.context, {}, 'call');
  const body = { kind: 'answer', text: 'Actual result', receiptIds: [read.receipt.id] };
  const published = await works.publish(job.context, body);
  expect(await works.publish(job.context, body)).toEqual(published);
  await expect(works.publish(job.context, { ...body, text: 'Replacement' })).rejects.toMatchObject({ statusCode: 409 });
  const restarted = createConversationWorks({ conversations, tasks, env });
  const snapshot = await createWorkDelivery(restarted).snapshot(current.sessionId);
  expect(snapshot.items[0].result).toMatchObject({ text: 'Actual result', presentation: 'available', version: 1 });
  expect(JSON.stringify(snapshot)).not.toContain('Selected personal context');
});

test('presentation ownership separates display, scheduled playback and completion across devices', async () => {
  const { row } = await result(), delivery = createWorkDelivery(works), deviceSession = randomUUID();
  const send = (stage, sequence, extra = {}) => delivery.receipt(current.sessionId, row.delivery.id,
    { stage, sequence, deviceSession, resultVersion: 1, ...extra });
  await send('displayed', 1);
  const claim = await send('claim', 2);
  expect(await send('claim', 2)).toEqual(claim);
  await expect(send('completed', 3, { claimToken: claim.claimToken })).rejects.toMatchObject({ statusCode: 409 });
  await expect(send('claim', 3, { deviceSession: randomUUID() })).rejects.toMatchObject({ code: 'CONVERSATION_WORK_PRESENTATION_HELD' });
  await send('started', 3, { claimToken: claim.claimToken });
  await send('interrupted', 4, { claimToken: claim.claimToken });
  await expect(send('claim', 5)).rejects.toMatchObject({ code: 'CONVERSATION_WORK_PRESENTATION_HELD' });
  const replay = await send('replay', 5);
  await send('started', 6, { claimToken: replay.claimToken });
  await send('completed', 7, { claimToken: replay.claimToken });
  expect((await works.repo.get(row._id)).delivery.state).toBe('completed');
});

test('erasure removes context/result/receipts and blocks a late native publication', async () => {
  const { row, context } = await result();
  await conversations.deleteSession({ sessionId: current.sessionId, packId: 'personal_operator', scopeId: 'personal' });
  const tombstone = await works.repo.getIncludingErased(row._id);
  expect(tombstone.erased).toBe(true);
  for (const field of ['contextRef', 'tools', 'result', 'delivery', 'sessionId']) expect(tombstone[field]).toBeUndefined();
  expect(await works.repo.get(row._id)).toBeNull();
  expect(await exchanges.read(EXCHANGE_SCOPE, row.exchangeId)).toBeNull();
  await expect(works.publish(context, { kind: 'answer', text: 'Late output', receiptIds: [] })).rejects.toMatchObject({ statusCode: 404 });
  expect(await mongoose.connection.collection('conversation_payload_chunks').countDocuments({ owner: current.conversationId })).toBe(0);
});

test('an accepted request interrupted before its canonical slot is recovered without replaying Main', async () => {
  const turnId = randomUUID(), original = input('Regarde mes tâches.', { turnId });
  const { receipt } = await exchanges.accept(EXCHANGE_SCOPE, { body: { text: original.text, attachments: [],
    sessionId: current.sessionId, channel: 'voice', clientTurnId: turnId, mode: 'read' } }, turnId, current.conversationId);
  const restarted = createConversationWorks({ conversations, tasks, env, classify: () => true,
    now: () => new Date(Date.now() + 61000) });
  await restarted.recover();
  const row = await restarted.repo.get(hash(current.sessionId + '\n' + turnId));
  expect(row).toMatchObject({ exchangeId: receipt._id, guardian: { state: 'uncertain' }, state: 'received' });
  await restarted.repo.mutate(row._id, () => ({ fields: { receivedAt: new Date(Date.now() - 120000) }, event: 'fixture_old_intake' }));
  await restarted.recover();
  expect(await restarted.repo.get(row._id)).toMatchObject({ state: 'queued', contextReady: true });
  expect(tasks.list).not.toHaveBeenCalled();
});

test('an ambiguous dispatch holds the global owner through restart and settles only with exact native evidence', async () => {
  const accepted = await works.intake(input()); await works.prepare(accepted.row._id, 'context');
  let attempt;
  const execute = jest.fn(async ({ row }) => { attempt = row.attempt; throw new Error('Lost transport response'); });
  const observe = jest.fn(async () => null);
  const first = createWorkObserver({ works, env, execute, observe });
  await first.tick(); first.stop();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await works.repo.get(accepted.row._id)).toMatchObject({ state: 'uncertain' });
  const restarted = createWorkObserver({ works, env, execute, observe });
  await restarted.tick(); await restarted.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  observe.mockResolvedValue({ runId: native(), run: { sessionKey: 'foreign', runId: native(), status: 'completed' } });
  await restarted.tick();
  expect((await works.repo.get(accepted.row._id)).state).toBe('uncertain');
  const runId = native(); observe.mockResolvedValue({ runId, run: { sessionKey: attempt.sessionKey, runId, status: 'failed' } });
  await restarted.tick();
  expect((await works.repo.get(accepted.row._id)).state).toBe('failed');
  expect((await mongoose.connection.collection('conversation_work_dispatch').findOne({ _id: OWNER })).workId).toBeNull();
  restarted.stop();
});

test('HTTP native entry point refuses a family identity, forged work parameters and missing private token', async () => {
  const app = express(), router = express.Router(); app.use(express.json()); registerConversationWorkRoutes(router, { works, env }); app.use(router);
  const job = await startWork();
  expect((await request(app).post('/native/work').send({ operation: 'context', context: job.context })).status).toBe(404);
  expect((await request(app).post('/native/work').set('Authorization', 'Bearer ' + env.PERSONAL_CONVERSATION_WORK_TOKEN)
    .send({ operation: 'context', context: { ...job.context, agentId: 'family' } })).status).toBe(404);
  expect((await request(app).post('/native/work').set('Authorization', 'Bearer ' + env.PERSONAL_CONVERSATION_WORK_TOKEN)
    .send({ operation: 'context', context: job.context, workId: job.row._id })).status).toBe(400);
});

test('queued work can be paused/resumed/cancelled by its exact owner revision, while an admitted native attempt cannot', async () => {
  const control = require('../../src/services/conversationWorks/control').createWorkControl(works);
  const accepted = await works.intake(input()); await works.prepare(accepted.row._id, 'context');
  let row = await works.repo.get(accepted.row._id);
  await expect(control(current.sessionId, row._id, { action: 'pause', revision: row.revision - 1 })).rejects.toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_STALE' });
  const paused = await control(current.sessionId, row._id, { action: 'pause', revision: row.revision });
  expect(paused.state).toBe('paused');
  const resumed = await control(current.sessionId, row._id, { action: 'resume', revision: paused.revision });
  expect(resumed.state).toBe('queued');
  const cancelled = await control(current.sessionId, row._id, { action: 'cancel', revision: resumed.revision });
  expect(cancelled.state).toBe('cancelled');
  const admitted = await startWork();
  await expect(control(current.sessionId, admitted.row._id, { action: 'cancel', revision: admitted.row.revision })).rejects.toMatchObject({ code: 'CONVERSATION_WORK_ALREADY_DISPATCHED' });
});

test('cursor pages cover more than 64 old results without advancing past an omitted work', async () => {
  for (let i = 0; i < 67; i++) await works.intake(input('Bonjour'));
  const delivery = createWorkDelivery(works), first = await delivery.snapshot(current.sessionId);
  expect(first.items).toHaveLength(64); expect(first.hasMore).toBe(true);
  const second = await delivery.snapshot(current.sessionId, first.cursor);
  expect(second.items).toHaveLength(3); expect(second.hasMore).toBe(false);
  expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(67);
});

test('a preparation revoked before the outbound fence is recoverable and cannot dispatch from the old owner', async () => {
  const accepted = await works.intake(input()); await works.prepare(accepted.row._id, 'context');
  const processId = randomUUID(), attempt = { id: randomUUID() };
  await mongoose.connection.collection('conversation_work_dispatch').insertOne({ _id: OWNER, workId: accepted.row._id,
    phase: 'preparing', processId, attempt });
  await works.repo.mutate(accepted.row._id, () => ({ fields: { state: 'dispatching', attempt }, event: 'fixture_preparation' }));
  const execute = jest.fn(), observer = createWorkObserver({ works, env, execute, observe: async () => null });
  await observer.tick(); observer.stop();
  expect(execute).not.toHaveBeenCalled();
  expect(await works.repo.get(accepted.row._id)).toMatchObject({ state: 'queued', attempt: null });
  expect((await mongoose.connection.collection('conversation_work_dispatch').findOne({ _id: OWNER })).workId).toBeNull();
});

test('a process killed after its native dispatch fence is never replaced on restart', async () => {
  const { fork } = require('node:child_process'), path = require('node:path'), { once } = require('node:events');
  const accepted = await works.intake(input()); await works.prepare(accepted.row._id, 'context');
  const child = fork(path.join(__dirname, '../fixtures/conversationWork.child.js'), [], {
    env: { ...process.env, WORK_TEST_MONGO_URI: process.env.MONGODB_URI_TEST }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = ''; child.stderr.on('data', bytes => { log += bytes.toString(); });
  try {
    const dispatched = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Child did not reach its dispatch fence: ' + log)), 10000);
      child.once('message', message => { clearTimeout(timeout); resolve(message); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('Child exited before dispatch: ' + code + ' ' + log)); });
    });
    expect(dispatched.workId).toBe(accepted.row._id);
    const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed;
    const execute = jest.fn(), restarted = createWorkObserver({ works, env, execute, observe: async () => null });
    await restarted.tick(); await restarted.tick(); restarted.stop();
    expect(execute).not.toHaveBeenCalled();
    const row = await works.repo.get(accepted.row._id);
    expect(row.state).toBe('uncertain'); expect(row.attempt.id).toBe(dispatched.attempt.id);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('erasing an admitted work preserves the native fence until its exact terminal receipt arrives', async () => {
  const job = await startWork();
  await mongoose.connection.collection('conversation_work_dispatch').insertOne({ _id: OWNER, workId: job.row._id, phase: 'dispatching' });
  await conversations.deleteSession({ sessionId: current.sessionId, packId: 'personal_operator', scopeId: 'personal' });
  const observe = jest.fn(async () => null), execute = jest.fn(), observer = createWorkObserver({ works, env, observe, execute });
  await observer.tick();
  expect((await mongoose.connection.collection('conversation_work_dispatch').findOne({ _id: OWNER })).workId).toBe(job.row._id);
  observe.mockResolvedValue({ runId: job.context.runId, run: { sessionKey: job.context.sessionKey, runId: job.context.runId, status: 'completed' } });
  await observer.tick(); observer.stop();
  expect((await mongoose.connection.collection('conversation_work_dispatch').findOne({ _id: OWNER })).workId).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

test('the real Household HTTP handler commits intake before its guardian adapter and reuses its canonical turn on duplicate', async () => {
  const packs = require('../../surfaces/household/packs'), prompt = require('../../surfaces/household/persona-prompt');
  const records = require('../../surfaces/household/persona-records'), pack = packs.packById('personal_operator');
  current = await conversations.updateSession({ sessionId: current.sessionId }, { $set: { modeId: pack.defaultMode,
    persona: { id: 'nestor', version: 1, name: 'Nestor', identity: 'Synthetic personality.', voice: {} }, voice: { language: 'auto' } } });
  const turnId = randomUUID(), calls = [];
  const executeConversation = require('../../surfaces/household/conversation-executor').createConversationExecutor({
    env, inference: {}, agentClient: async body => {
      calls.push(body);
      expect(await conversations.getTurn({ sessionId: current.sessionId, traceId: turnId })).toMatchObject({ inputText: 'Regarde mes tâches.', outcome: 'pending' });
      expect(body.history).toEqual([]);
      expect(await body.readAcceptedTaskWork()).toMatchObject({ authority: 'core.conversation-works', accepted: true,
        sessionId: current.sessionId, turnId, requestSha256: hash('Regarde mes tâches.') });
      expect(body.instructions).toContain('Core has already accepted this current personal task lookup');
      const sessionKey = `agent:main:household:direct:${current.sessionId}`, runId = native();
      await body.onStarted(sessionKey, runId);
      const accepted = await works.request({ agentId: 'main', sessionKey, runId });
      expect(accepted.execution).toBe('pending'); expect(tasks.list).not.toHaveBeenCalled();
      return { text: 'Je m’en occupe.', sessionKey, runId, metadata: { model: 'synthetic-native' },
        tools: { status: 'observed', receipts: [{ tool: 'conversation_work', status: 'verified', runId, acceptedWork: { id: accepted.id } }], runId } };
    } });
  works.guardianInstructions = require('../../surfaces/household/conversation-work-runtime').GUARDIAN;
  const handler = require('../../surfaces/household/persona-turn').createPersonaTurnHandler({
    runtimeServices: { attachments: { ids: () => [] } }, conversations, conversationEnv: env, conversationWorks: works,
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
  const body = { text: 'Regarde mes tâches.', turnId, stream: true, channel: 'voice', readAcceptedTaskWork: { forged: true } };
  const first = await request(app).post(`/sessions/${current.sessionId}/turns/text`).send(body);
  expect(first.status).toBe(200);
  const events = first.text.trim().split('\n').map(line => JSON.parse(line));
  expect(events[0]).toMatchObject({ type: 'accepted', turnId });
  expect(events.at(-1)).toMatchObject({ type: 'done', data: { traceId: turnId, reply: { text: 'Je m’en occupe.' } } });
  const duplicate = await request(app).post(`/sessions/${current.sessionId}/turns/text`).send(body);
  expect(duplicate.status).toBe(202); expect(duplicate.body.data.reply.text).toBe('Je m’en occupe.');
  expect(calls).toHaveLength(1); expect((await conversations.getSession({ sessionId: current.sessionId })).turnCount).toBe(1);
});

test('worker results and pending states feed the guardian’s next selected context within the same personal conversation', async () => {
  const job = await result();
  for (let i = 0; i < 5; i++) await works.intake(input('Bonjour'));
  const context = await works.guardianContext(current.sessionId);
  expect(context).toContain('Deux tâches sont enregistrées.'); expect(context).toContain(job.row._id);
  expect(await works.guardianContext(current.sessionId, job.row._id)).toBe('');
  const foreign = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal', modeId: 'standard', status: 'active' });
  expect(await works.guardianContext(foreign.sessionId)).toBe('');
  const family = await conversations.createSession({ sessionId: randomUUID(), packId: 'kidx_nestor', scopeId: 'family', modeId: 'family', status: 'active' });
  await expect(works.guardianContext(family.sessionId)).rejects.toMatchObject({ statusCode: 404 });
});

test('flag off preserves immutable accepted mode and deduplication for retained turns', async () => {
  const original = input(), accepted = await works.intake(original);
  const disabled = createConversationWorks({ conversations, tasks, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' } });
  const retained = await disabled.intake(original);
  expect(retained).toMatchObject({ duplicate: true, row: { _id: accepted.row._id, mode: 'read' } });
  expect(await disabled.intake(input())).toBeNull();
});

test('flag off recovers an accepted exchange interrupted before work insertion without replaying the guardian', async () => {
  const original = input(), { receipt } = await exchanges.accept(EXCHANGE_SCOPE, { body: { text: original.text,
    attachments: [], sessionId: current.sessionId, channel: 'voice', clientTurnId: original.turnId, mode: 'read' } },
  original.turnId, current.conversationId);
  const disabled = createConversationWorks({ conversations, tasks, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' } });
  const retained = await disabled.intake(original);
  expect(retained).toMatchObject({ duplicate: true, row: { exchangeId: receipt._id, mode: 'read', guardian: { state: 'uncertain' } } });
  expect(await conversations.countTurns({ sessionId: current.sessionId })).toBe(1);
  expect(tasks.list).not.toHaveBeenCalled();
});
