'use strict';

// The Household reviewer keeps its latest result on the canonical conversation (#20).
// Synthetic conversations on the disposable test database; no model is called.
const { randomUUID } = require('node:crypto');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createBrain } = require('../../surfaces/household/brain');

const conversations = forSurface('household');
const REVIEW = JSON.stringify({ suggestions: ['Et la suite?'], corrections: ['Une araignée a huit pattes.'], revisions: [],
  interjection: { text: 'Huit pattes, en fait.', urgent: false } });
const PRIVATE = { packId: 'personal_operator', scopeId: 'personal' }, FAMILY = { packId: 'kidx_nestor', scopeId: 'family' };

async function conversation(space = PRIVATE) {
  const session = await conversations.createSession({ sessionId: randomUUID(), ...space, modeId: 'standard', status: 'active', turnCount: 0 });
  const traceId = randomUUID();
  await conversations.recordTurn({ ...space, sessionId: session.sessionId, traceId, inputText: 'Combien de pattes?', replyText: 'Six.' });
  return { session: await conversations.getSession({ sessionId: session.sessionId }), traceId };
}

const exactTurns = ({ sessionId, packId, scopeId }) => conversations.readTurns({ sessionId, packId, scopeId });
function brainWith({ gate = null, prefs = { revision: 1, values: { backgroundReview: true, reviewDelaySeconds: 0 } }, loadTurns = exactTurns } = {}) {
  const calls = [];
  const brain = createBrain({ conversations, env: {}, preferencesFor: async () => structuredClone(prefs),
    loadTurns,
    inference: { execute: async body => { calls.push(body); if (gate) await gate; return { ok: true, body: { message: { content: REVIEW } } }; } } });
  return { brain, calls };
}

test('a stored review survives a restart and informs the next turn', async () => {
  const { session, traceId } = await conversation();
  const first = brainWith().brain;
  first.schedule({ session, pack: {}, traceId });
  const delivered = await first.wait(session.sessionId, traceId);
  const reloaded = await conversations.getSession({ sessionId: session.sessionId });
  expect(reloaded.backgroundReview.review).toMatchObject({ adviceId: delivered.adviceId, traceId, space: 'private', preferencesRevision: 1, depth: 'standard' });

  const restarted = brainWith().brain;
  const advice = await restarted.contextWithRefs(session.sessionId, reloaded);
  expect(advice.text).toMatch(/huit pattes/);
  expect(advice.refs).toEqual([expect.objectContaining({ adviceId: delivered.adviceId, sourceTurnId: traceId })]);
  const served = await restarted.wait(session.sessionId, traceId, { session: reloaded, timeoutMs: 10 });
  expect(served.adviceId).toBe(delivered.adviceId);
  expect(served).not.toHaveProperty('preferencesRevision');
});

test('a review overtaken by a newer recorded turn is neither stored nor delivered', async () => {
  const { session, traceId } = await conversation();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { brain, calls } = brainWith({ gate });
  brain.schedule({ session, pack: {}, traceId });
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 2));
  await conversations.recordTurn({ ...PRIVATE, sessionId: session.sessionId, traceId: randomUUID(), inputText: 'Et une fourmi?', replyText: 'Six.' });
  release();
  expect(await brain.wait(session.sessionId, traceId)).toBeNull();
  expect((await conversations.getSession({ sessionId: session.sessionId })).backgroundReview).toBeUndefined();
});

test('one result and one refusal per conversation; the next result clears the refusal', async () => {
  const { session, traceId } = await conversation();
  const { brain } = brainWith();
  brain.schedule({ session, pack: {}, traceId });
  const first = await brain.wait(session.sessionId, traceId);
  const longTrace = randomUUID();
  await conversations.recordTurn({ ...PRIVATE, sessionId: session.sessionId, traceId: longTrace, inputText: 'x'.repeat(15000), replyText: 'y'.repeat(49000) });
  await conversations.recordTurn({ ...PRIVATE, sessionId: session.sessionId, traceId: randomUUID(), inputText: 'z'.repeat(15000), replyText: 'w'.repeat(49000) });
  brain.schedule({ session, pack: {}, traceId: longTrace });
  expect((await brain.wait(session.sessionId, longTrace)).status).toBe('context_required');
  let stored = (await conversations.getSession({ sessionId: session.sessionId })).backgroundReview;
  expect(stored.review.adviceId).toBe(first.adviceId);
  expect(stored.refusal).toMatchObject({ status: 'context_required', traceId: longTrace });
  const restarted = brainWith().brain;
  expect((await restarted.contextWithRefs(session.sessionId, await conversations.getSession({ sessionId: session.sessionId }))).text)
    .toMatch(/does not validate newer turns/);
  // A later complete review of the same conversation (a smaller selection is simulated) replaces both.
  const later = brainWith({ loadTurns: async query => (await exactTurns(query)).slice(0, 1) }).brain;
  later.schedule({ session, pack: {}, traceId });
  const replaced = await later.wait(session.sessionId, traceId);
  stored = (await conversations.getSession({ sessionId: session.sessionId })).backgroundReview;
  expect(Object.keys(stored)).toEqual(['review']);
  expect(stored.review.adviceId).toBe(replaced.adviceId);
});

test('a settings change voids a stored review after a restart', async () => {
  const { session, traceId } = await conversation();
  const first = brainWith().brain;
  first.schedule({ session, pack: {}, traceId });
  await first.wait(session.sessionId, traceId);
  const reloaded = await conversations.getSession({ sessionId: session.sessionId });
  const changed = brainWith({ prefs: { revision: 2, values: { backgroundReview: true, reviewDelaySeconds: 0 } } }).brain;
  expect(await changed.contextWithRefs(session.sessionId, reloaded)).toEqual({ text: '', refs: [] });
  expect(await changed.wait(session.sessionId, traceId, { session: reloaded, timeoutMs: 10 })).toBeNull();
});

test('family reviews stay on the family conversation, standard depth, and never reach a private one', async () => {
  const family = await conversation(FAMILY), personal = await conversation();
  const { brain, calls } = brainWith({ prefs: { revision: 1, values: { backgroundReview: true, deepReview: true, reviewDelaySeconds: 0 } } });
  brain.schedule({ session: family.session, pack: { childSafe: true }, traceId: family.traceId });
  await brain.wait(family.session.sessionId, family.traceId);
  expect(calls[0].think).toBe(false);
  const familyRecord = (await conversations.getSession({ sessionId: family.session.sessionId })).backgroundReview.review;
  expect(familyRecord).toMatchObject({ space: 'family', depth: 'standard', conversationCoverage: { complete: false } });
  expect((await conversations.getSession({ sessionId: personal.session.sessionId })).backgroundReview).toBeUndefined();
  const restarted = brainWith().brain;
  expect((await restarted.contextWithRefs(personal.session.sessionId, await conversations.getSession({ sessionId: personal.session.sessionId }))).text).toBe('');
});

test('a forgotten conversation is not reviewed and its stored review is erased', async () => {
  const { session, traceId } = await conversation();
  const { brain, calls } = brainWith();
  brain.schedule({ session, pack: {}, traceId });
  await brain.wait(session.sessionId, traceId);
  await conversations.deleteSession({ sessionId: session.sessionId, ...PRIVATE });
  expect(await conversations.getSession({ sessionId: session.sessionId })).toBeNull();
  brain.cancel(session.sessionId);
  brain.schedule({ session, pack: {}, traceId: randomUUID() });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(calls).toHaveLength(1);
  const raw = await require('../../models/Conversation').findOne({ 'surfaceSession.sessionId': session.sessionId }).lean();
  expect(raw?.surfaceSession?.backgroundReview).toBeUndefined();
});
