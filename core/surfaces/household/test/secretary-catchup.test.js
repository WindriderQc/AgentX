'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { catchupProjection, proposalIdea } = require('../secretary-catchup');
const household = require('../briefing');

test('a catch-up proposal becomes one bounded idea text with an idempotent source key', () => {
  const idea = proposalIdea({ kind: 'memory', text: '  Synthetic\n fact  ', key: 'c'.repeat(32), due: '', gmailUrl: 'https://mail.google.com/mail/u/0/#all/abc' });
  assert.deepEqual(idea, { text: 'À retenir : Synthetic fact — https://mail.google.com/mail/u/0/#all/abc', origin: 'secretary',
    kind: 'idea', tags: ['secretary-catchup', 'memoire'], sourceKey: `catchup-${'c'.repeat(32)}` });
  assert.equal(proposalIdea({ kind: 'action', text: 'Synthetic', key: 'd'.repeat(32), due: 'vendredi', gmailUrl: 'http://evil.invalid' }).text,
    'Action : Synthetic (échéance : vendredi)');
  assert.throws(() => proposalIdea({ kind: 'action', text: ' ', key: 'd'.repeat(32) }), error => error.code === 'CATCHUP_PROPOSAL_TEXT_REQUIRED');
  assert.throws(() => proposalIdea({ kind: 'action', text: 'x', key: 'D'.repeat(32) }), error => error.code === 'CATCHUP_PROPOSAL_BAD_KEY');
});

test('general receipts and versioned objective review keep separate content-free coverage', () => {
  const result = catchupProjection({ known: true, running: false, phase: 'done', reviewed: 2,
    archiveProgress: { at: '2026-01-01T00:00:00Z', reviewedPages: 100, pendingTextPages: 0, pending: false,
      discoveringScopes: ['mailbox', 'private'], prompt: 'private' },
    objectiveReviews: [{ objectiveId: 'life', version: 'v1', phase: 'partial', userConfirmed: true,
      counts: { targetSources: 20, reviewedPages: 2, sourcesPendingMaterialization: 18, private: 1 }, ownerAliases: ['private'] }]
  });
  assert.equal(result.reviewed, 2);
  assert.equal(result.archiveProgress.reviewedPages, 100);
  assert.deepEqual(result.archiveProgress.discoveringScopes, ['mailbox']);
  assert.deepEqual(result.objectiveReviews[0].counts, { targetSources: 20, sourcesPendingMaterialization: 18, reviewedPages: 2 });
  assert.equal(result.objectiveReviews[0].userConfirmed, false);
  assert.equal(result.objectiveReviews[0].semanticAcceptance, 'not-established');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('rejected objective pages remain separate counts and never establish text coverage', () => {
  const result = catchupProjection({ known: true, objectiveReviews: [{ objectiveId: 'life', version: 'v1',
    allTargetTextCovered: false, counts: { reviewedPages: 2, rejectedPages: 3, sourcesWithRejectedPages: 2,
      pendingPagesKnown: 0, privateResultBody: 'not exposed' } }] });
  assert.deepEqual(result.objectiveReviews[0].counts,
    { reviewedPages: 2, pendingPagesKnown: 0, rejectedPages: 3, sourcesWithRejectedPages: 2 });
  assert.equal(result.objectiveReviews[0].allTargetTextCovered, false);
  assert.equal(result.objectiveReviews[0].semanticAcceptance, 'not-established');
  assert.doesNotMatch(JSON.stringify(result), /not exposed|privateResultBody/);
});

test("Dad's desk shows the archive catch-up from counts only", () => {
  const running = { known: true, running: true, phase: 'reviewing', reviewed: 343, failed: 0, remaining: 16260, pending: 16603,
    pagesPerHour: 484.1, etaHours: 33.6, lane: 'invoice-files', paused: null, proposalsQueued: 2, proposalsPending: 0, summary: 'ignored' };
  assert.deepEqual(catchupProjection(running), { status: 'running', paused: null, lane: 'invoice-files', pending: 16603, reviewed: 343,
    failed: 0, remaining: 16260, pagesPerHour: 484.1, etaHours: 33.6, proposalsQueued: 2, proposalsPending: 0, updatedAt: null, finishedAt: null });
  assert.equal(catchupProjection({ ...running, paused: { reason: 'benchmark running' } }).status, 'paused');
  assert.equal(catchupProjection({ ...running, running: false, phase: 'done' }).status, 'done');
  assert.equal(catchupProjection({ ...running, running: false, phase: 'reviewing' }).status, 'idle');
  assert.equal(catchupProjection({ known: false }), null);
  assert.equal(catchupProjection(null), null);
  assert.deepEqual(catchupProjection({ error: 'The archive catch-up status is still being read.' }),
    { status: 'unavailable', error: 'The archive catch-up status is still being read.' });

  const desk = household.dadDesk({ data: { alerts: {}, memoryReview: { pending: 0 } } }, [], { data: [] }, new Date(), {}, {}, {}, {}, running);
  assert.equal(desk.mail.catchup.status, 'running');
  assert.match(desk.mail.authority, /secretary agent owns Gmail/);
  assert.equal(household.dadDesk({ data: { alerts: {}, memoryReview: { pending: 0 } } }, [], { data: [] }).mail.catchup, null);
});
