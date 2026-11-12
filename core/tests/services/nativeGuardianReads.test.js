'use strict';
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createConversationWorks } = require('../../src/services/conversationWorks/service');
const { registerConversationWorkRoutes } = require('../../src/services/conversationWorks/routes');
const { occupiedMain } = require('../../src/services/conversationWorks/primary-foreground');
const { guardianReadTools } = require('../../surfaces/household/guardian-read-tools');
const Model = require('../../models/ConversationWorkState');
const conversations = forSurface('household');
let works, session, context, relay, owner, env, app, readIss, weather, executing;
const run = () => 'resp_' + randomUUID();
const call = (name = 'math', args = { operation: 'add', a: 2, b: 3 }, callId = 'call-1') => works.guardianRead(context, { name, args }, callId);
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
beforeAll(async () => { await Model.createCollection(); });
beforeEach(async () => {
  await Model.collection.deleteMany({});
  await mongoose.connection.collection('conversation_work_dispatch').deleteMany({});
  env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'worker',
    PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-native-binding-private-token',
    PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'guardian', HOUSEHOLD_GUARDIAN_TOOLS: 'math,weather,iss_passes' };
  executing = true;
  readIss = jest.fn(async () => ({ visiblePasses: [], observer: { lat: 45.1, lon: -73.1, label: 'PRIVATE' }, view: { url: '#private-coordinates' } }));
  weather = jest.fn(async () => ({ fetchedAt: new Date().toISOString(), observedAt: new Date().toISOString(), temperatureC: 4, station: 'PRIVATE' }));
  works = createConversationWorks({ conversations, env, nativePrimary: true,
    guardianReads: () => guardianReadTools(env, { readIss, ambient: { weather } }),
    guardianOccupied: async row => Boolean(await occupiedMain(works.repo, { isExecuting: () => executing }, row.primary.relayFor)) });
  session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
    modeId: 'standard', status: 'active', agentId: 'main', backend: 'openclaw' });
  owner = (await works.intake({ session, turnId: randomUUID(), text: 'Long original work.' })).row;
  const attempt = { id: randomUUID(), agentId: 'main', runId: run(), sessionId: randomUUID() };
  attempt.sessionKey = `agent:main:household:direct:${attempt.sessionId}`;
  owner = await works.repo.mutate(owner._id, () => ({ fields: { state: 'running', attempt }, event: 'fixture_main_started' }));
  await mongoose.connection.collection('conversation_work_dispatch').insertOne({ _id: 'household:personal_operator:personal',
    workId: owner._id, phase: 'dispatching', attempt });
  relay = (await works.intake({ session, turnId: randomUUID(), text: 'Un calcul pendant le travail.' })).row;
  await works.prepare(relay._id, 'PRESERVED_PRIVATE_CONTEXT');
  relay = await works.repo.mutate(relay._id, current => ({ fields: { state: 'received', foreground: 'guardian',
    primary: { ...current.primary, relayFor: { workId: owner._id, attemptId: attempt.id, runId: attempt.runId } } }, event: 'fixture_relay' }));
  context = { agentId: 'guardian', sessionKey: `agent:guardian:household:direct:${relay.guardian.sessionId}`, runId: run() };
  await works.guardianStarted(relay._id, context.sessionKey, context.runId, context.agentId);
  app = express(); app.use(express.json()); registerConversationWorkRoutes(app, { works, env });
});

test('native HTTP keeps exact binding, Core catalogue and math receipts, never owner tools', async () => {
  const post = body => request(app).post('/native/work').set('Authorization', 'Bearer ' + env.PERSONAL_CONVERSATION_WORK_TOKEN).send(body);
  expect((await post({ operation: 'guardian_tools', context })).body.data.definitions.map(value => value.function.name)).toEqual(['iss_passes', 'weather', 'math']);
  const input = { name: 'math', args: { operation: 'add', a: 2, b: 3 } };
  const first = await post({ operation: 'guardian_read', context, callId: 'call|item_1', input });
  expect(first.status).toBe(200);
  expect(first.body.data.receipt).toMatchObject({ tool: 'math', status: 'completed', ...context, callId: 'call|item_1' });
  expect(JSON.parse(first.body.data.result.message.content).result).toBe(5);
  expect((await post({ operation: 'guardian_read', context, callId: 'call|item_1', input })).body.data).toEqual(first.body.data);
  expect((await post({ operation: 'guardian_read', context, callId: 'call|item_1', input: { name: 'math', args: { operation: 'count', to: 2 } } })).status).toBe(409);
  for (const forged of [{ ...context, agentId: 'main' }, { ...context, runId: run() }, { ...context, sessionKey: context.sessionKey + 'x' }, { ...context, owner: 'forged' }]) {
    expect((await post({ operation: 'guardian_read', context: forged, input, callId: 'forged' })).status).toBe(404);
  }
  expect((await post({ operation: 'tasks', context, callId: 'owner-call', input: {} })).status).not.toBe(200);
  expect((await post({ operation: 'guardian_read', context, callId: 'unknown', input: { name: 'personal_memory', args: {} } })).status).toBe(400);
  expect((await request(app).post('/native/work').send({ operation: 'guardian_tools', context })).status).toBe(404);
});

test('empty or invalid server allowlist exposes nothing and admits no read', async () => {
  for (const policy of ['', 'weather,send_email']) {
    env.HOUSEHOLD_GUARDIAN_TOOLS = policy;
    expect((await works.guardianTools(context)).definitions).toEqual([]);
    await expect(call('weather', {})).rejects.toMatchObject({ statusCode: 403 });
  }
  expect(weather).not.toHaveBeenCalled();
});

test('native ISS/weather reuse bounded family projections without location, URL or provider secrets', async () => {
  for (const name of ['iss_passes', 'weather']) {
    const result = await call(name, {}, name);
    expect(result.receipt.status).toBe('completed');
    expect(result.result.message.content).not.toMatch(/45\.1|73\.1|PRIVATE|private-coordinates/);
    expect((await call(name, {}, name))).toEqual(result);
  }
  expect(readIss).toHaveBeenCalledTimes(1); expect(weather).toHaveBeenCalledTimes(1);
  await expect(call('iss_passes', { lat: 45 }, 'bad-coordinates')).rejects.toMatchObject({ statusCode: 400 });
});

test('completed and uncertain read identities survive service restart and duplicate calls without another source read', async () => {
  const wait = deferred(); weather.mockImplementation(() => wait.promise);
  const reading = call('weather', {}, 'original');
  for (let tries = 0; tries < 100 && !weather.mock.calls.length; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(weather).toHaveBeenCalledTimes(1);
  const restarted = createConversationWorks({ conversations, env, guardianReads: () => guardianReadTools(env, { ambient: { weather } }), guardianOccupied: async () => true });
  expect((await restarted.guardianRead(context, { name: 'weather', args: {} }, 'original')).receipt.status).toBe('uncertain');
  const replacement = await restarted.guardianRead(context, { name: 'weather', args: {} }, 'replacement');
  expect(replacement).toMatchObject({ reused: true, requestedCallId: 'replacement', receipt: { callId: 'original', status: 'uncertain' } });
  await expect(restarted.guardianRead(context, { name: 'math', args: { operation: 'count', to: 1 } }, 'other-read')).rejects.toMatchObject({ code: 'CONVERSATION_WORK_GUARDIAN_READ_UNCERTAIN' });
  wait.resolve({ fetchedAt: new Date().toISOString(), temperatureC: 5 });
  const result = await reading;
  expect(await restarted.guardianRead(context, { name: 'weather', args: {} }, 'original')).toEqual(result);
  expect(await restarted.guardianRead(context, { name: 'weather', args: {} }, 'replacement')).toMatchObject({ reused: true, receipt: { callId: 'original' } });
  await expect(restarted.guardianRead(context, { name: 'math', args: { operation: 'count', to: 2 } }, 'replacement')).rejects.toMatchObject({ code: 'CONVERSATION_WORK_GUARDIAN_READ_CONFLICT' });
  expect(weather).toHaveBeenCalledTimes(1);
});

test('reused native call aliases remain immutable across restart and their journal is bounded', async () => {
  await call('weather', {}, 'source');
  const alias = await call('weather', {}, 'alias');
  expect(alias).toMatchObject({ reused: true, requestedCallId: 'alias', receipt: { callId: 'source' } });
  const restarted = createConversationWorks({ conversations, env, guardianReads: () => guardianReadTools(env, { ambient: { weather } }), guardianOccupied: async () => true });
  await expect(restarted.guardianRead(context, { name: 'math', args: { operation: 'count', to: 2 } }, 'alias')).rejects.toMatchObject({ code: 'CONVERSATION_WORK_GUARDIAN_READ_CONFLICT' });
  for (let index = 2; index < 16; index++) await call('weather', {}, 'alias-' + index);
  await expect(call('weather', {}, 'overflow')).rejects.toMatchObject({ code: 'CONVERSATION_WORK_GUARDIAN_READ_BUDGET' });
  expect((await works.repo.get(relay._id)).guardian.reads).toHaveLength(16);
  expect(weather).toHaveBeenCalledTimes(1);
});

test.each(['released', 'uncertain', 'cancelled', 'stale gate', 'stopped guardian', 'erased'])('%s refuses a read before any source execution', async condition => {
  if (condition === 'released') executing = false;
  if (condition === 'uncertain') await works.repo.mutate(owner._id, () => ({ fields: { state: 'uncertain' }, event: 'fixture_unknown' }));
  if (condition === 'cancelled') await works.repo.mutate(relay._id, () => ({ fields: { state: 'cancelled' }, event: 'fixture_cancel' }));
  if (condition === 'stale gate') await mongoose.connection.collection('conversation_work_dispatch').updateOne({}, { $set: { 'attempt.id': randomUUID() } });
  if (condition === 'stopped guardian') await works.guardianSettled(relay._id, 'completed', 'answered');
  if (condition === 'erased') await conversations.deleteSession({ sessionId: session.sessionId, packId: 'personal_operator', scopeId: 'personal' });
  await expect(call('weather', {})).rejects.toMatchObject({ statusCode: 404 });
  expect(weather).not.toHaveBeenCalled();
});

test.each(['released', 'cancelled', 'erased'])('%s while reading prevents late publication and replay', async condition => {
  const wait = deferred(); weather.mockImplementation(() => wait.promise);
  const reading = call('weather', {}, 'inflight');
  for (let tries = 0; tries < 100 && !weather.mock.calls.length; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(weather).toHaveBeenCalledTimes(1);
  if (condition === 'released') executing = false;
  if (condition === 'cancelled') await works.repo.mutate(relay._id, () => ({ fields: { state: 'cancelled' }, event: 'fixture_cancel' }));
  if (condition === 'erased') await conversations.deleteSession({ sessionId: session.sessionId, packId: 'personal_operator', scopeId: 'personal' });
  wait.resolve({ temperatureC: 7 });
  await expect(reading).rejects.toMatchObject({ statusCode: 404 });
  expect((await works.repo.get(relay._id))?.tools || []).toHaveLength(0);
  await expect(call('weather', {}, 'inflight')).rejects.toMatchObject({ statusCode: 404 });
  expect(weather).toHaveBeenCalledTimes(1);
});

describe.each(['first response', 'replay'])('late payload retrieval during %s', phase => {
  test.each(['released', 'cancelled', 'erased'])('%s prevents returning copied bytes after the final payload await', async condition => {
    if (phase === 'replay') await call();
    const entered = deferred(), resume = deferred(), read = works.repo.read;
    works.repo.read = async (...args) => { const value = await read(...args); entered.resolve(); await resume.promise; return value; };
    const response = call(); await entered.promise;
    if (condition === 'released') executing = false;
    if (condition === 'cancelled') await works.repo.mutate(relay._id, () => ({ fields: { state: 'cancelled' }, event: 'fixture_cancel' }));
    if (condition === 'erased') await conversations.deleteSession({ sessionId: session.sessionId, packId: 'personal_operator', scopeId: 'personal' });
    resume.resolve();
    await expect(response).rejects.toMatchObject({ statusCode: 404 });
  });
});

test.each(['erased', 'Main returned'])('canonical context revalidates the owner after payload await: %s', async condition => {
  await call();
  const entered = deferred(), resume = deferred(), read = works.repo.read;
  works.repo.read = async (...args) => { const value = await read(...args); entered.resolve(); await resume.promise; return value; };
  const response = works.conversationContext(session.sessionId); await entered.promise;
  if (condition === 'erased') await conversations.deleteSession({ sessionId: session.sessionId, packId: 'personal_operator', scopeId: 'personal' });
  else executing = false;
  resume.resolve();
  if (condition === 'erased') await expect(response).rejects.toMatchObject({ statusCode: 404 });
  else expect((await response).turns.find(value => value.turnId === relay.turnId).guardianReads).toHaveLength(1);
});

test('read budgets and failure receipts are durable, and Main receives the exact retained references', async () => {
  weather.mockRejectedValue(new Error('source unavailable'));
  expect((await call('weather', {}, 'failed')).receipt.status).toBe('failed');
  expect(await call('weather', {}, 'other-native-call')).toMatchObject({ reused: true, requestedCallId: 'other-native-call', receipt: { callId: 'failed', status: 'failed' } });
  expect((await call('weather', {}, 'failed')).receipt.status).toBe('failed');
  expect(weather).toHaveBeenCalledTimes(1);
  for (let count = 1; count <= 5; count++) await call('math', { operation: 'count', to: count }, 'math-' + count);
  await expect(call('math', { operation: 'count', to: 6 }, 'seventh')).rejects.toMatchObject({ code: 'CONVERSATION_WORK_GUARDIAN_READ_BUDGET' });
  const full = await works.conversationContext(session.sessionId), turn = full.turns.find(value => value.turnId === relay.turnId);
  expect(turn.inputText).toBe('Un calcul pendant le travail.');
  expect(turn.guardianReads).toHaveLength(7);
  expect(turn.guardianReads[0]).toMatchObject({ ...context, callId: 'failed', status: 'failed' });
  expect(turn.guardianReads[1]).toMatchObject({ callId: 'other-native-call', status: 'reference', originalReceiptId: turn.guardianReads[0].id });
  const read = turn.guardianReads[2];
  const evidence = await works.readEvidence({ agentId: 'main', sessionKey: owner.attempt.sessionKey, runId: owner.attempt.runId }, { ref: read.data.$evidence.ref });
  expect(JSON.parse(evidence.data.message.content).result).toEqual([1]);
  const foreign = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal', modeId: 'standard', status: 'active', backend: 'openclaw' });
  expect((await works.conversationContext(foreign.sessionId)).turns).toEqual([]);
});
