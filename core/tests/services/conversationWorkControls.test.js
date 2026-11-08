'use strict';

const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createConversationWorks } = require('../../src/services/conversationWorks/service');
const { createWorkControl } = require('../../src/services/conversationWorks/control');
const { createWorkDelivery } = require('../../src/services/conversationWorks/delivery');
const { createWorkObserver } = require('../../src/services/conversationWorks/observer');
const { registerConversationWorkRoutes } = require('../../src/services/conversationWorks/routes');
const Model = require('../../models/ConversationWorkState');
const { hash, EXCHANGE_SCOPE } = require('../../src/services/conversationWorks/contract');
const conversations = forSurface('household');
const env = { PERSONAL_CONVERSATION_WORK_MODE: 'read', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'nestor-worker',
  PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-private-work-binding-token' };
let works, session, row, control;
const command = (action = 'pause', basis = row, extra = {}) => ({ version: 2, action, workId: basis._id,
  revision: basis.revision, requestSha256: basis.requestSha256, requestId: randomUUID(), ...extra });

beforeEach(async () => {
  await Model.collection.deleteMany({});
  await mongoose.connection.collection('conversation_exchange_receipts').deleteMany({ scope: EXCHANGE_SCOPE });
  await mongoose.connection.collection('conversation_work_dispatch').deleteMany({});
  session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
    modeId: 'standard', status: 'active', agentId: 'main', backend: 'openclaw', turnCount: 0 });
  works = createConversationWorks({ conversations, env, classify: () => true });
  row = (await works.intake({ session, turnId: randomUUID(), text: 'Read my personal tasks.' })).row;
  await works.prepare(row._id, 'Synthetic context');
  row = await works.repo.get(row._id);
  control = createWorkControl(works);
});

test('an exact command replay recovers its original receipt after a lost reply', async () => {
  const input = command();
  const receipt = await control(session.sessionId, row._id, input);
  expect(await control(session.sessionId, row._id, input)).toEqual(receipt);
  const saved = await works.repo.get(row._id);
  expect(saved.controlReceipts).toHaveLength(1);
  expect(saved.revision).toBe(row.revision + 1);
  // Later state changes cannot replace the original acknowledgment.
  await control(session.sessionId, row._id, command('resume', saved));
  const restarted = createWorkControl(createConversationWorks({ conversations, env }));
  expect(await restarted(session.sessionId, row._id, input)).toEqual(receipt);
  const snapshot = await createWorkDelivery(works).snapshot(session.sessionId);
  expect(snapshot.items[0]).toMatchObject({ state: 'queued', controlReceipts: [receipt.commandReceipt, expect.any(Object)] });
  expect(JSON.stringify(snapshot)).not.toContain('fingerprint');
});

test('the server refuses a command when its canonical request is unavailable', async () => {
  const unavailable = createConversationWorks({ conversations: { ...conversations, getTurn: async () => null }, env, repository: works.repo });
  await expect(createWorkControl(unavailable)(session.sessionId, row._id, command('cancel')))
    .rejects.toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_REQUEST_UNAVAILABLE' });
  expect((await works.repo.get(row._id)).state).toBe('queued');
});

test('a replaced request disables projected controls and cannot authorize cancellation', async () => {
  const replaced = createConversationWorks({ conversations: { ...conversations, getTurn: async () => ({ inputText: 'Other intent' }) }, env, repository: works.repo });
  const snapshot = await createWorkDelivery(replaced).snapshot(session.sessionId);
  expect(snapshot.items[0]).toMatchObject({ requestText: null, controlBasis: null, controllable: false });
  await expect(createWorkControl(replaced)(session.sessionId, row._id, command('cancel')))
    .rejects.toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_REQUEST_UNAVAILABLE' });
});

test('rejects an old, unrelated or modified confirmation without changing the current work', async () => {
  const input = command();
  await expect(control(session.sessionId, row._id, { ...input, revision: row.revision - 1 }))
    .rejects.toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_STALE' });
  await expect(control(session.sessionId, row._id, { ...input, requestSha256: hash('different intent') }))
    .rejects.toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_REQUEST_UNAVAILABLE' });
  await expect(control(session.sessionId, row._id, { ...input, workId: hash('foreign work') }))
    .rejects.toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_INVALID' });
  await expect(control(randomUUID(), row._id, input)).rejects.toMatchObject({ statusCode: 404 });
  await control(session.sessionId, row._id, input);
  for (const change of [{ action: 'cancel' }, { revision: row.revision + 1 }, { requestSha256: hash('amended intent') }]) {
    await expect(control(session.sessionId, row._id, { ...input, ...change })).rejects.toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_CONFLICT' });
  }
  expect((await works.repo.get(row._id)).state).toBe('paused');
});

test('concurrent copies accept one control and retain one original receipt', async () => {
  const input = command('cancel');
  const results = await Promise.all([control(session.sessionId, row._id, input), control(session.sessionId, row._id, input)]);
  expect(results[0]).toEqual(results[1]);
  expect((await works.repo.get(row._id)).controlReceipts).toHaveLength(1);
  expect((await works.repo.get(row._id)).events.filter(event => event.type === 'owner_cancel')).toHaveLength(1);
});

test.each(['running', 'uncertain', 'failed', 'completed'])('a %s native attempt cannot be cancelled or relaunched by control', async state => {
  row = await works.repo.mutate(row._id, () => ({ fields: { state, attempt: { id: randomUUID(), runId: 'resp_' + randomUUID() },
    reason: 'native_receipt_required' }, event: 'synthetic_native_admission' }));
  await expect(control(session.sessionId, row._id, command('cancel'))).rejects.toMatchObject({ code: 'CONVERSATION_WORK_ALREADY_DISPATCHED' });
  const saved = await works.repo.get(row._id);
  expect(saved).toMatchObject({ state, attempt: row.attempt, reason: 'native_receipt_required' });
  expect(saved.controlReceipts || []).toEqual([]);
});

test('the bounded journal retains old receipts and reserves its last slot for cancellation', async () => {
  row = await works.repo.mutate(row._id, () => ({ fields: { controlReceipts: Array.from({ length: 63 }, () => ({ requestId: randomUUID() })) }, event: 'synthetic_control_budget' }));
  await expect(control(session.sessionId, row._id, command())).rejects.toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_LIMIT' });
  await control(session.sessionId, row._id, command('cancel'));
  expect((await works.repo.get(row._id)).controlReceipts).toHaveLength(64);
});

test('HTTP exposes the exact receipt and safely refuses old clients, foreign work and declared approval', async () => {
  const app = express(); app.use(express.json()); registerConversationWorkRoutes(app, { works, env });
  const url = `/private/sessions/${session.sessionId}/work/${row._id}/control`;
  const input = command();
  const old = await request(app).post(url).send({ action: 'pause', revision: row.revision });
  expect(old.status).toBe(400);
  expect(old.body).toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_INVALID', message: expect.stringContaining('Refresh') });
  expect((await request(app).post(url).set('x-service-caller', 'owner').send({ ...input, approved: true })).status).toBe(400);
  const accepted = await request(app).post(url).send(input);
  expect(accepted.status).toBe(200);
  expect(accepted.body.data.commandReceipt).toMatchObject({ version: 2, requestId: input.requestId,
    workId: row._id, requestSha256: row.requestSha256, action: 'pause', baseRevision: row.revision, state: 'paused' });
  const restarted = express(); restarted.use(express.json());
  registerConversationWorkRoutes(restarted, { works: createConversationWorks({ conversations, env }), env });
  expect((await request(restarted).post(url).send(input)).body).toEqual(accepted.body);
  expect((await request(restarted).post(url).send({ ...input, action: 'cancel' })).status).toBe(409);
  const snapshot = await request(restarted).get(`/private/sessions/${session.sessionId}/work`);
  expect(snapshot.body.data.items[0].controlReceipts).toEqual([accepted.body.data.commandReceipt]);
  expect((await request(restarted).post(url.replace(row._id, hash('foreign-work'))).send(input)).status).toBe(400);
  expect((await request(restarted).post(url.replace(session.sessionId, randomUUID())).send(input)).status).toBe(404);
});

test('a cancellation received before admission prevents native dispatch and retains the original request', async () => {
  const input = command('cancel'), original = { requestSha256: row.requestSha256, contextRef: row.contextRef, exchangeId: row.exchangeId };
  const saved = await control(session.sessionId, row._id, input);
  const execute = jest.fn(), observer = createWorkObserver({ works, env, execute, observe: async () => null });
  try { await observer.tick(); await observer.tick(); } finally { observer.stop(); }
  expect(execute).not.toHaveBeenCalled();
  expect(await works.repo.get(row._id)).toMatchObject({ ...original, state: 'cancelled', controlReceipts: [expect.objectContaining(saved.commandReceipt)] });
  expect(await works.requestTextForDisplay(await works.repo.get(row._id))).toBe('Read my personal tasks.');
  expect(await works.repo.read(row, row.contextRef)).toEqual({ selectedContext: 'Synthetic context' });
});

test('admission wins its race with cancellation and an uncertain attempt is never replaced', async () => {
  const input = command('cancel');
  let release, prepared;
  const preparation = new Promise(resolve => { prepared = resolve; });
  const execute = jest.fn(async () => { throw Error('synthetic lost native response'); });
  const observer = createWorkObserver({ works, env, execute, observe: async () => null,
    prepare: async () => { prepared(); await new Promise(resolve => { release = resolve; }); return {}; } });
  const ticking = observer.tick();
  try {
    await preparation;
    await expect(control(session.sessionId, row._id, input)).rejects.toMatchObject({ code: 'CONVERSATION_WORK_CONTROL_STALE' });
    const admitted = await works.repo.get(row._id);
    expect(admitted.attempt.id).toBeDefined();
    await expect(control(session.sessionId, row._id, command('cancel', admitted)))
      .rejects.toMatchObject({ code: 'CONVERSATION_WORK_ALREADY_DISPATCHED' });
    release(); await ticking; await observer.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await works.repo.get(row._id)).toMatchObject({ state: 'uncertain', attempt: { id: admitted.attempt.id } });
  } finally { release?.(); await ticking; observer.stop(); }
});

test('erasure removes command receipts and refuses their late replay', async () => {
  const input = command('cancel');
  await control(session.sessionId, row._id, input);
  await conversations.deleteSession({ sessionId: session.sessionId, packId: 'personal_operator', scopeId: 'personal' });
  expect(await works.repo.get(row._id)).toBeNull();
  const tombstone = await works.repo.getIncludingErased(row._id);
  expect(tombstone).toMatchObject({ erased: true });
  expect(tombstone.controlReceipts).toBeUndefined();
  await expect(control(session.sessionId, row._id, input)).rejects.toMatchObject({ statusCode: 404 });
});
