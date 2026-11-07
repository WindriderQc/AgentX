'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewer } = require('../src/reviewer');
const { emptyState } = require('../../../src/domains/psyx/stateRepository');
const { reviewMessages, REVIEW_PROMPT_VERSION } = require('../../../src/domains/psyx/review');
const { composeSystemContext, normalizeControl } = require('../../../src/domains/psyx/domain');
const { NOTE_LIMIT, CRITERIA, replyTarget, sameTarget, supervisionNote, summarizeNotes, nextReplyNote } = require('../../../src/domains/psyx/supervision');

function turns(id = 'r1', ordinal = 2, content = 'Ça semble pesant. Que ressens-tu?') {
  return [{ role: 'user', content: 'Une journée difficile.' }, {
    role: 'assistant', id, ordinal, content, createdAt: '2026-01-01T12:00:00.000Z',
    control: { mode: 'talk', voice: false, reviewRequested: true }
  }];
}
function critique(target, status = 'uncertain') {
  return { replyId: target.replyId, replyHash: target.replyHash,
    observations: Object.fromEntries(CRITERIA.map(key => [key, { status, reason: 'Observation synthétique.', quote: '' }])),
    adjustment: 'Rester proche du ressenti.' };
}
function note(messages = turns(), raw) {
  const target = replyTarget('c', messages);
  return supervisionNote(raw === undefined ? critique(target) : raw, {
    target, reply: messages.at(-1).content, promptVersion: REVIEW_PROMPT_VERSION,
    coverage: { availableMessages: 2, includedMessages: 2, omittedMessages: 0, complete: true }
  });
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function settled(reviewer, id = 'c') {
  for (let i = 0; i < 200; i++) {
    const status = reviewer.status('u', id);
    if (['done', 'failed', 'uncertain'].includes(status.status)) return status;
    await tick();
  }
  assert.fail('review did not settle');
}
function harness(complete) {
  let messages = turns();
  const { repository } = require('./support/state').createHarness();
  const calls = [], recorded = [];
  const stateRepository = { ...repository, async recordReview(user, review) {
    const result = await repository.recordReview(user, review);
    if (!result.skipped) recorded.push(review);
    return result;
  } };
  const conversationRepository = { async context(_u, _c, limit, options) {
    if (!messages) return null;
    const selected = messages.slice(-limit);
    return options?.withCoverage ? { messages: selected, availableMessages: messages.length } : selected;
  } };
  const provider = { async complete(request) {
    calls.push(request);
    const context = JSON.parse(request.messages[1].content.split('\n')[1]);
    return complete ? complete(context, calls.length) : {
      model: 'synthetic-reviewer', content: JSON.stringify({
        digest: { summary: 'Synthèse.' }, supervision: critique(context.supervisionTarget),
        proposals: [{ kind: 'notes', text: 'Proposition séparée', evidence: ['Une journée difficile.'] }]
      })
    };
  } };
  const options = { config: { review: { delayMs: 0 } }, provider, stateRepository, conversationRepository, logger: {} };
  return { options, stateRepository, calls, recorded, setMessages: value => { messages = value; } };
}

test('identity and code measurements describe the complete exact canonical reply', () => {
  const messages = turns('canonical-id', 22, '  Un mot? Deux mots?  ');
  const target = replyTarget('c', messages);
  assert.equal(target.replyId, 'canonical-id');
  assert.equal(target.replyOrdinal, 22);
  const result = note(messages);
  assert.equal(result.measurements.wordCount, 4);
  assert.equal(result.measurements.questionMarkCount, 2);
  assert.deepEqual(result.measurements.usualWordRange, [60, 180]);
  assert.equal(result.measurements.withinUsualWordRange, false);
  assert.equal(result.modelReview.independent, false);
  assert.equal(sameTarget(target, replyTarget('c', turns('canonical-id', 22, '  Un mot? Deux mots?'))), false, 'whitespace and the full tail are part of the hash');
  assert.equal(replyTarget('c', [{ role: 'user', id: 'u', ordinal: 1, content: 'x' }]), null);
  assert.equal(replyTarget('c', [{ role: 'assistant', content: 'No canonical identity' }]), null);
});

test('missing, malformed, foreign and unsupported judgments never become successful observations', () => {
  const target = replyTarget('c', turns());
  const valid = critique(target, 'met');
  valid.observations.emotionBeforeAnalysis.quote = 'Ça semble pesant.';
  assert.equal(note(turns(), valid).modelReview.observations.emotionBeforeAnalysis.quoteMatched, true);
  const variants = [
    null, {}, { ...valid, replyId: 'other' }, { ...valid, replyHash: 'wrong' },
    { ...valid, observations: { ...valid.observations, stance: { status: 'certain', reason: 'x' } } },
    { ...valid, observations: { ...valid.observations, length: { status: 'met' } } },
    { ...valid, observations: { ...valid.observations, oneQuestion: { status: 'met', reason: 'x', quote: 'Invented quote' } } }
  ];
  for (const raw of variants) {
    const result = note(turns(), raw);
    assert.equal(result.modelReview.status, raw === null ? 'missing' : 'invalid');
    assert.equal(result.modelReview.observations, null);
    const counts = summarizeNotes([result]);
    assert.equal(counts.modelObservations.criteria.stance.met, 0);
    assert.equal(counts.measurements.belowUsualWordRange, 1);
  }
});

test('retained-window counters keep model uncertainty, non-applicability and code evidence separate', () => {
  const notes = ['met', 'missed', 'uncertain', 'not_applicable'].map((status, i) => note(turns('r' + i, 2 + i * 2), critique(replyTarget('c', turns('r' + i, 2 + i * 2)), status)));
  notes.push(note(turns('missing', 12), null), note(turns('invalid', 14), {}));
  const counts = summarizeNotes(notes);
  assert.equal(counts.scope, 'retained_supervision_notes');
  assert.equal(counts.limit, NOTE_LIMIT);
  assert.equal(counts.replies, 6);
  assert.deepEqual(counts.modelObservations.reviews, { available: 4, missing: 1, invalid: 1, discarded: 0 });
  assert.deepEqual(counts.modelObservations.criteria.length, { met: 1, missed: 1, uncertain: 1, not_applicable: 1 });
  assert.equal(counts.measurements.belowUsualWordRange, 6);
  assert.equal(counts.modelObservations.independent, false);
  assert.equal(summarizeNotes([...notes, notes[0]]).replies, 6);
});

test('only the exact preceding reply can supply supervision, within the local context budget', () => {
  const messages = turns();
  const result = note(messages);
  const state = { ...emptyState(), supervisionNotes: [result],
    profile: { about: 'a'.repeat(3000), expectations: 'e'.repeat(1500) },
    notes: Array.from({ length: 100 }, () => ({ text: 'n'.repeat(1000) })) };
  assert.equal(nextReplyNote(state, 'c', messages), result);
  assert.equal(nextReplyNote(state, 'other', messages), null);
  assert.equal(nextReplyNote(state, 'c', turns('next', 4)), null);
  assert.equal(nextReplyNote(state, 'c', turns('r1', 2, 'Edited reply')), null);
  const system = composeSystemContext(state, normalizeControl({ mode: 'talk' }), { conversationId: 'c', supervision: result });
  assert.match(system, /PSYX REPLY SUPERVISION/);
  assert.match(system, /not independent evidence, clinical truth/);
  assert.ok(system.length < 16000, system.length);
  for (const bad of [note(messages, null), note(messages, {})]) {
    assert.doesNotMatch(composeSystemContext(state, normalizeControl({}), { supervision: bad }), /PSYX REPLY SUPERVISION/);
  }
});

test('review transport supplies exact target, applied stance and actual whole-message coverage', () => {
  const messages = turns();
  const target = replyTarget('c', messages);
  const request = reviewMessages({ state: emptyState(), turns: messages, target,
    coverage: { availableMessages: 5, includedMessages: 2, omittedMessages: 3, complete: false } });
  const context = JSON.parse(request[1].content.split('\n')[1]);
  assert.deepEqual(context.supervisionTarget, target);
  assert.equal(context.supervisionTarget.mode, 'talk');
  assert.equal(context.conversationCoverage.complete, false);
  assert.match(request[1].content, /Ça semble pesant\. Que ressens-tu\?/);
});

test('one existing routed review stores the note; restart and duplicate schedule reuse it without inference', async () => {
  const h = harness();
  let reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await settled(reviewer);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].taskType, 'deep_reasoning');
  assert.equal(h.recorded[0].supervision.replyId, 'r1');
  assert.equal(h.recorded[0].supervision.modelReview.model, 'synthetic-reviewer');
  assert.equal(h.recorded[0].proposals.length, 1, 'the existing pending-proposal path is retained');
  reviewer.forgetUser('u');
  reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  await settled(reviewer);
  assert.equal(h.calls.length, 1);
  assert.equal((await h.stateRepository.read('u')).supervisionNotes.length, 1);
  reviewer.forgetUser('u');
});

test('every response during an admitted review retains its critique in canonical order', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(async (context, call) => {
    if (call === 1) await gate;
    return { content: JSON.stringify({ digest: { summary: 'Synthèse.' }, supervision: critique(context.supervisionTarget) }) };
  });
  const reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  while (!h.calls.length) await tick();
  h.setMessages([...turns(), ...turns('r2', 4)]);
  reviewer.schedule('u', 'c');
  h.setMessages([...turns(), ...turns('r2', 4), ...turns('r3', 6)]);
  reviewer.schedule('u', 'c');
  release();
  await settled(reviewer);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.recorded.map(item => item.supervision.replyId), ['r1', 'r2', 'r3']);
  reviewer.forgetUser('u');
});

test('a canonical change without a scheduler event also fences a delayed result', async () => {
  let release;
  const h = harness(async context => {
    await new Promise(resolve => { release = resolve; });
    return { content: JSON.stringify({ supervision: critique(context.supervisionTarget) }) };
  });
  const reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  while (!release) await tick();
  h.setMessages(turns('r1', 2, 'Changed complete text'));
  release();
  await settled(reviewer);
  assert.equal(h.recorded.length, 0);
  reviewer.forgetUser('u');
});

test('unusable or missing supervision is retained explicitly without inventing model findings', async () => {
  for (const content of ['not json', JSON.stringify({ digest: { summary: 'Digest only.' } }), JSON.stringify({ supervision: { replyId: 'foreign' } })]) {
    const h = harness(async () => ({ content }));
    const reviewer = createReviewer(h.options);
    reviewer.schedule('u', 'c');
    const status = await settled(reviewer);
    assert.equal(h.recorded.length, 1);
    assert.equal(h.recorded[0].supervision.modelReview.status, content.includes('Digest only') ? 'missing' : 'invalid');
    assert.equal(status.status, content === 'not json' ? 'failed' : 'done');
    reviewer.forgetUser('u');
  }
});

test('long complete replies reach the same reviewer whole rather than receiving a critique of a prefix', async () => {
  const h = harness();
  h.setMessages(turns('large', 2, 'x'.repeat(24001)));
  const reviewer = createReviewer(h.options);
  reviewer.schedule('u', 'c');
  const status = await settled(reviewer);
  assert.equal(status.status, 'done');
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].messages[1].content.includes('x'.repeat(24001)));
  assert.equal(h.recorded.length, 1);
  reviewer.forgetUser('u');
});

test('unknown applied mode remains uncertain rather than guessing successful stance or length', () => {
  const messages = turns();
  delete messages[1].control;
  const target = replyTarget('c', messages);
  assert.equal(target.mode, null);
  assert.equal(target.voice, null);
  const unknown = note(messages);
  assert.equal(unknown.modelReview.status, 'available');
  assert.equal(unknown.measurements.usualWordRange, null);
  assert.equal(summarizeNotes([unknown]).measurements.unknownWordRange, 1);
  assert.equal(note(messages, critique(target, 'met')).modelReview.status, 'invalid');
  assert.equal(supervisionNote(critique(target), { target, reply: 'A different reply' }), null);
});

test('existing background-review and history preferences each exclude supervision from HTTP reply context', async () => {
  const { createApp } = require('../src/app');
  const { defaultsFor } = require('../../../src/services/conversationPreferences/catalog');
  const h = harness();
  const noteForConversation = note();
  const id = '507f1f77bcf86cd799439011';
  noteForConversation.conversationId = id;
  await h.stateRepository.recordReview('default', { conversationId: id, supervision: noteForConversation });
  const defaults = defaultsFor('psyx', {});
  let values = defaults;
  const submitted = [];
  h.options.conversationRepository.saveCompletedTurn = async () => ({ id });
  const server = createApp({
    config: { env: 'test', accessMode: 'token', accessToken: 'synthetic-supervision', maxBodyBytes: 262144,
      voice: { mode: 'disabled' } },
    database: { stateRepository: h.options.stateRepository, conversationRepository: h.options.conversationRepository,
      preferencesForUser: () => ({ read: async () => ({ revision: 1, values }) }) },
    provider: { async stream(request, sink) { submitted.push(request); sink.onToken('Suite.'); return { content: 'Suite.' }; } },
    reviewer: { schedule: () => false }, dreamer: { touch() {} }, logger: {}
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const overrides of [{}, { backgroundReview: false }, { historyContext: false }]) {
      values = { ...defaults, ...overrides };
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/psyx/chat/stream', {
        method: 'POST', headers: { Authorization: 'Bearer synthetic-supervision', 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: id, message: 'Suite synthétique.' })
      });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(submitted.at(-1).system.includes('PSYX REPLY SUPERVISION'), Object.keys(overrides).length === 0);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
