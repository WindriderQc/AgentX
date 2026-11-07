'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewer } = require('../src/reviewer');
const { createHarness } = require('./support/state');
const { setup, until, drain, syntheticReply } = require('./support/review');
const { replyTarget, supervisionNote } = require('../../../src/domains/psyx/supervision');

function outputFor(h, target) {
  return { digest: null, proposals: [], supervision: supervisionNote(
    JSON.parse(syntheticReply(target).content).supervision,
    { target, reply: h.messages.at(-1).content, promptVersion: 3 }) };
}

test('a stale attempt cannot overwrite a newer dispatch sharing the same logical request', async () => {
  const h = setup();
  h.append('a');
  const target = replyTarget('c', h.messages);
  const first = (await h.repository.claimReview('u', { target })).work;
  await h.repository.saveReviewResult('u', { work: first, error: 'PROVEN_REFUSAL', retryAt: new Date(0).toISOString() });
  const second = (await h.repository.claimReview('u', { target })).work;
  assert.equal(first.requestId, second.requestId);
  assert.equal(second.error, null, 'the previous refusal is not evidence about this new attempt');
  assert.equal(second.retryAt, null);
  const stale = await h.repository.saveReviewResult('u', { work: first, error: 'OLD_REFUSAL', retryAt: new Date(0).toISOString() });
  assert.ok(stale.skipped, 'a delayed old refusal must not reopen the dispatch fence');
  const active = (await h.repository.read('u')).reviewProgress.c.active;
  assert.equal(active.phase, 'dispatched');
  assert.notEqual(active.dispatchAttempt, first.dispatchAttempt);
  assert.equal((await h.repository.saveReviewResult('u', { work: first, output: outputFor(h, target) })).skipped, 'gone');
  const ready = (await h.repository.saveReviewResult('u', { work: second, output: outputFor(h, target) })).work;
  assert.equal((await h.repository.recordReview('u', { conversationId: 'c', ...ready.output, receipt: first })).skipped, 'receipt');
  assert.equal((await h.repository.recordReview('u', { conversationId: 'c', ...ready.output, receipt: ready })).skipped, undefined);
});

test('a preference change during projection is revalidated after the state revision conflict', async () => {
  const harness = createHarness();
  const h = setup({ repository: harness.repository });
  h.append('a');
  let settings = { revision: 1, values: { backgroundReview: true, reviewDelaySeconds: 0 } };
  h.options.preferencesFor = async () => structuredClone(settings);
  const record = h.repository.recordReview;
  let changed = false;
  h.repository.recordReview = (userId, input) => record(userId, { ...input, stillWanted: async () => {
    if (!changed) {
      changed = true;
      settings = { revision: 2, values: { ...settings.values, backgroundReview: false } };
      // The preference route increments the PsyX state revision after saving.
      await harness.collection.updateOne({ userId }, { $inc: { revision: 1 } });
    }
    return input.stillWanted();
  } });
  const reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await until(async () => (await h.repository.read('u')).reviewProgress.c?.throughOrdinal === 2);
  const state = await h.repository.read('u');
  assert.equal(h.calls.length, 1);
  assert.equal(state.supervisionNotes[0].modelReview.status, 'discarded');
  assert.deepEqual(state.sessionDigests, []);
  assert.deepEqual(state.proposals, []);
  reviewer.stop();
});

test('startup reconciles orphaned supervision after transcript deletion interrupted domain cleanup', async () => {
  const h = setup({ complete: async () => { throw new Error('Synthetic lost result'); } });
  h.append('a');
  const reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await drain(reviewer);
  reviewer.stop();
  assert.ok((await h.repository.read('u')).reviewProgress.c.active);
  h.remove(); // canonical deletion succeeded; the process died before forgetConversation
  h.repository.dreamUserIds = async () => ['u'];
  h.options.conversationRepository.getSession = async () => null;
  const restarted = createReviewer(h.options);
  await restarted.scan();
  assert.deepEqual((await h.repository.read('u')).reviewProgress, {});
  assert.equal(h.calls.length, 1);
  restarted.stop();
});

test('a new claim identity cannot reopen an uncertain native dispatch', async () => {
  const h = setup();
  h.append('a');
  const target = replyTarget('c', h.messages);
  const work = (await h.repository.claimReview('u', { target })).work;
  await h.repository.saveReviewResult('u', { work, error: 'SYNTHETIC_UNKNOWN' });
  const claim = await h.repository.claimReview('u', { target });
  assert.equal(claim.skipped, 'active');
  assert.equal(claim.work.requestId, work.requestId);
  assert.equal(claim.work.dispatchAttempt, work.dispatchAttempt);
  assert.equal(claim.work.phase, 'uncertain');
});

test('lost result or projection acknowledgements recover without a second model call', async () => {
  for (const boundary of ['result', 'projection']) {
    const harness = createHarness();
    const h = setup({ repository: harness.repository });
    h.append('a');
    const write = harness.collection.updateOne.bind(harness.collection);
    let injected = false;
    harness.collection.updateOne = async (filter, update, options) => {
      const active = update.$set?.reviewProgress?.c?.active;
      const matches = boundary === 'result' ? active?.phase === 'result_ready'
        : Boolean(update.$set?.supervisionNotes);
      const result = await write(filter, update, options);
      if (matches && !injected) {
        injected = true;
        throw Object.assign(new Error('Synthetic acknowledgement loss'), { code: 'SYNTHETIC_ACK_LOST' });
      }
      return result;
    };
    let reviewer = createReviewer(h.options);
    reviewer.schedule('u', 'c');
    await drain(reviewer);
    assert.equal(injected, true);
    assert.equal(h.calls.length, 1);
    reviewer.stop();
    h.repository.dreamUserIds = async () => ['u'];
    reviewer = createReviewer(h.options);
    await reviewer.scan();
    await until(async () => (await h.repository.read('u')).reviewProgress.c?.throughOrdinal === 2);
    const state = await h.repository.read('u');
    assert.equal(h.calls.length, 1);
    assert.equal(state.supervisionNotes.length, 1);
    assert.equal(state.reviewProgress.c.active, null);
    reviewer.stop();
  }
});

test('a partial metadata listing and archived sessions cannot authorize orphan cleanup', async () => {
  const h = setup();
  h.append('a');
  await h.repository.claimReview('u', { target: replyTarget('c', h.messages) });
  h.repository.dreamUserIds = async () => ['u'];
  h.options.conversationRepository.listSessionMetadata = async () => [];
  h.options.conversationRepository.getSession = async (_user, id) => ({ id, lifecycle: { status: 'archived' } });
  const reviewer = createReviewer(h.options);
  await reviewer.scan();
  assert.ok((await h.repository.read('u')).reviewProgress.c.active);
  assert.equal(h.calls.length, 0);
  h.options.conversationRepository.getSession = async () => undefined;
  await reviewer.scan();
  assert.ok((await h.repository.read('u')).reviewProgress.c.active, 'an unavailable lookup is not proof of absence');
  reviewer.stop();
});

test('orphan cleanup retries after a storage failure even with review inference disabled', async () => {
  const h = setup();
  h.append('a');
  const target = replyTarget('c', h.messages);
  const work = (await h.repository.claimReview('u', { target })).work;
  const output = outputFor(h, target);
  await h.repository.saveReviewResult('u', { work, output });
  await h.repository.recordReview('u', { conversationId: 'c', ...output, receipt: work });
  h.remove();
  h.repository.dreamUserIds = async () => ['u'];
  h.options.preferencesFor = async () => ({ revision: 2, values: { backgroundReview: false } });
  h.options.conversationRepository.getSession = async () => null;
  const forget = h.repository.forgetConversation;
  let failed = false;
  h.repository.forgetConversation = async (...args) => {
    if (!failed) { failed = true; throw new Error('Synthetic cleanup storage failure'); }
    return forget(...args);
  };
  const reviewer = createReviewer(h.options);
  await assert.rejects(reviewer.scan(), /Synthetic cleanup storage failure/);
  assert.equal((await h.repository.read('u')).supervisionNotes.length, 1);
  await reviewer.scan();
  const state = await h.repository.read('u');
  assert.deepEqual(state.reviewProgress, {});
  assert.deepEqual(state.supervisionNotes, []);
  assert.equal(h.calls.length, 0);
  reviewer.stop();
});
