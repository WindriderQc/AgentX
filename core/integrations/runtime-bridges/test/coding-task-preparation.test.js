'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodingTaskPreparation } = require('../coding-task-preparation');

function fixture(overrides = {}) {
  const task = { pipelineId: '0700', title: 'Show the team question', service: 'agentx-coding', status: 'queued', updatedAt: '2026-09-12T10:00:00Z', ...overrides };
  const writes = [];
  const preparation = new CodingTaskPreparation({ pipeline: { read: async () => ({ task }), apply: async value => { writes.push(value); } } });
  return { preparation, writes };
}
test('a queued task is ready for the worker without a plan or a declared scope', async () => {
  const f = fixture();
  assert.deepEqual(await f.preparation.prepare({ pipelineId: '0700' }), { ready: true });
  assert.equal(f.writes.length, 0);
});
test('the operator answer is recorded and a blocked task returns to the queue', async () => {
  const f = fixture({ status: 'blocked' });
  assert.deepEqual(await f.preparation.prepare({ pipelineId: '0700', answer: 'Use compact layout.' }), { ready: true });
  assert.deepEqual(f.writes, [{ pipelineId: '0700', expectedUpdatedAt: '2026-09-12T10:00:00.000Z', answer: 'Use compact layout.', handoff: true }]);
});
test('an ordinary UI ticket without a coding route records the explicit handoff before declaring ready', async () => {
  for (const service of ['', 'core']) {
    const f = fixture({ service });
    assert.deepEqual(await f.preparation.prepare({ pipelineId: '0700' }), { ready: true });
    assert.deepEqual(f.writes, [{ pipelineId: '0700', expectedUpdatedAt: '2026-09-12T10:00:00.000Z', answer: '', handoff: true }]);
  }
});
test('private source lanes, personal services and an existing owner are refused without a write', async () => {
  for (const changes of [{ service: ' Family ' }, { source: 'household-reminder' }, { source: 'idea-drop' },
    { assignee: 'another-worker' }, { automationLease: { leaseId: 'held' } }]) {
    const f = fixture(changes);
    await assert.rejects(f.preparation.prepare({ pipelineId: '0700' }));
    assert.equal(f.writes.length, 0);
  }
});
test('a running or reviewed task and an inexact id are refused', async () => {
  await assert.rejects(fixture({ status: 'review' }).preparation.prepare({ pipelineId: '0700' }), /already running or awaiting review/);
  await assert.rejects(fixture().preparation.prepare({ pipelineId: '70' }), /exact task/);
});
test('managed corrections and invalid report selections refuse before changing the task', async () => {
  for (const changes of [{ codingAutonomy: { state: 'active' } }, { automation: { mode: 'review_only' } },
    { automationAttemptCount: 1 }, { automationAttempts: [{}] }]) {
    const f = fixture({ status: 'blocked', ...changes });
    await assert.rejects(f.preparation.prepare({ pipelineId: '0700', answer: 'Resume' }), /existing Coding Team correction loop/);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture({ status: 'blocked' });
  await assert.rejects(f.preparation.prepare({ pipelineId: '0700', answer: 'Resume', reportName: '../private.md' }));
  assert.equal(f.writes.length, 0);
});
