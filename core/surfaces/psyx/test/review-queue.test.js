'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewer } = require('../src/reviewer');
const { createHarness } = require('./support/state');
const { replyTarget, nextReplyNote, NOTE_LIMIT, CRITERIA, supervisionNote } = require('../../../src/domains/psyx/supervision');

const { setup, until, drain, syntheticReply } = require('./support/review');

test('three replies before the delay each receive exactly one critique in transcript order', async () => {
  const h = setup({ delayMs: 25 });
  const reviewer = createReviewer(h.options);
  h.append('a'); reviewer.schedule('u', 'c');
  h.append('b'); reviewer.schedule('u', 'c');
  h.append('c'); reviewer.schedule('u', 'c');
  assert.equal(h.calls.length, 0);
  await drain(reviewer);
  assert.deepEqual(h.calls.map(call => call.target.replyId), ['a', 'b', 'c']);
  assert.deepEqual((await h.repository.read('u')).supervisionNotes.map(note => note.replyId), ['a', 'b', 'c']);
  const report = await reviewer.inspect('u', 'c');
  assert.equal(report.coverage.eligibleReplies, 3);
  assert.equal(report.coverage.settledReviewAttempts, 3);
  assert.equal(report.coverage.retainedModelCritiques, 3);
  assert.equal(report.coverage.pendingReplies, 0);
  reviewer.stop();
});

test('a late critique stays on its earlier reply and never supplies the later reply context', async () => {
  const releases = [];
  const h = setup({ complete: async target => {
    await new Promise(resolve => releases.push(resolve));
    return syntheticReply(target);
  } });
  const reviewer = createReviewer(h.options);
  h.append('a'); reviewer.schedule('u', 'c');
  await until(() => releases.length === 1);
  h.append('b'); reviewer.schedule('u', 'c');
  releases[0]();
  await until(() => releases.length === 2);
  let state = await h.repository.read('u');
  assert.deepEqual(state.supervisionNotes.map(note => note.replyId), ['a']);
  assert.equal(nextReplyNote(state, 'c', h.messages), null);
  assert.equal(state.sessionDigests.length, 0, 'an earlier snapshot cannot replace the latest session review');
  releases[1]();
  await drain(reviewer);
  state = await h.repository.read('u');
  assert.equal(nextReplyNote(state, 'c', h.messages).replyId, 'b');
  assert.equal(state.sessionDigests[0].summary, 'Digest b');
  reviewer.stop();
});

test('startup excludes legacy and disabled replies, then resumes only explicitly enrolled current work', async () => {
  const h = setup();
  for (let i = 0; i < 80; i++) h.append('legacy-' + i, { enrolled: null });
  h.append('disabled', { enrolled: false });
  const oldTarget = replyTarget('c', h.messages.slice(0, 2));
  await h.repository.recordReview('u', { conversationId: 'c', supervision: supervisionNote(
    JSON.parse(syntheticReply(oldTarget).content).supervision,
    { target: oldTarget, reply: h.messages[1].content, promptVersion: 3 }) });
  const reviewer = createReviewer(h.options);
  h.repository.dreamUserIds = async () => ['u'];
  await reviewer.scan();
  assert.equal(h.calls.length, 0);
  assert.equal((await reviewer.inspect('u', 'c')).coverage.retainedModelCritiques, 0);
  h.append('current');
  await reviewer.scan();
  await drain(reviewer);
  assert.deepEqual(h.calls.map(call => call.target.replyId), ['current']);
  const context = JSON.parse(h.calls[0].request.messages[1].content.split('\n')[1]);
  assert.equal(context.conversationCoverage.includedMessages, 40);
  assert.equal(context.conversationCoverage.availableMessages, 164);
  assert.equal(context.conversationCoverage.complete, false);
  const report = await reviewer.inspect('u', 'c');
  assert.equal(report.coverage.eligibleReplies, 1);
  assert.equal(report.coverage.excludedReplies, 81);
  assert.equal(report.coverage.retainedModelCritiques, 1);
  assert.equal((await h.repository.read('u')).supervisionSummary.replies, 2, 'the retained note window stays distinct from enrollment coverage');
  reviewer.stop();
  const restarted = createReviewer(h.options);
  await restarted.scan();
  assert.equal(h.calls.length, 1, 'a settled reply never replays at startup');
  restarted.stop();
});

test('a saved result resumes projection after interruption without another model call', async () => {
  const h = setup();
  h.append('a');
  const target = replyTarget('c', h.messages);
  const claim = await h.repository.claimReview('u', { target });
  const note = supervisionNote(JSON.parse(syntheticReply(target).content).supervision, {
    target, reply: h.messages.at(-1).content, promptVersion: 3
  });
  await h.repository.saveReviewResult('u', { work: claim.work, output: { supervision: note, digest: null, proposals: [] } });
  const restarted = createReviewer(h.options);
  restarted.schedule('u', 'c');
  await drain(restarted);
  assert.equal(h.calls.length, 0);
  const state = await h.repository.read('u');
  assert.equal(state.supervisionNotes.length, 1);
  assert.equal(state.reviewProgress.c.throughOrdinal, 2);
  assert.equal(state.reviewProgress.c.active, null);
  restarted.stop();
});

test('an uncertain dispatch survives restart, stays visible and blocks replay instead of inventing coverage', async () => {
  const h = setup();
  h.append('a'); h.append('b');
  const target = replyTarget('c', h.messages.slice(0, 2));
  const claim = await h.repository.claimReview('u', { target });
  const restarted = createReviewer(h.options);
  restarted.schedule('u', 'c');
  await drain(restarted);
  let report = await restarted.inspect('u', 'c');
  assert.equal(report.status, 'uncertain');
  assert.equal(report.requestId, claim.work.requestId);
  assert.equal(report.coverage.pendingReplies, 2);
  assert.equal(report.coverage.settledReviewAttempts, 0);
  assert.equal(report.coverage.retainedModelCritiques, 0);
  assert.equal(h.calls.length, 0);
  restarted.schedule('u', 'c');
  await drain(restarted);
  assert.equal(h.calls.length, 0);
  restarted.stop();
});

test('transport failure retains one dispatch identity; arriving turns do not cause retries', async () => {
  const h = setup({ complete: async () => { throw Object.assign(new Error('Synthetic lost response'), { code: 'SYNTHETIC_UNKNOWN' }); } });
  h.append('a');
  let reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await drain(reviewer);
  const work = (await h.repository.read('u')).reviewProgress.c.active;
  assert.equal(work.phase, 'uncertain');
  h.append('b');
  reviewer.stop();
  reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await drain(reviewer);
  assert.equal(h.calls.length, 1);
  assert.equal((await reviewer.inspect('u', 'c')).requestId, work.requestId);
  reviewer.stop();
});

test('reset and permanent deletion fence an in-flight critique and do not revive historical work', async () => {
  for (const operation of ['reset', 'delete']) {
    let release;
    const h = setup({ complete: async target => { await new Promise(resolve => { release = resolve; }); return syntheticReply(target); } });
    h.append('a');
    const reviewer = createReviewer(h.options);
    reviewer.schedule('u', 'c');
    await until(() => Boolean(release));
    if (operation === 'reset') await h.repository.reset('u');
    else { h.remove(); await h.repository.forgetConversation('u', 'c'); }
    release();
    await drain(reviewer);
    const state = await h.repository.read('u');
    assert.deepEqual(state.supervisionNotes, []);
    assert.deepEqual(state.reviewProgress, {});
    reviewer.schedule('u', 'c'); await drain(reviewer);
    assert.equal(h.calls.length, 1);
    reviewer.stop();
  }
});

test('the compact cursor prevents replay even after every earlier note leaves the bounded window', async () => {
  const h = setup();
  for (let i = 0; i < NOTE_LIMIT + 2; i++) h.append('r-' + i);
  let reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await drain(reviewer);
  const state = await h.repository.read('u');
  assert.equal(h.calls.length, NOTE_LIMIT + 2);
  assert.equal(state.supervisionNotes.length, NOTE_LIMIT);
  assert.equal(state.supervisionSummary.replies, NOTE_LIMIT);
  assert.equal(state.reviewProgress.c.throughOrdinal, (NOTE_LIMIT + 2) * 2);
  assert.equal(state.reviewProgress.c.active, null);
  reviewer.stop();
  reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c'); await drain(reviewer);
  assert.equal(h.calls.length, NOTE_LIMIT + 2);
  assert.equal((await reviewer.inspect('u', 'c')).coverage.settledReviewAttempts, NOTE_LIMIT + 2);
  reviewer.stop();
});

test('a proven pre-dispatch refusal defers the same target and identity without losing a later reply', async () => {
  const h = setup({ complete: async (target, call) => {
    if (call === 1) throw Object.assign(new Error('Synthetic proven refusal'), {
      code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', reviewNotDispatched: true
    });
    return syntheticReply(target);
  } });
  h.append('a'); h.append('b');
  const reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await until(async () => (await h.repository.read('u')).reviewProgress.c?.active?.phase === 'waiting');
  const requestId = (await h.repository.read('u')).reviewProgress.c.active.requestId;
  const claim = h.repository.claimReview;
  const resumedIds = [];
  h.repository.claimReview = async (...args) => { const result = await claim(...args); if (result.work) resumedIds.push(result.work.requestId); return result; };
  assert.equal((await reviewer.inspect('u', 'c')).status, 'queued');
  assert.equal((await reviewer.inspect('u', 'c')).error, 'RUNTIME_INFERENCE_ADMISSION_DENIED');
  reviewer.stop();
  const restarted = createReviewer(h.options);
  restarted.schedule('u', 'c');
  await drain(restarted);
  assert.deepEqual(h.calls.map(call => call.target.replyId), ['a', 'a', 'b']);
  assert.equal((await h.repository.read('u')).reviewProgress.c.active, null);
  assert.equal((await h.repository.read('u')).supervisionNotes.length, 2);
  assert.equal(h.calls[0].request.requestId, requestId);
  assert.equal(h.calls[1].request.requestId, requestId);
  assert.notEqual(h.calls[2].request.requestId, requestId);
  assert.equal(resumedIds[0], requestId);
  assert.notEqual(resumedIds[1], requestId);
  restarted.stop();
});

test('separate resets at the same instant still fence stale enrollment and dispatch', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const h = setup();
  h.append('a');
  const first = await h.repository.reset('u');
  const second = await h.repository.reset('u');
  assert.equal(first.resetAt, second.resetAt);
  assert.notEqual(first.reviewEpoch, second.reviewEpoch);
  const stale = await h.repository.claimReview('u', { target: replyTarget('c', h.messages), resetAt: first.resetAt, epoch: first.reviewEpoch });
  assert.equal(stale.skipped, 'reset');
  assert.deepEqual((await h.repository.read('u')).reviewProgress, {});
  t.mock.timers.reset();
});

test('disabling review during the durable claim cannot launch inference and later resumes the same request', async () => {
  const h = setup();
  h.append('a');
  let preferences = { revision: 1, values: { backgroundReview: true, reviewDelaySeconds: 0 } };
  h.options.preferencesFor = async () => structuredClone(preferences);
  const claimReview = h.repository.claimReview;
  let release, claimed;
  h.repository.claimReview = async (...args) => {
    const result = await claimReview(...args);
    if (!claimed) { claimed = result.work; await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await until(() => Boolean(release));
  preferences = { revision: 2, values: { ...preferences.values, backgroundReview: false } };
  reviewer.forgetUser('u');
  release();
  await until(async () => (await h.repository.read('u')).reviewProgress.c.active.phase === 'waiting');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.repository.read('u')).reviewProgress.c.active.requestId, claimed.requestId);
  preferences = { revision: 3, values: { ...preferences.values, backgroundReview: true } };
  reviewer.forgetUser('u');
  reviewer.schedule('u', 'c');
  await drain(reviewer);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.requestId, claimed.requestId);
  reviewer.stop();
});

test('reset while the durable claim is settling prevents the old generation from dispatching', async () => {
  const h = setup();
  h.append('a');
  const claimReview = h.repository.claimReview;
  let release;
  h.repository.claimReview = async (...args) => {
    const result = await claimReview(...args);
    await new Promise(resolve => { release = resolve; });
    return result;
  };
  const reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await until(() => Boolean(release));
  await h.repository.reset('u');
  release();
  await drain(reviewer);
  assert.equal(h.calls.length, 0);
  assert.deepEqual((await h.repository.read('u')).reviewProgress, {});
  reviewer.stop();
});
