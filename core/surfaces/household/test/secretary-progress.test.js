'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('../../../src/services/secretaryProgressService');
const { catchupProjection } = require('../secretary-catchup');
const id = 'a'.repeat(36), dispatchId = 'b'.repeat(36);
const body = { known: true, objectiveReviews: [{ phase: 'uncertain', counts: { reviewedPages: 3 },
  controller: { phase: 'uncertain', at: '2026-01-01T00:00:00Z', queueId: id, dispatchId, fresh: false } }] };

test('an exact released queue failure replaces an old objective phase without completing the objective', async () => {
  const readQueue = async () => ({ id, dispatchId, state: 'failed', finishedAt: '2026-01-01T01:00:00Z', releaseReceipt: { authority: 'native' } });
  const reconciled = await reconcile(body, { readQueue });
  assert.equal(reconciled.objectiveReviews[0].phase, 'failed');
  assert.equal(reconciled.objectiveReviews[0].controller.released, true);
  const display = catchupProjection(reconciled);
  assert.equal(display.objectiveReviews[0].controller.queueState, 'failed');
  assert.equal(display.objectiveReviews[0].allTargetTextCovered, false);
  assert.equal(display.objectiveReviews[0].userConfirmed, false);
  assert.equal(JSON.stringify(display).includes(id), false);
});

test('a completed chunk leaves the larger objective paused and identity mismatches or missing release never grant completion', async () => {
  const job = { id, dispatchId, state: 'completed', releaseReceipt: { authority: 'native' } };
  assert.equal((await reconcile(body, { readQueue: async () => job })).objectiveReviews[0].phase, 'paused');
  for (const change of [{ releaseReceipt: null }, { dispatchId: 'c'.repeat(36) }, { id: 'd'.repeat(36) }]) {
    assert.equal((await reconcile(body, { readQueue: async () => ({ ...job, ...change }) })).objectiveReviews[0].phase, 'uncertain');
  }
});
