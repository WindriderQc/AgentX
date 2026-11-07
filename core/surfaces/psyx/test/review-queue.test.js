'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewer } = require('../src/reviewer');
const { createHarness } = require('./support/state');
const { replyTarget, nextReplyNote, NOTE_LIMIT, CRITERIA, supervisionNote } = require('../../../src/domains/psyx/supervision');

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await tick(); }
  assert.fail('review did not reach the expected state');
}
function syntheticReply(target) {
  return { content: JSON.stringify({ digest: { summary: 'Digest ' + target.replyId },
    supervision: { replyId: target.replyId, replyHash: target.replyHash,
      observations: Object.fromEntries(CRITERIA.map(key => [key, { status: 'uncertain', reason: 'Contexte synthétique.' }])) } }) };
}
function setup({ complete, delayMs = 0, repository = null } = {}) {
  const stored = repository || createHarness().repository;
  const messages = [], calls = [];
  let exists = true;
  function append(id, { enrolled = true, epoch = null } = {}) {
    const ordinal = messages.length + 2;
    const control = { mode: 'talk', voice: false, ...(enrolled === null ? {} : { reviewRequested: enrolled, reviewEpoch: epoch }) };
    messages.push({ role: 'user', content: 'Contexte synthétique ' + id, ordinal: ordinal - 1 },
      { role: 'assistant', id, ordinal, content: 'Réponse synthétique ' + id + '?', control });
  }
  const conversationRepository = {
    context: async (_u, _c, limit, options) => !exists ? null : options?.withCoverage
      ? { messages: messages.slice(-limit), availableMessages: messages.length } : messages.slice(-limit),
    listSessionMetadata: async user => exists && user === 'u' ? [{ id: 'c', lifecycle: { status: 'active' } }] : []
  };
  const options = { config: { review: { delayMs } }, stateRepository: stored, conversationRepository, logger: {},
    provider: { complete: async request => {
      const target = JSON.parse(request.messages[1].content.split('\n')[1]).supervisionTarget;
      calls.push({ target, request });
      return complete ? complete(target, calls.length) : syntheticReply(target);
    } }
  };
  return { options, repository: stored, messages, calls, append, remove: () => { exists = false; } };
}
async function drain(reviewer) {
  await until(() => ['done', 'failed', 'uncertain'].includes(reviewer.status('u', 'c').status));
}

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
  const reviewer = createReviewer(h.options);
  h.repository.dreamUserIds = async () => ['u'];
  await reviewer.scan();
  assert.equal(h.calls.length, 0);
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
  reviewer.stop();
  const restarted = createReviewer(h.options);
  restarted.schedule('u', 'c');
  await drain(restarted);
  assert.deepEqual(h.calls.map(call => call.target.replyId), ['a', 'a', 'b']);
  assert.equal((await h.repository.read('u')).reviewProgress.c.active, null);
  assert.equal((await h.repository.read('u')).supervisionNotes.length, 2);
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
