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

test('a guardian handoff returns Main’s page and speaks its saved answer once through browser receipts', async () => {
  const text = 'Et cette page ?', turnId = randomUUID();
  const accepted = await works.intake({ session: current, turnId, text });
  expect(accepted.row.classification).toBe('native_review');
  await works.prepare(accepted.row._id, '');
  await conversations.settleTurn({ ...works.query(current.sessionId), traceId: turnId,
    replyText: 'Je vais te présenter la page demandée.', outcome: 'completed' });
  await works.guardianSettled(accepted.row._id, 'completed', 'awaiting_main');
  fetchImpl.mockImplementationOnce(async (_url, request) => {
    const runId = 'resp_' + randomUUID(), sessionKey = request.headers['x-openclaw-session-key'];
    nativeEvidence.set(runId, { run: { runId, sessionKey, status: 'completed' },
      answer: { runId, status: 'ready', text: 'Voici la page. <show kind="page">analytics</show>' },
      toolChecks: { status: 'observed', runId, completedTools: [], loop: null }, receipts: [], progress: [] });
    return { ok: true, body: ['response.created', 'response.completed'].map(type => row({ type, response: { id: runId } })) };
  });
  await works.observer.tick();
  const saved = await works.repo.get(accepted.row._id), delivery = createWorkDelivery(works);
  expect(saved).toMatchObject({ state: 'completed', classification: 'native_work', delivery: { automaticSpeech: true } });
  expect((await delivery.snapshot(current.sessionId)).items[0].requestText).toBe(text);
  class Element {
    constructor() { this.children = []; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute() {}
    remove() {}
    querySelector(selector) { return this.children.find(node => '.' + node.className === selector); }
  }
  const priorDocument = global.document, shown = [], stages = [];
  let resolvePlayback, rejectPlayback, timeout;
  const playback = new Promise((resolve, reject) => { resolvePlayback = resolve; rejectPlayback = reject; });
  const interject = jest.fn(async ({ text: spoken }, { onScheduled }) => {
    expect(spoken).toBe('Voici la page.'); onScheduled(); return true;
  });
  global.document = { createElement: () => new Element() };
  const feed = require('../../surfaces/household/public/conversation-work').create({ host: new Element(), base: '/sessions',
    pollMs: 60000, getConversation: () => ({ session: { sessionId: current.sessionId }, state: 'listening', interject }),
    onShow: block => shown.push(block),
    api: async (url, options) => {
      if (options?.method !== 'POST') return delivery.snapshot(current.sessionId, new URL(url, 'http://fixture').searchParams.get('cursor'));
      const body = JSON.parse(options.body); stages.push(body.stage);
      const result = await delivery.receipt(current.sessionId, saved.delivery.id, body);
      if (body.stage === 'completed') resolvePlayback();
      return result;
    } });
  try {
    timeout = setTimeout(() => rejectPlayback(Error('Saved Main result was not presented')), 5000);
    feed.follow(current.sessionId); await playback; await feed.poll(); await feed.naturalPause();
    expect(shown).toEqual([expect.objectContaining({ kind: 'page', body: 'analytics' })]);
    expect(stages).toEqual(['displayed', 'claim', 'started', 'completed']);
    expect(interject).toHaveBeenCalledTimes(1);
    expect((await works.repo.get(saved._id)).delivery.state).toBe('completed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally { clearTimeout(timeout); feed.dispose(); global.document = priorDocument; }
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
    const guardianContext = await works.guardianContext(current.sessionId);
    expect(guardianContext).toContain('"blocked":true');
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

test('an older uncertain dispatch settles from its exact persisted native failure without a replacement', async () => {
  const first = await accept(), next = await accept();
  const attempt = await occupied(first);
  const terminal = { runId: attempt.runId, sessionKey: attempt.sessionKey, status: 'failed',
    source: 'openclaw/sessions.get', messageId: 'native-terminal-marker', model: null, provider: null };
  for (const run of [{ ...terminal, runId: 'resp_' + randomUUID() }, { ...terminal, sessionKey: 'foreign-session' }]) {
    nativeEvidence.set(attempt.runId, { run });
    await works.observer.tick();
    expect((await works.repo.dispatchOwner()).workId).toBe(first._id);
    expect((await works.repo.get(first._id)).state).toBe('uncertain');
    expect(fetchImpl).not.toHaveBeenCalled();
  }
  nativeEvidence.set(attempt.runId, { run: terminal,
    answer: { status: 'unavailable', source: 'openclaw/sessions.get', runId: attempt.runId } });
  await works.observer.tick();
  const settled = await works.repo.get(first._id);
  expect(settled).toMatchObject({ state: 'failed', attempt: { id: attempt.id,
    runId: attempt.runId, terminal: 'failed', settledAt: expect.any(Date) } });
  expect((await works.repo.dispatchOwner()).workId).toBeNull();
  expect((await works.repo.get(next._id)).state).toBe('queued');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect((await createWorkDelivery(works).snapshot(current.sessionId)).items.find(item => item.id === first._id))
    .toMatchObject({ state: 'failed', pending: false });
});

async function holdAcceptedExchange(saved) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const held = require('../../src/services/conversations/writeFence').withOwnerWrite('exchange:' + saved.exchangeId,
    async () => { enter(); await blocked; });
  await entered;
  return { release: async () => { release(); await held; } };
}
async function retainedFailedRequest() {
  const saved = await accept('Synthetic previous failed request.');
  await works.repo.mutate(saved._id, () => ({ fields: { state: 'failed', reason: 'synthetic_native_failure' }, event: 'fixture_terminal' }));
  return saved;
}

test('an unrelated retained exchange writer cannot starve an already accepted ready request', async () => {
  const previous = await retainedFailedRequest(), next = await accept();
  const held = await holdAcceptedExchange(previous);
  const fences = mongoose.connection.collection('conversation_write_fences');
  const before = await fences.findOne({ _id: 'exchange:' + previous.exchangeId });
  try {
    await works.observer.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await works.repo.get(next._id)).state).toBe('failed');
    expect((await works.repo.get(previous._id)).reason).toBe('synthetic_native_failure');
    expect(await fences.findOne({ _id: before._id })).toEqual(before);
    expect(await mongoose.connection.collection('conversation_exchange_receipts').findOne({ _id: previous.exchangeId }))
      .toMatchObject({ state: 'accepted' });
  } finally { await held.release(); }
});

test('an unrelated retained exchange writer cannot prevent reconciliation of the original native failure', async () => {
  const previous = await retainedFailedRequest(), original = await accept();
  const attempt = await occupied(original, failure), held = await holdAcceptedExchange(previous);
  try {
    await works.observer.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await works.repo.get(original._id)).toMatchObject({ state: 'failed', attempt: { id: attempt.id,
      runId: attempt.runId, terminal: 'failed' } });
    expect((await works.repo.dispatchOwner()).workId).toBeNull();
  } finally { await held.release(); }
});

test.each(['CONVERSATION_WRITE_BUSY', 'CONVERSATION_WRITE_RECOVERY_REQUIRED'])(
  'idle recovery backs off %s and resumes after successful recovery', async code => {
    let clock = 0;
    const recover = jest.spyOn(works, 'recover').mockRejectedValue(Object.assign(new Error('Retained synthetic writer'), { code }));
    const logger = { warn: jest.fn() };
    const observer = require('../../src/services/conversationWorks/observer').createWorkObserver({
      works, env, execute: jest.fn(), observe: async () => null, logger, now: () => clock });
    try {
      await observer.tick(); await observer.tick();
      expect(recover).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      clock = 30000; await observer.tick(); await observer.tick();
      expect(recover).toHaveBeenCalledTimes(2);
      clock = 60000; await observer.tick();
      expect(recover).toHaveBeenCalledTimes(2); // second interval is 60 seconds
      recover.mockResolvedValue(); clock = 90000; await observer.tick();
      expect(recover).toHaveBeenCalledTimes(3);
      clock = 90001; await observer.tick();
      expect(recover).toHaveBeenCalledTimes(4); // successful recovery resumes ordinary observation
    } finally { observer.stop(); recover.mockRestore(); }
  });
