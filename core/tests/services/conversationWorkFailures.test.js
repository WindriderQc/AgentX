'use strict';
const mongoose = require('mongoose');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { forSurface } = require('../../src/services/surfaceConversationService');
const capability = require('../../src/services/conversationWorks/capability');
const { registerWorkRuntime } = require('../../surfaces/household/conversation-work-runtime');
const { createAgentClient } = require('../../surfaces/household/conversation-agent');
const { createWorkDelivery } = require('../../src/services/conversationWorks/delivery');
const { OWNER, EXCHANGE_SCOPE } = require('../../src/services/conversationWorks/contract');
const Model = require('../../models/ConversationWorkState');
const conversations = forSurface('household');
const env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'nestor-worker',
  PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-native-failure-binding-token',
  OPENCLAW_GATEWAY_URL: 'http://synthetic.invalid', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' };
let works, current, fetchImpl, nativeEvidence;
const row = value => Buffer.from('data: ' + JSON.stringify(value) + '\n\n');
beforeAll(async () => { await Model.createCollection(); await Model.createIndexes(); });
beforeEach(async () => {
  await Model.collection.deleteMany({});
  await mongoose.connection.collection('conversation_exchange_receipts').deleteMany({ scope: EXCHANGE_SCOPE });
  await mongoose.connection.collection('conversation_work_dispatch').deleteMany({});
  current = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
    modeId: 'standard', status: 'active', agentId: 'main', backend: 'openclaw', turnCount: 0 });
  nativeEvidence = new Map();
  fetchImpl = jest.fn(async () => {
    const runId = 'resp_' + randomUUID();
    return { ok: true, body: [row({ type: 'response.created', response: { id: runId } }),
      row({ type: 'response.failed', response: { id: runId,
        error: { message: 'Provider synthetic has auth issue (skipping all models): PRIVATE_DIAGNOSTIC' } } })] };
  });
  const continuity = async req => req.operation === 'agents'
    ? { capabilities: { isolatedWork: true, nativeReadBudget: true, nativeConversation: true } }
    : { ok: true, authority: 'openclaw.nestor', operation: req.operation, sessionKey: req.sessionKey, runId: req.runId,
      run: null, ...nativeEvidence.get(req.runId) };
  works = registerWorkRuntime({ router: express.Router(), conversations, tasks: {}, env, capability, continuity,
    screenPages: require('../../surfaces/household/screen-services').createScreenServices({ env: {} }),
    agentClient: createAgentClient({ env, fetchImpl, continuity, settleMs: 0 }) });
});
afterEach(() => works.observer.stop());
async function accept(text = 'Show AgentX analytics.') {
  const accepted = await works.intake({ session: current, turnId: randomUUID(), text });
  await works.prepare(accepted.row._id, '');
  await works.guardianSettled(accepted.row._id, 'completed');
  return accepted.row;
}
const failure = attempt => ({ source: 'openclaw/responses', sessionKey: attempt.sessionKey, runId: attempt.runId,
  event: 'response.failed', reason: 'native_authentication_failed' });
async function occupied(saved, receipt) {
  const attempt = { id: randomUUID(), sessionId: randomUUID(), agentId: 'main', runId: 'resp_' + randomUUID() };
  attempt.sessionKey = `agent:main:household:direct:${attempt.sessionId}`;
  if (receipt) attempt.failureReceipt = receipt(attempt);
  await works.repo.mutate(saved._id, () => ({ fields: { state: 'uncertain', attempt }, event: 'fixture_dispatch_uncertain' }));
  await mongoose.connection.collection('conversation_work_dispatch').insertOne({ _id: OWNER, workId: saved._id,
    attempt, processId: randomUUID(), phase: 'dispatching' });
  return attempt;
}

test('native auth failure before agent_end persists its terminal receipt and does not strand later page requests', async () => {
  const first = await accept(), next = await accept();
  await works.observer.tick();
  const failed = await works.repo.get(first._id);
  expect(failed).toMatchObject({ state: 'failed', reason: 'native_authentication_failed', attempt: {
    terminal: 'failed', settledAt: expect.any(Date), failureReceipt: { source: 'openclaw/responses', event: 'response.failed' } } });
  expect(failed.attempt.failureReceipt.runId).toBe(failed.attempt.runId);
  expect((await works.repo.dispatchOwner()).workId).toBeNull();
  expect(JSON.stringify(failed)).not.toContain('PRIVATE_DIAGNOSTIC');
  expect((await createWorkDelivery(works).snapshot(current.sessionId)).items.find(item => item.id === first._id))
    .toMatchObject({ state: 'failed', pending: false, reason: 'native_authentication_failed' });
  await works.observer.tick();
  expect(fetchImpl).toHaveBeenCalledTimes(2); // one dispatch per accepted request, no replacement
  expect((await works.repo.get(next._id)).state).toBe('failed');
});

test('restart reconciles the saved original Responses failure without another native launch', async () => {
  const saved = await accept(); await occupied(saved, failure);
  await works.observer.tick();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect((await works.repo.get(saved._id)).state).toBe('failed');
  expect((await works.repo.dispatchOwner()).workId).toBeNull();
});

test('after a failed turn the next page request can complete and projects its actual display', async () => {
  await accept(); await works.observer.tick();
  const next = await accept();
  fetchImpl.mockImplementationOnce(async (_url, request) => {
    const runId = 'resp_' + randomUUID(), sessionKey = request.headers['x-openclaw-session-key'];
    nativeEvidence.set(runId, { run: { runId, sessionKey, status: 'completed' },
      answer: { runId, status: 'ready', text: 'Voici la page. <show kind="page">analytics</show>' },
      toolChecks: { status: 'observed', runId, completedTools: [], loop: null }, receipts: [], progress: [] });
    return { ok: true, body: ['response.created', 'response.completed'].map(type => row({ type, response: { id: runId } })) };
  });
  await works.observer.tick();
  const snapshot = await createWorkDelivery(works).snapshot(current.sessionId);
  const completed = snapshot.items.find(item => item.id === next._id);
  expect(completed).toMatchObject({ state: 'completed', pending: false, result: { display: [
    { kind: 'page', body: 'analytics' }] } });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test.each([undefined, attempt => ({ ...failure(attempt), runId: 'resp_' + randomUUID() }),
  attempt => ({ ...failure(attempt), sessionKey: 'foreign' }), attempt => ({ ...failure(attempt), source: 'model' })])(
  'missing or foreign terminal evidence keeps the original dispatch held', async receipt => {
    const saved = await accept(); await occupied(saved, receipt);
    const next = await accept('Is the coding team working?');
    await works.observer.tick(); await works.observer.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await works.repo.get(saved._id)).state).toBe('uncertain');
    expect((await works.repo.dispatchOwner()).workId).toBe(saved._id);
    expect(await works.nativeAcceptance(next._id)).toMatchObject({ blocked: true, state: 'queued' });
    expect(await createWorkDelivery(works).snapshot(current.sessionId, 999999))
      .toMatchObject({ items: [], dispatch: { state: 'blocked', reason: 'native_receipt_unverified' } });
  });

test('engineering activity bypasses unverified guardian answers and requests native Pipeline evidence', async () => {
  const saved = await accept('Is the coding team working?');
  expect(saved).toMatchObject({ classification: 'native_work', foreground: 'acknowledge' });
  await works.observer.tick();
  const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(JSON.stringify(body.input)).toContain('ecosystem_snapshot');
  const directive = body.input[0].content.find(part => part.text?.includes('For this current pipeline read')).text;
  expect(directive).toContain('"mode":"pipeline"');
});
