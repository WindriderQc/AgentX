'use strict';
const express = require('express');
const { randomUUID } = require('node:crypto');
const Conversation = require('../../models/Conversation');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createService } = require('../../src/services/images/expertService');
const { createRouter } = require('../../routes/image-expert');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
let service, harness, bridge;
beforeAll(async () => {
  bridge = { configured: () => true, invoke: jest.fn() };
  service = createService({ bridge });
  const app = express(); app.use('/expert', createRouter(service));
  harness = await startTestHttpHarness(app, { transport: 'tcp', maxSockets: 4 });
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => { await Conversation.deleteMany({}); jest.clearAllMocks(); });

test('canonical unknown inspection fence survives the recent-turn window in the real route without private internals or writes', async () => {
  const native = forSurface('image-workshop'), session = await service.createSession();
  const scope = { sessionId: session.sessionId, packId: 'atelier', scopeId: 'workspace' };
  const fence = { state: 'unknown', requestId: randomUUID(), turnId: randomUUID(), sessionKey: 'private-native-session-key',
    references: [{ private: 'not-public' }], startedAt: '2026-01-01T00:00:00Z' };
  await native.recordTurn({ ...scope, traceId: fence.turnId, modeId: 'plan', outcome: 'unknown', inputText: 'Old fixture inspection',
    replyText: '', toolEvidence: { imagex: { inspection: fence } } });
  await native.updateSession(scope, { $set: { imageInspection: fence } });
  for (let index = 0; index < 51; index++) await native.recordTurn({ ...scope, traceId: randomUUID(), modeId: 'consult',
    outcome: 'completed', inputText: `Text-only fixture ${index}`, replyText: 'Recorded text-only answer' });
  const before = await Conversation.collection.findOne({ 'surfaceSession.sessionId': session.sessionId });
  const turns = await service.turns(session.sessionId);
  expect(Array.isArray(turns)).toBe(true); expect(turns).toHaveLength(50);
  expect(turns.some(turn => turn.id === fence.turnId)).toBe(false);
  const expected = { state: 'unknown', requestId: fence.requestId, turnId: fence.turnId };
  expect(await service.inspectionFence(session.sessionId)).toEqual(expected);
  const response = await harness.request.get(`/expert/sessions/${session.sessionId}/turns`).expect(200);
  expect(response.body.inspectionFence).toEqual(expected);
  expect(response.body.turns).toHaveLength(50);
  expect(JSON.stringify(response.body)).not.toMatch(/private-native|not-public|startedAt|sessionKey/);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(await Conversation.collection.findOne({ _id: before._id })).toEqual(before);
  expect(bridge.invoke).not.toHaveBeenCalled();
});

test('an exact visible session without a fence returns null while foreign namespaces and unknown IDs refuse', async () => {
  const session = await service.createSession();
  expect(await service.turns(session.sessionId)).toEqual([]);
  expect(await service.inspectionFence(session.sessionId)).toBeNull();
  const response = await harness.request.get(`/expert/sessions/${session.sessionId}/turns`).expect(200);
  expect(response.body).toEqual({ ok: true, turns: [], inspectionFence: null });
  for (const [surface, packId, scopeId] of [['image-workshop', 'private', 'private'], ['psyx', 'atelier', 'workspace']]) {
    const foreign = await forSurface(surface).createSession({ sessionId: randomUUID(), modeId: 'imagex', packId, scopeId });
    await expect(service.inspectionFence(foreign.sessionId)).rejects.toMatchObject({ statusCode: 404 });
    await harness.request.get(`/expert/sessions/${foreign.sessionId}/turns`).expect(404);
  }
  await expect(service.inspectionFence(randomUUID())).rejects.toMatchObject({ statusCode: 404 });
  await expect(service.inspectionFence('invalid')).rejects.toMatchObject({ statusCode: 400 });
  expect(bridge.invoke).not.toHaveBeenCalled();
});

test('fence disclosure keeps unknown stored states blocking and never exposes malformed identities', async () => {
  const session = await service.createSession(), native = forSurface('image-workshop');
  await native.updateSession({ sessionId: session.sessionId, packId: 'atelier', scopeId: 'workspace' },
    { $set: { imageInspection: { state: 'future-state', requestId: '/private/path', turnId: 'x'.repeat(20000), sessionKey: 'private' } } });
  expect(await service.inspectionFence(session.sessionId)).toEqual({ state: 'unknown' });
});
