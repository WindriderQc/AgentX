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
const { createWorkControl } = require('../../src/services/conversationWorks/control');
const { OWNER, EXCHANGE_SCOPE, hash, NO_WORK } = require('../../src/services/conversationWorks/contract');
const Model = require('../../models/ConversationWorkState');
const { createWorkObserver } = require('../../src/services/conversationWorks/observer');
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

test('awaited work precedes queued native reviews, retaining FIFO and completing every original once', async () => {
  works.observer.stop();
  const list = jest.fn(async () => ({ tasks: [], totalCount: 0 }));
  works = registerWorkRuntime({ router: express.Router(), conversations, tasks: { list }, agentClient: execute, continuity, env, capability });
  works.observer.stop();
  const reviews = [], awaited = [];
  for (let index = 0; index < 2; index++) {
    const job = await works.intake(input('Bonjour.'));
    await works.prepare(job.row._id, `Complete review context ${index}`);
    await conversations.settleTurn({ ...works.query(current.sessionId), traceId: job.row.turnId, replyText: 'Bonjour !' });
    await works.guardianSettled(job.row._id, 'completed', 'answered');
    reviews.push(job.row._id);
  }
  for (let index = 0; index < 2; index++) {
    const job = await works.intake(input('Lis mes tâches personnelles ouvertes.'));
    await works.prepare(job.row._id, `Complete awaited context ${index}`);
    await conversations.settleTurn({ ...works.query(current.sessionId), traceId: job.row.turnId, replyText: 'La lecture est acceptée.' });
    await works.guardianSettled(job.row._id, 'completed', 'awaiting_main');
    awaited.push(job.row._id);
  }
  const sent = [], evidence = new Map();
  const native = require('../../surfaces/household/native-work-runtime').nativeWorkRuntime({ works, conversations });
  const observer = createWorkObserver({ works, env, agentFor: () => 'main', now: () => Date.now() + 31000,
    execute: async ({ row, onStarted }) => {
      const runId = 'resp_' + randomUUID();
      await onStarted(row.attempt.sessionKey, runId);
      const saved = await works.repo.get(row._id);
      const canonical = await works.contextForNative(context(saved), 'call_' + row._id);
      const value = proof(saved.attempt, row.classification === 'native_review' ? NO_WORK : 'There are zero open tasks.', ['conversation_work']);
      if (canonical.receipt) value.receipts = [{ tool: 'conversation_work', status: 'verified', runId,
        workRead: { id: canonical.receipt.id, tool: 'tasks.personal.list' } }];
      evidence.set(runId, value); sent.push(row._id);
    }, observe: async attempt => evidence.get(attempt.runId), receive: request => native.receive(request) });
  try {
    for (let index = 0; index < 5; index++) await observer.tick();
    expect(sent).toEqual([...awaited, ...reviews]);
    expect(new Set(sent).size).toBe(4);
    expect(list).toHaveBeenCalledTimes(2);
    for (const id of sent) {
      const row = await works.repo.get(id);
      expect(row.state).toBe('completed');
      expect(row.attempt.terminal).toBe('completed');
    }
    expect((await works.conversationContext(current.sessionId)).coverage).toMatchObject({ complete: true, turnCount: 4, workResultCount: 2 });
  } finally { observer.stop(); }
});

test('an already admitted review retains its original owner when awaited work arrives', async () => {
  works.observer.stop();
  const running = await admitted('Bonjour.');
  await mongoose.connection.collection('conversation_work_dispatch').updateOne({ _id: OWNER },
    { $set: { workId: running._id, phase: 'dispatching', attempt: running.attempt } }, { upsert: true });
  const waiting = await works.intake(input('Lis mes tâches personnelles ouvertes.'));
  await works.prepare(waiting.row._id, 'Complete waiting context');
  const dispatch = jest.fn();
  const observer = createWorkObserver({ works, env, execute: dispatch,
    observe: async attempt => ({ run: { sessionKey: attempt.sessionKey, runId: attempt.runId, status: 'running' } }) });
  try {
    await observer.tick(); await observer.tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await works.repo.get(running._id)).attempt).toEqual(running.attempt);
    expect((await works.repo.get(waiting.row._id)).state).toBe('queued');
    expect((await mongoose.connection.collection('conversation_work_dispatch').findOne({ _id: OWNER })).workId).toBe(running._id);
  } finally { observer.stop(); }
});

test('the mandatory native context call includes one replay-safe canonical task read for an explicit request', async () => {
  works.observer.stop();
  const list = jest.fn(async () => ({ tasks: [{ id: 'synthetic-1', title: 'Synthetic task' }], totalCount: 8 }));
  works = registerWorkRuntime({ router: express.Router(), conversations, tasks: { list }, agentClient: execute, continuity, env, capability });
  const row = await admitted('Lis ma liste de tâches personnelles ouvertes et donne le total, puis au plus trois titres. Ne modifie rien.');
  const identity = context(row), callId = 'call_synthetic_context|fc_tasks';
  const read = await works.contextForNative(identity, callId);
  expect(read.request).toBe('Lis ma liste de tâches personnelles ouvertes et donne le total, puis au plus trois titres. Ne modifie rien.');
  expect(read.selectedContext).toBe('Selected owner context.');
  expect(read.conversation.coverage.complete).toBe(true);
  expect(read.receipt).toMatchObject({ tool: 'tasks.personal.list', status: 'verified', runId: identity.runId });
  expect(read.receiptIds).toContain(read.receipt.id);
  expect(read.data).toMatchObject({ totalCount: 8, tasks: [{ id: 'synthetic-1' }] });
  expect((await works.contextForNative(identity, callId)).receipt).toEqual(read.receipt);
  expect(list).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledWith({ limit: 25, includeDone: false, scope: 'active' });
  await expect(works.contextForNative({ ...identity, runId: 'resp_' + randomUUID() }, callId)).rejects.toMatchObject({ statusCode: 404 });
  await expect(works.readTasks(identity, {}, 'call_direct')).rejects.toMatchObject({ statusCode: 404 });
  const evidence = proof(row.attempt, 'Eight tasks, three requested titles.', ['conversation_work']);
  evidence.receipts = [{ tool: 'conversation_work', status: 'verified', runId: identity.runId,
    workRead: { id: read.receipt.id, tool: 'tasks.personal.list' } }];
  const runtime = require('../../surfaces/household/native-work-runtime').nativeWorkRuntime({ works, conversations });
  expect(await runtime.receive({ row: await works.repo.get(row._id), evidence })).toEqual({ published: true });
  expect((await works.repo.get(row._id)).state).toBe('result_ready');
});

test('the native personal task context counts owner actions without promoting extracted findings', async () => {
  const PipelineTask = require('../../models/PipelineTask');
  const personal = require('../../src/services/personalTaskService');
  await PipelineTask.deleteMany({});
  await PipelineTask.insertMany([
    { pipelineId: 'native-owner-action', service: 'personal', title: 'Call the garage', source: 'household-dad-desk' },
    { pipelineId: 'native-extracted-finding', service: 'personal', title: 'Continuer la lecture du document (offset 8000/24000)' },
  ]);
  const before = JSON.stringify(await PipelineTask.find().sort({ pipelineId: 1 }).lean());
  expect((await personal.listPersonalTasks()).totalCount).toBe(2);
  works.observer.stop();
  works = registerWorkRuntime({ router: express.Router(), conversations, tasks: { list: personal.listPersonalTasks },
    agentClient: execute, continuity, env, capability });
  const row = await admitted('Lis mes tâches personnelles ouvertes et donne leur nombre.');
  const read = await works.contextForNative(context(row), 'call_owner_scope');
  expect(read.data).toMatchObject({ count: 1, totalCount: 1, hasMore: false });
  expect(read.data.tasks.map(task => task.id)).toEqual(['native-owner-action']);
  expect(JSON.stringify(await PipelineTask.find().sort({ pipelineId: 1 }).lean())).toBe(before);
  await PipelineTask.deleteMany({});
});

test.each([false, true])('the current task read is visible before a long historical context, unavailable=%s', async unavailable => {
  works.observer.stop();
  const list = jest.fn(async () => {
    if (unavailable) throw new Error('Synthetic domain outage');
    return { tasks: [{ id: 'current-task', title: 'Current verified task' }], totalCount: 2 };
  });
  works = registerWorkRuntime({ router: express.Router(), conversations, tasks: { list }, agentClient: execute, continuity, env, capability });
  works.observer.stop();
  const older = await conversations.recordTurn({ ...works.query(current.sessionId), traceId: randomUUID(), outcome: 'completed',
    inputText: 'Earlier task read.', replyText: 'Earlier count: 99. ' + 'x'.repeat(35000) + ' LAST_HISTORICAL_DETAIL' });
  const row = await admitted('Lis mes tâches personnelles ouvertes et donne leur nombre.');
  const read = await works.contextForNative(context(row), 'call_current_read');
  // A relay's rendered head must expose the current result, rather than only
  // old history. The complete response and canonical record remain intact.
  const renderedHead = JSON.stringify(read, null, 2).slice(0, 2048);
  if (unavailable) {
    expect(renderedHead).toContain('"status": "unavailable"');
    expect(read.receipt).toBeUndefined();
  } else {
    expect(renderedHead).toContain('"totalCount": 2');
    expect(renderedHead).toContain(read.receipt.id);
    expect(read.receipt.runId).toBe(row.attempt.runId);
    expect((await works.contextForNative(context(row), 'call_current_read')).receipt).toEqual(read.receipt);
  }
  expect(read.conversation.turns[0].replyText).toBe(older.replyText);
  expect(read.conversation.coverage).toMatchObject({ complete: true, turnCount: 2 });
  expect((await conversations.getTurn({ ...works.query(current.sessionId), traceId: older.traceId })).replyText).toBe(older.replyText);
  expect(list).toHaveBeenCalledTimes(1);
});

test('native task context forwards the native call id over HTTP and denies another run before reading', async () => {
  works.observer.stop();
  const list = jest.fn(async () => ({ tasks: [], totalCount: 0 }));
  router = express.Router();
  works = registerWorkRuntime({ router, conversations, tasks: { list }, agentClient: execute, continuity, env, capability });
  const row = await admitted('Regarde mes tâches ouvertes.');
  const app = express(); app.use(express.json()); app.use(router);
  const body = { operation: 'native_context', context: context(row), callId: 'call_context_http' };
  const post = value => request(app).post('/native/work').set('Authorization', 'Bearer ' + env.PERSONAL_CONVERSATION_WORK_TOKEN).send(value);
  expect((await post({ ...body, context: { ...body.context, agentId: 'family' } })).status).toBe(404);
  expect(list).not.toHaveBeenCalled();
  expect((await post(body)).body.data.receipt.status).toBe('verified');
  expect((await post(body)).body.data.data.totalCount).toBe(0);
  expect(list).toHaveBeenCalledTimes(1);
});

test('ordinary native conversation context never speculatively reads tasks', async () => {
  const row = await admitted('Help me choose a colour.');
  const result = await works.contextForNative(context(row), 'call_colour_context');
  expect(result.data).toBeUndefined();
  expect(result.receipt).toBeUndefined();
});

test('native context shares repeated inline evidence without merging original runs or replaying reads', async () => {
  works.observer.stop();
  const data = { tasks: [{ id: 'shared-owner-action', title: 'x'.repeat(35000) + ' FINAL_SOURCE_DETAIL' }], totalCount: 1 };
  const list = jest.fn(async () => structuredClone(data));
  works = registerWorkRuntime({ router: express.Router(), conversations, tasks: { list }, agentClient: execute, continuity, env, capability });
  works.observer.stop();
  const runs = [];
  for (let index = 0; index < 3; index++) {
    const row = await admitted('Lis mes tâches ouvertes.');
    await works.readTasks(context(row), {}, 'synthetic-read', 'boss');
    await works.publishNative(row._id, proof(row.attempt, `Verified result ${index}`, ['conversation_work']));
    runs.push(row.attempt.runId);
  }
  const current = await admitted('Help me choose a colour.');
  const read = await works.contextForNative(context(current), 'synthetic-refresh');
  expect(read.nativeOwner).toBe('main');
  expect(read.conversation.coverage).toMatchObject({ complete: true, turnCount: 4, workResultCount: 3 });
  expect(Object.values(read.conversation.sharedToolEvidence)).toEqual([data]);
  const historical = read.conversation.turns.flatMap(turn => turn.workResults || []);
  expect(historical.map(work => work.text)).toEqual(['Verified result 0', 'Verified result 1', 'Verified result 2']);
  expect(historical.map(work => work.toolEvidence[0].runId)).toEqual(runs);
  expect(list).toHaveBeenCalledTimes(3);
  await expect(works.contextForNative({ ...context(current), runId: 'resp_' + randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
  expect((await works.conversationContext(current.sessionId)).sharedToolEvidence).toBeUndefined();
});

test('an unavailable contextual task read preserves complete context without inventing a receipt', async () => {
  const row = await admitted('Lis mes tâches ouvertes.');
  const result = await works.contextForNative(context(row), 'call_unavailable_tasks');
  expect(result.request).toBe('Lis mes tâches ouvertes.');
  expect(result.selectedContext).toBe('Selected owner context.');
  expect(result.conversation.coverage.complete).toBe(true);
  expect(result.taskRead).toEqual({ status: 'unavailable', code: 'CONVERSATION_WORK_READ_UNAVAILABLE' });
  expect(result.receipt).toBeUndefined();
  expect((await works.repo.get(row._id)).tools).toHaveLength(0);
});

test('composite native call identities keep exact replay, budget and run ownership', async () => {
  const row = await admitted('Lis https://example.test et vérifie sur le web.');
  const identity = context(row);
  for (let index = 0; index < 4; index++) {
    const callId = 'call_synthetic_shared|fc_synthetic_' + index;
    expect(await works.admitNativeTool(identity, { tool: 'web_fetch' }, callId)).toMatchObject({ admitted: true });
    expect(await works.admitNativeTool(identity, { tool: 'web_fetch' }, callId)).toMatchObject({ admitted: true });
  }
  expect((await works.repo.get(row._id)).nativeAdmissions).toHaveLength(4);
  expect(await works.admitNativeTool(identity, { tool: 'web_fetch' }, 'call_synthetic_shared|fc_fifth')).toMatchObject({ admitted: false });
  await expect(works.admitNativeTool(identity, { tool: 'web_search' }, 'call_synthetic_shared|fc_synthetic_0'))
    .rejects.toMatchObject({ code: 'CONVERSATION_WORK_TOOL_CONFLICT' });
  await expect(works.admitNativeTool({ ...identity, runId: 'resp_' + randomUUID() }, { tool: 'web_fetch' }, 'call_synthetic_shared|fc_synthetic_0'))
    .rejects.toMatchObject({ statusCode: 404 });
  for (const invalid of ['call bad|fc_bad', 'call\nforged|fc_bad', 'call_' + 'x'.repeat(161)]) {
    await expect(works.admitNativeTool(identity, { tool: 'web_fetch' }, invalid)).rejects.toMatchObject({ code: 'CONVERSATION_WORK_BUDGET_INVALID' });
  }
});

test('accepted cloud routes survive preference and instance changes while Main keeps its full native identity', async () => {
  const cloudEnv = { ...env, PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'synthetic-guardian',
    PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL: 'synthetic-cloud/deep-model',
    PERSONAL_CONVERSATION_CLOUD_GUARDIAN_MODEL: 'synthetic-cloud/fast-model' };
  const cloud = registerWorkRuntime({ router, conversations, tasks: {}, agentClient: execute, continuity, env: cloudEnv, capability });
  try {
    const original = { ...input('Regarde mes tâches.'), performanceProfile: 'full_cloud' };
    const first = await cloud.intake(original);
    expect(first.row.performance).toEqual({ profile: 'full_cloud', guardian: { model: 'synthetic-cloud/fast-model' }, boss: { model: 'synthetic-cloud/deep-model' } });
    expect(first.row.guardian.agentId).toBe('synthetic-guardian');
    cloudEnv.PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL = 'synthetic-cloud/replacement-model';
    cloudEnv.PERSONAL_CONVERSATION_WORK_MODE = 'off';
    const duplicate = await cloud.intake({ ...original, performanceProfile: 'local' });
    expect(duplicate.duplicate).toBe(true); expect(duplicate.row.performance).toEqual(first.row.performance);
    await cloud.prepare(first.row._id, 'Selected memory.');
    await cloud.observer.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    const sent = execute.mock.calls[0][0];
    expect(sent.model).toBe('synthetic-cloud/deep-model'); expect(sent.session.agentId).toBe('main');
    expect(sent.instructions).toContain('installed tools, personal memory');
    expect(sent.instructions).toContain('existing permissions and approval contracts');
    expect(sent.turnContext).toContain('Selected memory.'); expect(sent.turnContext).toContain(original.text);
    expect(sent.maxOutputTokens).toBeUndefined();
  } finally { cloud.observer.stop(); }
});

test('recovery reconstructs the original cloud routes from the canonical acceptance receipt', async () => {
  const cloudEnv = { ...env, PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'synthetic-guardian',
    PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL: 'synthetic-cloud/original-model' };
  const cloud = registerWorkRuntime({ router, conversations, tasks: {}, agentClient: execute, continuity, env: cloudEnv, capability });
  try {
    const original = { ...input('Regarde mes tâches.'), performanceProfile: 'boss_cloud' };
    const first = await cloud.intake(original);
    await Model.collection.deleteOne({ _id: first.row._id });
    delete cloudEnv.PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL;
    await cloud.recover();
    const recovered = await cloud.repo.get(first.row._id);
    expect(recovered.performance).toEqual(first.row.performance);
    expect(recovered.guardian.state).toBe('uncertain');
    const duplicate = await cloud.intake({ ...original, performanceProfile: 'local' });
    expect(duplicate.row.performance.boss.model).toBe('synthetic-cloud/original-model');
    expect(execute).not.toHaveBeenCalled();
  } finally { cloud.observer.stop(); }
});

test('unavailable cloud selection refuses before acceptance or native dispatch', async () => {
  await expect(works.intake({ ...input('Regarde mes tâches.'), performanceProfile: 'boss_cloud' }))
    .rejects.toMatchObject({ code: 'CONVERSATION_INFERENCE_PROFILE_UNAVAILABLE' });
  expect(await Model.countDocuments()).toBe(0);
  expect(await mongoose.connection.collection('conversation_exchange_receipts').countDocuments({ scope: EXCHANGE_SCOPE })).toBe(0);
  expect(execute).not.toHaveBeenCalled();
});

test.each([['Regarde mes tâches.', 'native_work'], ['Ajoute une tâche personnelle pour demain.', 'native_work'],
  ['Résume mes courriels récents.', 'native_work'], ['Demande à la secrétaire de rédiger un courriel.', 'native_work'],
  ['Does the team play tonight?', 'native_work'], ['Quelles sont mes tâches prioritaires ?', 'native_work'],
  ['Quels éléments de mon pipeline sont prioritaires ?', 'native_work'],
  ['Compare the two options from our discussion.', 'native_review'],
  ['Une demande inconnue de tous les anciens sélecteurs.', 'native_review']])
('every accepted work request reaches complete native Main: %s', async (text, classification) => {
  const accepted = await works.intake(input(text));
  expect(accepted.row).toMatchObject({ mode: 'native', classification, state: 'received' });
  await works.prepare(accepted.row._id, 'Shared owner context.');
  if (classification === 'native_review') {
    await works.observer.tick(); expect(execute).not.toHaveBeenCalled();
    await conversations.settleTurn({ ...works.query(current.sessionId), traceId: accepted.row.turnId, replyText: 'Guardian answer.' });
    await works.guardianSettled(accepted.row._id, 'completed');
  }
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
  expect(await works.nativeAcceptance(accepted.row._id)).toMatchObject({ foreground: 'guardian' });
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

test.each(['Bonjour.', 'Une demande inconnue de tous les anciens sélecteurs.'])(
  'an interrupted guardian leaves its native review queued for one Main attempt: %s', async text => {
  const accepted = await works.intake(input(text));
  await works.prepare(accepted.row._id, 'Shared context.');
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: accepted.row.turnId,
    replyText: '', outcome: 'cancelled', interrupted: true });
  const settled = await works.guardianSettled(accepted.row._id, 'cancelled');
  expect(settled).toMatchObject({ state: 'queued', classification: 'native_review', guardian: { state: 'cancelled' } });
  await works.observer.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  const row = await works.repo.get(accepted.row._id);
  expect((await works.contextForNative(context(row))).guardianOutcome).toBe('cancelled');
  await works.observer.tick();
  expect(execute).toHaveBeenCalledTimes(1);
});

test.each(['pause', 'cancel'])('a late Guardian interruption does not undo an owner %s', async action => {
  const accepted = await works.intake(input('Une demande inconnue de tous les anciens sélecteurs.'));
  await works.prepare(accepted.row._id, 'Shared context.');
  const beforeControl = await works.repo.get(accepted.row._id);
  const controlled = await createWorkControl(works)(current.sessionId, accepted.row._id,
    { action, revision: beforeControl.revision });
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: accepted.row.turnId,
    replyText: '', outcome: 'cancelled', interrupted: true });
  const settled = await works.guardianSettled(accepted.row._id, 'cancelled');
  expect(settled.state).toBe(controlled.state);
  await works.observer.tick();
  expect(execute).not.toHaveBeenCalled();
});

test('shared native context refresh sees new turns and pending work, without foreign selectors or worker privileges', async () => {
  const older = [];
  for (let index = 0; index < 14; index++) older.push(await conversations.recordTurn({ ...works.query(current.sessionId),
    traceId: randomUUID(), outcome: 'completed',
    inputText: index === 0 ? 'Earlier restriction: ' + 'x'.repeat(3000) + ' LAST_RESTRICTION' : `Question ${index}`,
    replyText: index === 0 ? 'Earlier correction: ' + 'y'.repeat(3000) + ' LAST_CORRECTION' : `Reply ${index}` }));
  const row = await admitted();
  const before = await works.contextForNative(context(row));
  expect(before.request).toBe('Help me compare these two options.');
  expect(before.conversation.coverage).toMatchObject({ complete: true, turnCount: 15, firstTurnId: older[0].traceId, lastTurnId: row.turnId });
  expect(before.conversation.turns[0]).toMatchObject({ inputText: older[0].inputText, replyText: older[0].replyText });
  const later = await works.intake(input('Here is another detail to consider.'));
  await works.prepare(later.row._id, 'New detail.');
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: later.row.turnId, replyText: 'Detail received.' });
  const after = await works.contextForNative(context(row));
  expect(after.conversation.turns).toEqual(expect.arrayContaining([expect.objectContaining({ inputText: 'Here is another detail to consider.', replyText: 'Detail received.' })]));
  expect(after.conversation.coverage.turnCount).toBe(16);
  expect(after.conversation.turns[0]).toMatchObject({ inputText: older[0].inputText, replyText: older[0].replyText });
  expect(after.conversation.turns.at(-1).turnId).toBe(later.row.turnId);
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
  const original = input('Regarde mes tâches.'), accepted = await works.intake(original);
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
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: accepted.row.turnId, replyText: 'Guardian comparison.' });
  await works.guardianSettled(accepted.row._id, 'completed');
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
  expect(first.status).toBe(200); expect(first.text).toContain('attend son tour');
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
    expect((await works.contextForNative(context(row))).conversation.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ inputText: 'Bonjour.', replyText: 'Bonjour ! Je suis disponible.' })]));
  } finally { release(); await running; }
  const row = await works.repo.get(hash(current.sessionId + '\n' + turnId));
  expect(row).toMatchObject({ state: 'completed', result: { version: 1 } });
  const disabled = capability.create({ conversations, env: { ...env, PERSONAL_CONVERSATION_WORK_MODE: 'off' } });
  expect((await createWorkDelivery(disabled).snapshot(current.sessionId)).items.find(item => item.id === row._id).result.text)
    .toBe('The completed native answer.');
});

test('ordinary conversation gets a real guardian response while Main is busy, and still reaches Main with shared context', async () => {
  const accepted = await works.intake(input('Regarde mes tâches.'));
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
    expect(followup).toMatchObject({ classification: 'native_review', mode: 'native', state: 'queued' });
    const bound = { agentId: 'main', sessionKey: followup.guardian.sessionKey, runId: followup.guardian.runId };
    expect(await works.guardianTool(bound)).toMatchObject({ delegated: true, execution: 'pending' });
    const first = await works.repo.get(accepted.row._id);
    await expect(works.guardianTool(context(first))).rejects.toMatchObject({ statusCode: 404 });
    expect((await works.contextForNative(context(first))).conversation.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ inputText: text, replyText: 'On reprend tranquillement. Je suis là.' })]));
  } finally { release(); await running; }
});

test.each(['Help me compare these two options.', 'Bonjour.'])
('Main can disposition an adequate guardian answer but cannot hide a missing reply: %s', async text => {
  const row = await admitted(text);
  const runtime = require('../../surfaces/household/native-work-runtime').nativeWorkRuntime({ works, conversations });
  expect(await runtime.receive({ row, evidence: proof(row.attempt, NO_WORK) })).toBeNull();
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: row.turnId, replyText: 'An adequate answer from the guardian.' });
  expect(await runtime.receive({ row, evidence: proof(row.attempt, NO_WORK) })).toEqual({ published: true });
  expect((await createWorkDelivery(works).snapshot(current.sessionId)).items[0])
    .toMatchObject({ resultDisposition: 'no_work', result: null, pending: false });
});

async function personalHttp(executeConversation, warmup = null, reviewContext = null) {
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
    brain: { cancel() {}, schedule() { throw new Error('Legacy review must not duplicate this accepted work'); }, contextFor: () => '',
      ...(reviewContext && { contextWithRefs: () => reviewContext }) },
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

test('a story is reviewed only after its actual guardian answer and Core rejects automatic playback of an alternate story', async () => {
  const accepted = await works.intake(input('Raconte-moi une histoire.'));
  await works.prepare(accepted.row._id, 'Selected context.');
  await works.observer.tick(); expect(execute).not.toHaveBeenCalled();
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: accepted.row.turnId, replyText: 'Il était une fois un renard.' });
  await works.guardianSettled(accepted.row._id, 'completed');
  await works.observer.tick();
  const row = await works.repo.get(accepted.row._id);
  expect((await works.contextForNative(context(row))).guardianReply).toBe('Il était une fois un renard.');
  await works.publishNative(row._id, proof(row.attempt, 'An unwanted second story.'));
  const delivery = createWorkDelivery(works), snapshot = await delivery.snapshot(current.sessionId), result = snapshot.items[0].result;
  expect(result).toMatchObject({ text: 'An unwanted second story.', automaticSpeech: false });
  const receipt = { stage: 'claim', resultVersion: result.version, sequence: 1, deviceSession: randomUUID() };
  await expect(delivery.receipt(current.sessionId, result.deliveryId, receipt)).rejects.toMatchObject({ code: 'CONVERSATION_WORK_EXPLICIT_LISTEN_REQUIRED' });
  expect(await delivery.receipt(current.sessionId, result.deliveryId, { ...receipt, stage: 'replay' })).toMatchObject({ state: 'claimed' });
});

test('the dedicated guardian uses a compact per-turn session, preserves Main history and shares its reply with complete Main', async () => {
  env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID = 'nestor-guardian';
  try {
    const mainKey = `agent:main:household:direct:${current.sessionId}`;
    current = await conversations.updateSession({ sessionId: current.sessionId }, { $set: { agentSessionKey: mainKey } });
    const guardian = jest.fn(async body => {
      expect(body.session.agentId).toBe('nestor-guardian'); expect(body.session.agentSessionKey).toBeNull();
      expect(body.instructions.length).toBeLessThan(3000); expect(body.instructions).not.toContain('tool_search');
      expect(body.guardianStreaming).toBe(true); expect(body.history.length).toBeLessThanOrEqual(6);
      const runId = 'resp_' + randomUUID(), key = `agent:nestor-guardian:household:direct:${body.session.sessionId}`;
      await body.onStarted(key, runId);
      return { text: 'Il était une fois un renard.', sessionKey: key, runId, metadata: { model: 'voice-model' }, tools: { status: 'observed', receipts: [] } };
    });
    const app = await personalHttp(createConversationExecutor({ env, inference: {}, agentClient: guardian }));
    const turnId = randomUUID();
    const response = await request(app).post(`/sessions/${current.sessionId}/turns/text`).send({ text: 'Raconte-moi une histoire.', turnId, channel: 'voice', stream: true });
    expect(response.status).toBe(200); expect(response.text).toContain('Il était une fois');
    expect(guardian.mock.calls[0][0].session.sessionId).not.toBe(current.sessionId);
    expect((await conversations.getSession(works.query(current.sessionId))).agentSessionKey).toBe(mainKey);
    const row = await works.repo.get(hash(current.sessionId + '\n' + turnId));
    expect(row.guardian).toMatchObject({ agentId: 'nestor-guardian', state: 'completed' });
    expect(guardian.mock.calls[0][0].session.sessionId).toBe(row.guardian.sessionId);
    const bound = { agentId: 'nestor-guardian', sessionKey: row.guardian.sessionKey, runId: row.guardian.runId };
    expect(await works.guardianTool(bound)).toMatchObject({ delegated: true });
    await expect(works.guardianTool({ ...bound, agentId: 'main' })).rejects.toMatchObject({ statusCode: 404 });
    await works.observer.tick();
    expect((await works.repo.get(row._id)).attempt).toBeUndefined();
    // Advance only this disposable review's recorded eligibility times.
    await Model.collection.updateOne({ _id: row._id }, { $set: {
      receivedAt: new Date(new Date(row.receivedAt).getTime() - 31000),
      events: row.events.map(event => ({ ...event, at: new Date(new Date(event.at).getTime() - 31000) })) } });
    await works.observer.tick();
    const reviewed = await works.repo.get(row._id);
    expect(reviewed.attempt.agentId).toBe('main');
    expect((await works.contextForNative(context(reviewed))).guardianReply).toBe('Il était une fois un renard.');
  } finally { delete env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID; }
});

test('a capped Guardian turn records only advice actually sent in its context', async () => {
  env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID = 'nestor-guardian';
  try {
    const brainRef = { source: 'brain', adviceId: 'large-advice', version: 1, sourceTurnId: 'earlier', coverage: ['corrections'] };
    const workRef = { source: 'work', workId: 'verified-work', version: 2, sourceTurnId: 'earlier', coverage: ['result'] };
    works.guardianContextWithRefs = async () => ({ text: '\nVerified work status.', refs: [workRef] });
    const guardian = jest.fn(async body => {
      expect(body.turnContext).toContain('Verified work status.');
      expect(body.turnContext).not.toContain('OVERSIZED_ADVICE');
      return { text: 'Bonjour !', metadata: { model: 'synthetic-guardian' }, tools: { status: 'observed', receipts: [] } };
    });
    const app = await personalHttp(createConversationExecutor({ env, inference: {}, agentClient: guardian }), null,
      { text: 'OVERSIZED_ADVICE'.repeat(600), refs: [brainRef] });
    const turnId = randomUUID();
    const response = await request(app).post(`/sessions/${current.sessionId}/turns/text`)
      .send({ text: 'Bonjour.', turnId, channel: 'voice', stream: true });
    expect(response.status).toBe(200);
    const done = response.text.trim().split('\n').map(line => JSON.parse(line)).find(item => item.type === 'done');
    expect(done.data.adviceRefs).toEqual([workRef]);
    expect((await conversations.getTurn({ sessionId: current.sessionId, traceId: turnId })).adviceRefs).toEqual([workRef]);
    expect(guardian).toHaveBeenCalledTimes(1);
  } finally { delete env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID; }
});

test.each([
  ['[[NESTOR_MAIN_REQUIRED]] Je consulte le document pour toi.', 'Je consulte le document pour toi.'],
  ['Je demande la vérification à Main. Je te reviens avec le résultat.', 'Je demande la vérification à Main. Je te reviens avec le résultat.']
])('real voice HTTP retains semantic handoff without leaking routing text: %s', async (raw, expected) => {
  env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID = 'nestor-guardian';
  try {
    const guardian = jest.fn(async body => {
      await body.onStarted(`agent:nestor-guardian:household:direct:${body.session.sessionId}`, 'resp_' + randomUUID());
      body.onDelta(raw.slice(0, 8)); body.onDelta(raw.slice(8, 24)); body.onDelta(raw.slice(24));
      return { text: raw, metadata: { model: 'synthetic-guardian' }, tools: { status: 'observed', receipts: [] } };
    });
    const app = await personalHttp(createConversationExecutor({ env, inference: {}, agentClient: guardian }));
    const turnId = randomUUID(), text = 'Quel est le montant du document dont on parlait ?';
    const response = await request(app).post(`/sessions/${current.sessionId}/turns/text`).send({ text, turnId, channel: 'voice', stream: true });
    expect(response.status).toBe(200); expect(response.text).not.toContain('NESTOR_MAIN_REQUIRED');
    const row = await works.repo.get(hash(current.sessionId + '\n' + turnId));
    expect(row).toMatchObject({ classification: 'native_work', foreground: 'acknowledge', state: 'queued', guardian: { disposition: 'awaiting_main' } });
    const turn = await conversations.getTurn({ ...works.query(current.sessionId), traceId: turnId });
    expect(turn.inputText).toBe(text); expect(turn.replyText).toBe(expected);
    await works.observer.tick();
    expect((await works.contextForNative(context(await works.repo.get(row._id)))).guardianDisposition).toBe('awaiting_main');
  } finally { delete env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID; }
});

test('enabling the dedicated guardian preserves the owner of already accepted Main guardian runs', async () => {
  const accepted = await works.intake(input('Bonjour.'));
  env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID = 'nestor-guardian';
  try {
    const key = `agent:main:household:direct:${current.sessionId}`, runId = 'resp_' + randomUUID();
    await works.guardianStarted(accepted.row._id, key, runId);
    expect(await works.guardianTool({ agentId: 'main', sessionKey: key, runId })).toMatchObject({ delegated: true });
    await expect(works.guardianStarted(accepted.row._id, key.replace('main', 'nestor-guardian'), runId, 'nestor-guardian')).rejects.toMatchObject({ statusCode: 404 });
  } finally { delete env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID; }
});

test('a semantic guardian handoff promotes a selector-missed request and delivers the original Main result once', async () => {
  const row = await admitted('Quel est le montant dans le document dont on parlait ?');
  expect(row.classification).toBe('native_review');
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: row.turnId, replyText: 'Je consulte le document.' });
  await works.guardianSettled(row._id, 'completed', 'awaiting_main');
  const handed = await works.repo.get(row._id);
  expect(handed).toMatchObject({ classification: 'native_work', foreground: 'acknowledge', guardian: { disposition: 'awaiting_main' }, attempt: row.attempt });
  const runtime = require('../../surfaces/household/native-work-runtime').nativeWorkRuntime({ works, conversations });
  expect(await runtime.receive({ row: handed, evidence: proof(row.attempt, NO_WORK) })).toBeNull();
  await works.publishNative(row._id, proof(row.attempt, 'The verified amount is 42.'));
  const delivery = createWorkDelivery(works), result = (await delivery.projection(await works.repo.get(row._id))).result;
  expect(result).toMatchObject({ automaticSpeech: true, text: 'The verified amount is 42.' });
  const receipt = { stage: 'claim', resultVersion: 1, sequence: 1, deviceSession: randomUUID() };
  expect(await delivery.receipt(current.sessionId, result.deliveryId, receipt)).toMatchObject({ state: 'claimed' });
  await expect(delivery.receipt(current.sessionId, result.deliveryId, { ...receipt, sequence: 2, deviceSession: randomUUID() }))
    .rejects.toMatchObject({ code: 'CONVERSATION_WORK_PRESENTATION_HELD' });
});

test('a completed direct guardian reply stays manual even when Main unnecessarily invokes another tool', async () => {
  const row = await admitted('Raconte-moi une histoire.');
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: row.turnId, replyText: 'Il était une fois.' });
  await works.guardianSettled(row._id, 'completed', 'answered');
  await works.publishNative(row._id, proof(row.attempt, 'Unwanted alternate story.', ['web_fetch']));
  expect((await createWorkDelivery(works).projection(await works.repo.get(row._id))).result.automaticSpeech).toBe(false);
});

test('a retained unmarked handoff recovers its original reasoning result despite an older answered flag', async () => {
  const row = await admitted('Confie ce calcul au cerveau principal : 317 multiplié par 29.');
  const replyText = 'Je demande au cerveau principal de faire le calcul. Je te reviens avec le résultat.';
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: row.turnId, replyText });
  await works.guardianSettled(row._id, 'completed', 'answered');
  expect((await works.contextForNative(context(row))).guardianDisposition).toBe('awaiting_main');
  const native = proof(row.attempt, '317 × 29 = 9193.', ['conversation_work']);
  await works.publishNative(row._id, native);
  await works.repo.mutate(row._id, current => ({ fields: { delivery: { ...current.delivery, automaticSpeech: false } }, event: 'fixture_old_policy' }));
  const saved = await works.repo.get(row._id);
  expect(saved).toMatchObject({ classification: 'native_review', guardian: { disposition: 'answered' }, attempt: row.attempt });
  expect((await createWorkDelivery(works).projection(saved)).result).toMatchObject({ text: native.answer.text, automaticSpeech: true });
  await expect(works.contextForNative(context(saved))).rejects.toMatchObject({ statusCode: 404 });
  expect(execute).not.toHaveBeenCalled();
});

test('a pipeline result requires an actual same-run snapshot read, rather than discovery or a personal task read', async () => {
  const row = await admitted('Quels éléments de mon pipeline sont prioritaires ?');
  const runtime = require('../../surfaces/household/native-work-runtime').nativeWorkRuntime({ works, conversations });
  for (const tools of [[], ['tool_search'], ['list_personal_tasks']]) {
    expect(await runtime.receive({ row, evidence: proof(row.attempt, 'Claimed priority.', tools) })).toBeNull();
  }
  expect(await runtime.receive({ row, evidence: proof(row.attempt, 'Verified pipeline priority.', ['agentx__ecosystem_snapshot']) }))
    .toEqual({ published: true });
  expect((await createWorkDelivery(works).projection(await works.repo.get(row._id))).result.automaticSpeech).toBe(true);
});

test('an already accepted review can deliver retained verified tool work without replacing its attempt or replaying speech', async () => {
  const row = await admitted('Quelle information récente apparaît dans cette source ?');
  // An older Core already cached manual playback solely from classification.
  await works.publishNative(row._id, proof(row.attempt, 'Original verified tool answer.', ['ecosystem_snapshot']));
  await works.repo.mutate(row._id, current => ({ fields: { delivery: { ...current.delivery, automaticSpeech: false } }, event: 'fixture_old_manual' }));
  const delivery = createWorkDelivery(works), saved = await works.repo.get(row._id), result = (await delivery.projection(saved)).result;
  expect(result.automaticSpeech).toBe(true); expect(saved.attempt).toEqual(row.attempt);
  const receipt = { resultVersion: 1, deviceSession: randomUUID(), sequence: 1, stage: 'claim' };
  const claim = await delivery.receipt(current.sessionId, result.deliveryId, receipt);
  await delivery.receipt(current.sessionId, result.deliveryId, { ...receipt, sequence: 2, stage: 'started', claimToken: claim.claimToken });
  await delivery.receipt(current.sessionId, result.deliveryId, { ...receipt, sequence: 3, stage: 'completed', claimToken: claim.claimToken });
  await expect(delivery.receipt(current.sessionId, result.deliveryId, { ...receipt, sequence: 4 })).rejects.toMatchObject({ code: 'CONVERSATION_WORK_PRESENTATION_HELD' });
  expect(execute).not.toHaveBeenCalled();
});

test('legacy native conversation results remain retained but require explicit listening; actual task results remain automatic', async () => {
  for (const [text, automaticSpeech] of [['Raconte-moi une histoire.', false], ['Regarde mes tâches.', true]]) {
    const row = await admitted(text);
    await works.repo.mutate(row._id, () => ({ fields: { classification: 'native_work', foreground: null }, event: 'fixture_legacy' }));
    await works.publishNative(row._id, proof(row.attempt, 'Retained exact legacy result.'));
    const saved = await works.repo.get(row._id);
    expect((await createWorkDelivery(works).projection(saved)).result).toMatchObject({ automaticSpeech, text: 'Retained exact legacy result.' });
  }
});

test('the dedicated guardian keeps clear-work acknowledgment bound to the canonical conversation and Main result remains automatic', async () => {
  env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID = 'nestor-guardian';
  try {
    const guardian = jest.fn(() => { throw new Error('An acknowledgment must not invoke a model'); });
    const app = await personalHttp(createConversationExecutor({ env, inference: {}, agentClient: guardian }));
    const turnId = randomUUID();
    const response = await request(app).post(`/sessions/${current.sessionId}/turns/text`).send({ text: 'Regarde mes tâches.', turnId, channel: 'voice', stream: true });
    expect(response.status).toBe(200); expect(response.text).toContain('attend son tour'); expect(guardian).not.toHaveBeenCalled();
    const row = await works.repo.get(hash(current.sessionId + '\n' + turnId));
    expect(row.guardian.agentId).toBe('nestor-guardian'); expect(row.foreground).toBe('acknowledge');
    await works.observer.tick();
    const running = await works.repo.get(row._id);
    expect(running.attempt.agentId).toBe('main');
    // The fixture adapter returned no native observation; publication still
    // requires the exact original run, never a synthetic replacement attempt.
    await works.publishNative(row._id, proof(running.attempt, 'Actual task result.', ['list_personal_tasks']));
    expect((await createWorkDelivery(works).projection(await works.repo.get(row._id))).result.automaticSpeech).toBe(true);
  } finally { delete env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID; }
});

test('opaque turn ids and a repeated client turn id in another conversation cannot share a guardian native session', async () => {
  env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID = 'nestor-guardian';
  try {
    const turnId = 'opaque-client-turn-identity', first = await works.intake(input('Bonjour.', turnId));
    expect(first.row.guardian.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect((await works.intake(input('Bonjour.', turnId))).row.guardian.sessionId).toBe(first.row.guardian.sessionId);
    const another = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
      modeId: 'standard', status: 'active', agentId: 'main', backend: 'openclaw' });
    await expect(works.intake({ session: another, turnId, text: 'Bonjour.' })).rejects.toMatchObject({ statusCode: 409 });
    const second = await works.intake({ session: another, turnId: 'another-opaque-turn-identity', text: 'Bonjour.' });
    expect(second.row.guardian.sessionId).not.toBe(first.row.guardian.sessionId);
    await expect(works.guardianStarted(first.row._id, `agent:nestor-guardian:household:direct:${second.row.guardian.sessionId}`,
      'resp_' + randomUUID(), 'nestor-guardian')).rejects.toMatchObject({ statusCode: 404 });
  } finally { delete env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID; }
});
