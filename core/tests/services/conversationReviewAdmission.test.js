'use strict';

const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createConversationWorks } = require('../../src/services/conversationWorks/service');
const { createWorkObserver } = require('../../src/services/conversationWorks/observer');
const { selectQueuedWork, REVIEW_IDLE_MS, REVIEW_MAX_WAIT_MS } = require('../../src/services/conversationWorks/admission');
const { OWNER, EXCHANGE_SCOPE, NO_WORK } = require('../../src/services/conversationWorks/contract');
const Model = require('../../models/ConversationWorkState');

const conversations = forSurface('household');
const env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'review-worker',
  PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-review-admission-binding-token' };
let works, session, clock, base, sent, evidence;
const gate = () => mongoose.connection.collection('conversation_work_dispatch');
const input = text => ({ session, turnId: randomUUID(), text });
const nativeProof = (attempt, text) => ({ ok: true, authority: 'openclaw.nestor', operation: 'turn',
  sessionKey: attempt.sessionKey, runId: attempt.runId,
  run: { sessionKey: attempt.sessionKey, runId: attempt.runId, status: 'completed' },
  answer: { status: 'ready', runId: attempt.runId, text }, receipts: [], progress: [],
  toolChecks: { status: 'observed', runId: attempt.runId, completedTools: [], loop: null } });

beforeAll(async () => { await Model.createCollection(); await Model.createIndexes(); });
beforeEach(async () => {
  await Model.collection.deleteMany({});
  await mongoose.connection.collection('conversation_exchange_receipts').deleteMany({ scope: EXCHANGE_SCOPE });
  await gate().deleteMany({});
  base = Date.now() + 10000; clock = base; sent = []; evidence = new Map();
  session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
    modeId: 'standard', status: 'active', agentId: 'main', backend: 'openclaw', turnCount: 0 });
  works = createConversationWorks({ conversations, env, nativeForeground: text => text !== 'Bonjour.',
    now: () => new Date(clock) });
});

async function accept(text = 'Bonjour.', { settle = true, disposition = 'answered', state = 'completed' } = {}) {
  const accepted = await works.intake(input(text));
  await works.prepare(accepted.row._id, 'Complete selected context retained.');
  if (settle) {
    await conversations.settleTurn({ ...works.query(session.sessionId), traceId: accepted.row.turnId,
      replyText: state === 'completed' ? 'Canonical guardian reply.' : '', outcome: state });
    await works.guardianSettled(accepted.row._id, state, disposition);
  }
  // Only the disposable fixture's receipt clock changes; no timer, inference,
  // native transport or production collection participates in these tests.
  const row = await works.repo.get(accepted.row._id);
  await Model.collection.updateOne({ _id: row._id }, { $set: {
    events: row.events.map(event => ({ ...event, at: new Date(clock) })) } });
  return works.repo.get(row._id);
}

function observer() {
  return createWorkObserver({ works, env, now: () => clock, agentFor: () => 'main',
    execute: async ({ row, onStarted, ...prepared }) => {
      const runId = 'resp_' + randomUUID();
      await onStarted(row.attempt.sessionKey, runId);
      const current = await works.repo.get(row._id);
      const proof = nativeProof(current.attempt, row.classification === 'native_review' ? NO_WORK : 'The original completed answer.');
      await works.publishNative(row._id, proof); evidence.set(runId, proof);
      sent.push({ id: row._id, attemptId: row.attempt.id, selectedContext: prepared.selectedContext });
    }, observe: async attempt => evidence.get(attempt.runId) });
}

test('an answered review waits for quiet without taking a native owner, then its original runs exactly once', async () => {
  const review = await accept(); const saved = await works.repo.get(review._id);
  const first = observer();
  try {
    await first.tick(); clock = base + REVIEW_IDLE_MS - 1; await first.tick();
    expect(sent).toEqual([]); expect(await gate().findOne({ _id: OWNER })).toBeNull();
    expect(await works.repo.get(review._id)).toEqual(saved);
    clock++; await first.tick(); await first.tick();
    expect(sent.map(r => r.id)).toEqual([review._id]);
    expect(sent[0].selectedContext).toBe('Complete selected context retained.');
    expect((await works.repo.get(review._id))).toMatchObject({ state: 'completed', result: { kind: 'no_work' } });
  } finally { first.stop(); }
});

test('new conversation activity restarts quiet but never resets the original maximum deferral', async () => {
  const review = await accept(); clock = base + REVIEW_IDLE_MS - 1;
  const later = await accept();
  const first = observer();
  try {
    clock = base + REVIEW_IDLE_MS; await first.tick(); expect(sent).toEqual([]);
    clock = base + 2 * REVIEW_IDLE_MS - 1; await first.tick();
    expect(sent.map(r => r.id)).toEqual([review._id]);
    await first.tick(); expect(sent.map(r => r.id)).toEqual([review._id, later._id]);
  } finally { first.stop(); }
});

test('an awaited follow-up runs during the review grace with the original complete review still accepted', async () => {
  const review = await accept(); clock = base + 5000;
  const awaited = await accept('Compare the two options.');
  const first = observer();
  try {
    await first.tick(); expect(sent.map(r => r.id)).toEqual([awaited._id]);
    expect(await works.repo.get(review._id)).toMatchObject({ state: 'queued', contextRef: review.contextRef });
    expect((await works.repo.get(review._id)).attempt).toBeUndefined();
    clock += REVIEW_IDLE_MS; await first.tick(); await first.tick();
    expect(sent.map(r => r.id)).toEqual([awaited._id, review._id]);
    expect(new Set(sent.map(r => r.attemptId)).size).toBe(2);
    const shared = await works.conversationContext(session.sessionId);
    expect(shared.coverage).toMatchObject({ complete: true, turnCount: 2, workResultCount: 1 });
    expect(shared.turns.find(r => r.turnId === awaited.turnId).workResults[0].text).toBe('The original completed answer.');
  } finally { first.stop(); }
});

test('continuous new turns cannot postpone the oldest answered review beyond its eligibility cap', async () => {
  const review = await accept();
  for (let offset = REVIEW_IDLE_MS - 1; offset < REVIEW_MAX_WAIT_MS; offset += REVIEW_IDLE_MS - 1) {
    clock = base + offset; await accept();
    expect(await selectQueuedWork(works.repo, { now: clock })).toBeNull();
  }
  clock = base + REVIEW_MAX_WAIT_MS - 1;
  expect(await selectQueuedWork(works.repo, { now: clock })).toBeNull();
  clock++;
  expect((await selectQueuedWork(works.repo, { now: clock }))._id).toBe(review._id);
});

test('late or repeated guardian settlement cannot move the original acceptance-age cap', async () => {
  const review = await accept('Bonjour.', { settle: false });
  clock = base + REVIEW_MAX_WAIT_MS - 1000;
  await conversations.settleTurn({ ...works.query(session.sessionId), traceId: review.turnId, replyText: 'Bonjour !' });
  await works.guardianSettled(review._id, 'completed', 'answered');
  // A received reply close to the cap would otherwise restart the full grace.
  const late = await works.repo.get(review._id);
  await Model.collection.updateOne({ _id: review._id }, { $set: {
    events: late.events.map(event => ({ ...event, at: new Date(clock) })) } });
  expect(await selectQueuedWork(works.repo, { now: clock })).toBeNull();
  await works.guardianSettled(review._id, 'completed', 'answered');
  clock = base + REVIEW_MAX_WAIT_MS;
  expect((await selectQueuedWork(works.repo, { now: clock }))._id).toBe(review._id);
  expect((await works.repo.get(review._id)).receivedAt).toEqual(review.receivedAt);
});

test('overdue reviews alternate with continuously awaited work and keep FIFO through observer restart', async () => {
  const reviews = [await accept()]; clock++; reviews.push(await accept());
  clock = base + REVIEW_MAX_WAIT_MS + 1;
  const awaited = [await accept('Compare the two options.')]; clock++; awaited.push(await accept('Explain the options.'));
  let first = observer();
  try {
    await first.tick(); expect(sent.map(r => r.id)).toEqual([reviews[0]._id]);
    expect((await gate().findOne({ _id: OWNER })).lastClassification).toBe('native_review');
    first.stop(); first = observer();
    await first.tick(); await first.tick(); await first.tick();
    expect(sent.map(r => r.id)).toEqual([reviews[0]._id, awaited[0]._id, reviews[1]._id, awaited[1]._id]);
    expect(new Set(sent.map(r => r.attemptId)).size).toBe(4);
    for (const row of [...reviews, ...awaited]) expect((await works.repo.get(row._id)).state).toBe('completed');
  } finally { first.stop(); }
});

test('a retained uncertain native attempt is never replaced even when both queue classes are overdue', async () => {
  const original = await accept();
  const attempt = { id: randomUUID(), sessionId: randomUUID(), agentId: 'main', runId: 'resp_' + randomUUID() };
  attempt.sessionKey = `agent:main:household:direct:${attempt.sessionId}`;
  await works.repo.mutate(original._id, () => ({ fields: { state: 'uncertain', attempt }, event: 'fixture_uncertain' }));
  await gate().insertOne({ _id: OWNER, workId: original._id, phase: 'dispatching', attempt, lastClassification: 'native_review' });
  const review = await accept(); const awaited = await accept('Compare the two options.');
  clock += REVIEW_MAX_WAIT_MS + 1;
  const first = observer();
  try {
    await first.tick(); await first.tick(); expect(sent).toEqual([]);
    expect((await works.repo.get(original._id)).attempt).toEqual(attempt);
    expect((await gate().findOne({ _id: OWNER })).workId).toBe(original._id);
    for (const row of [review, awaited]) expect((await works.repo.get(row._id)).state).toBe('queued');
  } finally { first.stop(); }
});

test.each(['cancelled', 'failed'])('a guardian settled %s is not treated as an answered ordinary review', async state => {
  const row = await accept('Bonjour.', { state, disposition: undefined });
  expect((await selectQueuedWork(works.repo, { now: clock }))._id).toBe(row._id);
});

test('explicit Main handoff bypasses quiet and a duplicate intake cannot replace a deferred review', async () => {
  const review = await accept(); clock += 1000;
  const again = await works.intake({ session, turnId: review.turnId, text: 'Bonjour.' });
  expect(again.duplicate).toBe(true); expect(again.row._id).toBe(review._id);
  expect(again.row.receivedAt).toEqual(review.receivedAt);
  const handoff = await accept('Bonjour.', { disposition: 'awaiting_main' });
  expect(handoff.classification).toBe('native_work');
  expect((await selectQueuedWork(works.repo, { now: clock }))._id).toBe(handoff._id);
});

test('a pending foreground and resumed observer do not admit a young answered review early', async () => {
  const review = await accept(); clock += 1000; await accept('Bonjour.', { settle: false });
  clock = base + REVIEW_IDLE_MS + 1000;
  const first = observer();
  try {
    await first.tick(); expect(sent).toEqual([]);
    first.stop(); const restarted = observer();
    try {
      await restarted.tick(); expect(sent).toEqual([]);
      clock = base + REVIEW_MAX_WAIT_MS; await restarted.tick();
      expect(sent.map(r => r.id)).toEqual([review._id]);
    } finally { restarted.stop(); }
  } finally { first.stop(); }
});
